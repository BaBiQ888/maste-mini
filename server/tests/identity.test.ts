import { describe, it, expect, beforeEach } from "vitest";
import { createApp } from "../src/presentation/http/app.js";
import { openDatabase } from "../src/infrastructure/persistence/db.js";

async function testApp() {
  const db = await openDatabase(":memory:");
  const app = createApp(db, { appId: "", appSecret: "", mock: true });
  return app;
}

async function login(app: ReturnType<typeof testApp>, code: string) {
  const res = await app.request("/api/v1/auth/wechat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, nickname: "测试用户" }),
  });
  return { res, json: await res.json() };
}

describe("Identity", () => {
  let app: ReturnType<typeof testApp>;

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

  it("creates different users for different codes", async () => {
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

  it("sets role once and locks it", async () => {
    const { json } = await login(app, "code-role");
    const set = await app.request("/api/v1/me", {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${json.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ role: "teacher", nickname: "王老师" }),
    });
    expect(set.status).toBe(200);
    const u = (await set.json()).user;
    expect(u.role).toBe("teacher");
    expect(u.nickname).toBe("王老师");

    const again = await app.request("/api/v1/me", {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${json.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ role: "student" }),
    });
    expect(again.status).toBe(400);
    const err = await again.json();
    expect(err.code).toBe("ROLE_LOCKED");
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
