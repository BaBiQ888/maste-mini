import { describe, it, expect, beforeEach } from "vitest";
import { createApp } from "../src/presentation/http/app.js";
import { openDatabase } from "../src/infrastructure/persistence/db.js";

async function testApp() {
  const db = await openDatabase(":memory:");
  return createApp(db, { appId: "", appSecret: "", mock: true });
}

async function loginAs(
  app: ReturnType<typeof testApp>,
  code: string,
  role: "teacher" | "student",
  nickname: string,
) {
  const loginRes = await app.request("/api/v1/auth/wechat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, nickname }),
  });
  const login = await loginRes.json();
  await app.request("/api/v1/me", {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${login.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ role, nickname }),
  });
  return { token: login.token as string, userId: login.user.id as string };
}

function auth(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

describe("ClassRoom ops (Phase 3)", () => {
  let app: ReturnType<typeof testApp>;

  beforeEach(async () => {
    app = await testApp();
  });

  it("refresh invite code invalidates the old code", async () => {
    const teacher = await loginAs(app, "t-ref", "teacher", "王老师");
    const student = await loginAs(app, "s-ref", "student", "小明");

    const created = await (
      await app.request("/api/v1/classes", {
        method: "POST",
        headers: auth(teacher.token),
        body: JSON.stringify({ name: "刷新班", grade: 4 }),
      })
    ).json();
    const oldCode = created.class.inviteCode as string;

    const refreshed = await (
      await app.request(
        `/api/v1/classes/${created.class.id}/invite/refresh`,
        { method: "POST", headers: auth(teacher.token) },
      )
    ).json();
    const newCode = refreshed.class.inviteCode as string;
    expect(newCode).toMatch(/^[A-Z2-9]{6}$/);
    expect(newCode).not.toBe(oldCode);

    const bad = await app.request("/api/v1/classes/join", {
      method: "POST",
      headers: auth(student.token),
      body: JSON.stringify({ inviteCode: oldCode }),
    });
    expect(bad.status).toBe(400);

    const ok = await app.request("/api/v1/classes/join", {
      method: "POST",
      headers: auth(student.token),
      body: JSON.stringify({ inviteCode: newCode }),
    });
    expect(ok.status).toBe(200);
  });

  it("remove student; they no longer see the class", async () => {
    const teacher = await loginAs(app, "t-rm", "teacher", "李老师");
    const student = await loginAs(app, "s-rm", "student", "小红");

    const created = await (
      await app.request("/api/v1/classes", {
        method: "POST",
        headers: auth(teacher.token),
        body: JSON.stringify({ name: "移出班", grade: 3 }),
      })
    ).json();

    await app.request("/api/v1/classes/join", {
      method: "POST",
      headers: auth(student.token),
      body: JSON.stringify({ inviteCode: created.class.inviteCode }),
    });

    const rm = await app.request(
      `/api/v1/classes/${created.class.id}/members/${student.userId}`,
      { method: "DELETE", headers: auth(teacher.token) },
    );
    expect(rm.status).toBe(200);

    const list = await (
      await app.request("/api/v1/classes", { headers: auth(student.token) })
    ).json();
    expect(list.classes).toHaveLength(0);

    const view = await app.request(`/api/v1/classes/${created.class.id}`, {
      headers: auth(student.token),
    });
    expect(view.status).toBe(403);

    const members = await (
      await app.request(`/api/v1/classes/${created.class.id}/members`, {
        headers: auth(teacher.token),
      })
    ).json();
    expect(members.members.every((m: { role: string }) => m.role !== "student")).toBe(
      true,
    );
  });

  it("cannot remove the teacher", async () => {
    const teacher = await loginAs(app, "t-rm2", "teacher", "赵老师");
    const created = await (
      await app.request("/api/v1/classes", {
        method: "POST",
        headers: auth(teacher.token),
        body: JSON.stringify({ name: "不可移老师", grade: 5 }),
      })
    ).json();

    const res = await app.request(
      `/api/v1/classes/${created.class.id}/members/${teacher.userId}`,
      { method: "DELETE", headers: auth(teacher.token) },
    );
    expect(res.status).toBe(400);
  });

  it("archive hides from default list and blocks join", async () => {
    const teacher = await loginAs(app, "t-arc", "teacher", "孙老师");
    const student = await loginAs(app, "s-arc", "student", "小刚");

    const created = await (
      await app.request("/api/v1/classes", {
        method: "POST",
        headers: auth(teacher.token),
        body: JSON.stringify({ name: "归档班", grade: 6 }),
      })
    ).json();
    const code = created.class.inviteCode as string;

    const arch = await app.request(
      `/api/v1/classes/${created.class.id}/archive`,
      { method: "POST", headers: auth(teacher.token) },
    );
    expect(arch.status).toBe(200);
    expect((await arch.json()).class.archived).toBe(true);

    const active = await (
      await app.request("/api/v1/classes", { headers: auth(teacher.token) })
    ).json();
    expect(active.classes).toHaveLength(0);

    const withArchived = await (
      await app.request("/api/v1/classes?includeArchived=1", {
        headers: auth(teacher.token),
      })
    ).json();
    expect(withArchived.classes).toHaveLength(1);
    expect(withArchived.classes[0].archived).toBe(true);

    const join = await app.request("/api/v1/classes/join", {
      method: "POST",
      headers: auth(student.token),
      body: JSON.stringify({ inviteCode: code }),
    });
    expect(join.status).toBe(400);
    expect((await join.json()).code).toBe("CLASS_ARCHIVED");
  });

  it("unarchive restores class to default list", async () => {
    const teacher = await loginAs(app, "t-unar", "teacher", "周老师");
    const created = await (
      await app.request("/api/v1/classes", {
        method: "POST",
        headers: auth(teacher.token),
        body: JSON.stringify({ name: "恢复班", grade: 4 }),
      })
    ).json();

    await app.request(`/api/v1/classes/${created.class.id}/archive`, {
      method: "POST",
      headers: auth(teacher.token),
    });
    await app.request(`/api/v1/classes/${created.class.id}/unarchive`, {
      method: "POST",
      headers: auth(teacher.token),
    });

    const list = await (
      await app.request("/api/v1/classes", { headers: auth(teacher.token) })
    ).json();
    expect(list.classes).toHaveLength(1);
    expect(list.classes[0].archived).toBe(false);
  });

  it("student can join multiple classes", async () => {
    const teacher = await loginAs(app, "t-multi", "teacher", "吴老师");
    const student = await loginAs(app, "s-multi", "student", "小华");

    const a = await (
      await app.request("/api/v1/classes", {
        method: "POST",
        headers: auth(teacher.token),
        body: JSON.stringify({ name: "一班", grade: 3 }),
      })
    ).json();
    const b = await (
      await app.request("/api/v1/classes", {
        method: "POST",
        headers: auth(teacher.token),
        body: JSON.stringify({ name: "二班", grade: 4 }),
      })
    ).json();

    await app.request("/api/v1/classes/join", {
      method: "POST",
      headers: auth(student.token),
      body: JSON.stringify({ inviteCode: a.class.inviteCode }),
    });
    await app.request("/api/v1/classes/join", {
      method: "POST",
      headers: auth(student.token),
      body: JSON.stringify({ inviteCode: b.class.inviteCode }),
    });

    const list = await (
      await app.request("/api/v1/classes", { headers: auth(student.token) })
    ).json();
    expect(list.classes).toHaveLength(2);
  });
});
