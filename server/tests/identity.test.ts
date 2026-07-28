import { describe, it, expect, beforeEach } from "vitest";
import { createApp } from "../src/presentation/http/app.js";
import { openDatabase } from "../src/infrastructure/persistence/db.js";
import { DEFAULT_TEACHER_ACCESS_CODE } from "../src/application/identity/service.js";

async function testApp(teacherAccessCode = DEFAULT_TEACHER_ACCESS_CODE) {
  const db = await openDatabase(":memory:");
  const app = createApp(db, {
    wechat: { appId: "", appSecret: "", mock: true },
    dataDir: "/tmp",
    teacherAccessCode,
  });
  return app;
}

async function login(
  app: Awaited<ReturnType<typeof testApp>>,
  code: string,
  extra: { deviceId?: string; nickname?: string } = {},
) {
  const res = await app.request("/api/v1/auth/wechat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code,
      nickname: extra.nickname ?? "测试用户",
      deviceId: extra.deviceId,
    }),
  });
  return { res, json: await res.json() };
}

describe("Identity", () => {
  let app: Awaited<ReturnType<typeof testApp>>;

  beforeEach(async () => {
    app = await testApp();
  });

  it("creates a stable account for the same wechat code (openid)", async () => {
    const a = await login(app, "code-alice");
    expect(a.res.status).toBe(200);
    expect(a.json.token).toMatch(/^tok_/);
    expect(a.json.isNewUser).toBe(true);
    expect(a.json.user.role).toBeNull();

    const b = await login(app, "code-alice");
    expect(b.json.isNewUser).toBe(false);
    expect(b.json.user.id).toBe(a.json.user.id);
  });

  it("logs in via gateway X-WX-OPENID without jscode2session (cloud hosting path)", async () => {
    const res = await app.request("/api/v1/auth/wechat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-wx-openid": "oREAL_OPENID_from_gateway",
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const a = await res.json();
    expect(a.isNewUser).toBe(true);
    expect(a.token).toMatch(/^tok_/);

    const again = await app.request("/api/v1/auth/wechat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-wx-openid": "oREAL_OPENID_from_gateway",
      },
      body: JSON.stringify({ code: "ignored-when-header-present" }),
    });
    const b = await again.json();
    expect(b.isNewUser).toBe(false);
    expect(b.user.id).toBe(a.user.id);
  });

  it("reuses account by deviceId even when wx code changes (logout → re-login)", async () => {
    const a = await login(app, "wx_code_once_1", { deviceId: "phone-A" });
    expect(a.json.isNewUser).toBe(true);
    const userId = a.json.user.id as string;

    // Become teacher
    const set = await app.request("/api/v1/me", {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${a.json.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        role: "teacher",
        nickname: "王老师",
        teacherCode: DEFAULT_TEACHER_ACCESS_CODE,
      }),
    });
    expect(set.status).toBe(200);

    // Simulate logout (new session with different code, same device; no nickname override)
    const bRes = await app.request("/api/v1/auth/wechat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: "wx_code_once_2_different",
        deviceId: "phone-A",
      }),
    });
    const b = await bRes.json();
    expect(b.isNewUser).toBe(false);
    expect(b.user.id).toBe(userId);
    expect(b.user.role).toBe("teacher");
    expect(b.user.nickname).toBe("王老师");
  });

  it("creates different users for different codes without deviceId", async () => {
    const a = await login(app, "code-1");
    const b = await login(app, "code-2");
    expect(a.json.user.id).not.toBe(b.json.user.id);
  });

  it("rejects unauthenticated /me", async () => {
    const res = await app.request("/api/v1/me");
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.code).toBe("UNAUTHORIZED");
  });

  it("returns me with bearer token", async () => {
    const { json } = await login(app, "code-me");
    const res = await app.request("/api/v1/me", {
      headers: { Authorization: `Bearer ${json.token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user.id).toBe(json.user.id);
  });

  it("requires teacher access code when first selecting teacher", async () => {
    const { json } = await login(app, "code-gate");

    const missing = await app.request("/api/v1/me", {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${json.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ role: "teacher", nickname: "王老师" }),
    });
    expect(missing.status).toBe(400);
    expect((await missing.json()).code).toBe("TEACHER_CODE_REQUIRED");

    const wrong = await app.request("/api/v1/me", {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${json.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        role: "teacher",
        nickname: "王老师",
        teacherCode: "WRONG",
      }),
    });
    expect(wrong.status).toBe(400);
    expect((await wrong.json()).code).toBe("TEACHER_CODE_INVALID");

    const ok = await app.request("/api/v1/me", {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${json.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        role: "teacher",
        nickname: "王老师",
        teacherCode: DEFAULT_TEACHER_ACCESS_CODE,
      }),
    });
    expect(ok.status).toBe(200);
    expect((await ok.json()).user.role).toBe("teacher");
  });

  it("allows student role without teacher code", async () => {
    const { json } = await login(app, "code-stu");
    const set = await app.request("/api/v1/me", {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${json.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ role: "student", nickname: "小明" }),
    });
    expect(set.status).toBe(200);
    expect((await set.json()).user.role).toBe("student");
  });

  it("allows switching role; teacher always needs access code", async () => {
    const { json } = await login(app, "code-role");
    const set = await app.request("/api/v1/me", {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${json.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        role: "teacher",
        nickname: "王老师",
        teacherCode: DEFAULT_TEACHER_ACCESS_CODE,
      }),
    });
    expect(set.status).toBe(200);
    const u = (await set.json()).user;
    expect(u.role).toBe("teacher");
    expect(u.nickname).toBe("王老师");

    // teacher → student
    const asStudent = await app.request("/api/v1/me", {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${json.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ role: "student" }),
    });
    expect(asStudent.status).toBe(200);
    expect((await asStudent.json()).user.role).toBe("student");

    // student → teacher without code fails
    const noCode = await app.request("/api/v1/me", {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${json.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ role: "teacher" }),
    });
    expect(noCode.status).toBe(400);
    expect((await noCode.json()).code).toBe("TEACHER_CODE_REQUIRED");

    // student → teacher with code ok
    const back = await app.request("/api/v1/me", {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${json.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        role: "teacher",
        teacherCode: DEFAULT_TEACHER_ACCESS_CODE,
      }),
    });
    expect(back.status).toBe(200);
    expect((await back.json()).user.role).toBe("teacher");
  });

  it("updates nickname and avatar", async () => {
    const { json } = await login(app, "code-prof");
    await app.request("/api/v1/me", {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${json.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ role: "student" }),
    });
    const res = await app.request("/api/v1/me", {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${json.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        nickname: "小明",
        avatarUrl: "https://example.com/a.png",
      }),
    });
    expect(res.status).toBe(200);
    const u = (await res.json()).user;
    expect(u.nickname).toBe("小明");
    expect(u.avatarUrl).toBe("https://example.com/a.png");
  });
});
