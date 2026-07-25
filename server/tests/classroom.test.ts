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
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

describe("ClassRoom", () => {
  let app: ReturnType<typeof testApp>;

  beforeEach(async () => {
    app = await testApp();
  });

  it("teacher creates class with invite code", async () => {
    const teacher = await loginAs(app, "t1", "teacher", "王老师");
    const res = await app.request("/api/v1/classes", {
      method: "POST",
      headers: auth(teacher.token),
      body: JSON.stringify({ name: "四年级提高班", grade: 4 }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.class.name).toBe("四年级提高班");
    expect(body.class.grade).toBe(4);
    expect(body.class.inviteCode).toMatch(/^[A-Z2-9]{6}$/);
    expect(body.class.studentCount).toBe(0);
    expect(body.class.memberCount).toBe(1);
  });

  it("student joins with valid code; invalid code fails", async () => {
    const teacher = await loginAs(app, "t2", "teacher", "李老师");
    const student = await loginAs(app, "s2", "student", "小明");

    const created = await (
      await app.request("/api/v1/classes", {
        method: "POST",
        headers: auth(teacher.token),
        body: JSON.stringify({ name: "三年级基础", grade: 3 }),
      })
    ).json();

    const bad = await app.request("/api/v1/classes/join", {
      method: "POST",
      headers: auth(student.token),
      body: JSON.stringify({ inviteCode: "ZZZZZZ" }),
    });
    expect(bad.status).toBe(400);
    expect((await bad.json()).code).toBe("INVALID_CODE");

    const ok = await app.request("/api/v1/classes/join", {
      method: "POST",
      headers: auth(student.token),
      body: JSON.stringify({ inviteCode: created.class.inviteCode.toLowerCase() }),
    });
    expect(ok.status).toBe(200);
    const joined = await ok.json();
    expect(joined.class.id).toBe(created.class.id);
    expect(joined.class.studentCount).toBe(1);
  });

  it("teacher sees members; other teacher cannot view class", async () => {
    const teacher = await loginAs(app, "t3", "teacher", "赵老师");
    const other = await loginAs(app, "t3b", "teacher", "钱老师");
    const student = await loginAs(app, "s3", "student", "小红");

    const created = await (
      await app.request("/api/v1/classes", {
        method: "POST",
        headers: auth(teacher.token),
        body: JSON.stringify({ name: "五班", grade: 5 }),
      })
    ).json();

    await app.request("/api/v1/classes/join", {
      method: "POST",
      headers: auth(student.token),
      body: JSON.stringify({ inviteCode: created.class.inviteCode }),
    });

    const membersRes = await app.request(
      `/api/v1/classes/${created.class.id}/members`,
      { headers: auth(teacher.token) },
    );
    expect(membersRes.status).toBe(200);
    const { members } = await membersRes.json();
    expect(members).toHaveLength(2);
    expect(members.some((m: { role: string }) => m.role === "student")).toBe(
      true,
    );

    const forbidden = await app.request(
      `/api/v1/classes/${created.class.id}`,
      { headers: auth(other.token) },
    );
    expect(forbidden.status).toBe(403);
  });

  it("teacher lists multiple classes; student only sees joined", async () => {
    const teacher = await loginAs(app, "t4", "teacher", "孙老师");
    const student = await loginAs(app, "s4", "student", "小刚");

    const a = await (
      await app.request("/api/v1/classes", {
        method: "POST",
        headers: auth(teacher.token),
        body: JSON.stringify({ name: "A班", grade: 3 }),
      })
    ).json();
    await app.request("/api/v1/classes", {
      method: "POST",
      headers: auth(teacher.token),
      body: JSON.stringify({ name: "B班", grade: 4 }),
    });

    await app.request("/api/v1/classes/join", {
      method: "POST",
      headers: auth(student.token),
      body: JSON.stringify({ inviteCode: a.class.inviteCode }),
    });

    const teacherList = await (
      await app.request("/api/v1/classes", { headers: auth(teacher.token) })
    ).json();
    expect(teacherList.classes).toHaveLength(2);

    const studentList = await (
      await app.request("/api/v1/classes", { headers: auth(student.token) })
    ).json();
    expect(studentList.classes).toHaveLength(1);
    expect(studentList.classes[0].name).toBe("A班");
  });

  it("student cannot create class; teacher cannot join as student", async () => {
    const teacher = await loginAs(app, "t5", "teacher", "周老师");
    const student = await loginAs(app, "s5", "student", "小华");

    const denyCreate = await app.request("/api/v1/classes", {
      method: "POST",
      headers: auth(student.token),
      body: JSON.stringify({ name: "偷建", grade: 3 }),
    });
    expect(denyCreate.status).toBe(403);

    const created = await (
      await app.request("/api/v1/classes", {
        method: "POST",
        headers: auth(teacher.token),
        body: JSON.stringify({ name: "正规班", grade: 6 }),
      })
    ).json();

    const denyJoin = await app.request("/api/v1/classes/join", {
      method: "POST",
      headers: auth(teacher.token),
      body: JSON.stringify({ inviteCode: created.class.inviteCode }),
    });
    expect(denyJoin.status).toBe(403);
  });
});
