import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/presentation/http/app.js";
import { openDatabase } from "../src/infrastructure/persistence/db.js";

// 1x1 jpeg
const TINY_JPEG_B64 =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAGcP//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAQUCf//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQMBAT8Bf//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQIBAT8Bf//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEABj8Cf//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAT8hf//Z";

async function testApp() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "math-mini-"));
  const db = await openDatabase(":memory:");
  const app = createApp(db, {
    wechat: { appId: "", appSecret: "", mock: true },
    dataDir,
  });
  return { app, dataDir };
}

async function loginAs(
  app: ReturnType<typeof testApp>["app"],
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
    body: JSON.stringify({
      role,
      nickname,
      ...(role === "teacher" ? { teacherCode: "SUANBEN-TEACHER" } : {}),
    }),
  });
  return { token: login.token as string, userId: login.user.id as string };
}

function auth(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

describe("Photo homework", () => {
  let app: ReturnType<typeof testApp>["app"];

  beforeEach(async () => {
    app = (await testApp()).app;
  });

  async function setupClassAndPublish(publish = true) {
    const teacher = await loginAs(app, "pt", "teacher", "王老师");
    const student = await loginAs(app, "ps", "student", "小明");
    const cls = await (
      await app.request("/api/v1/classes", {
        method: "POST",
        headers: auth(teacher.token),
        body: JSON.stringify({ name: "拍照班", grade: 4 }),
      })
    ).json();
    await app.request("/api/v1/classes/join", {
      method: "POST",
      headers: auth(student.token),
      body: JSON.stringify({ inviteCode: cls.class.inviteCode }),
    });
    const asg = await (
      await app.request("/api/v1/assignments", {
        method: "POST",
        headers: auth(teacher.token),
        body: JSON.stringify({
          classId: cls.class.id,
          type: "photo_homework",
          title: "练习册 P12",
          description: "完成竖式并拍照",
          publish,
        }),
      })
    ).json();
    return { teacher, student, cls, asg: asg.assignment };
  }

  it("draft is invisible to student; publish shows it", async () => {
    const { teacher, student, asg } = await setupClassAndPublish(false);
    expect(asg.status).toBe("draft");

    const studentList = await (
      await app.request("/api/v1/assignments", {
        headers: auth(student.token),
      })
    ).json();
    expect(studentList.assignments).toHaveLength(0);

    await app.request(`/api/v1/assignments/${asg.id}/publish`, {
      method: "POST",
      headers: auth(teacher.token),
    });

    const after = await (
      await app.request("/api/v1/assignments", {
        headers: auth(student.token),
      })
    ).json();
    expect(after.assignments).toHaveLength(1);
  });

  it("student submits photos then teacher grades completed", async () => {
    const { teacher, student, asg } = await setupClassAndPublish(true);

    const up = await (
      await app.request("/api/v1/uploads/photo", {
        method: "POST",
        headers: auth(student.token),
        body: JSON.stringify({ data: TINY_JPEG_B64, mime: "image/jpeg" }),
      })
    ).json();
    expect(up.url).toMatch(/^\/uploads\//);

    const mine = await (
      await app.request(`/api/v1/assignments/${asg.id}/my-submission`, {
        headers: auth(student.token),
      })
    ).json();
    expect(mine.submission.status).toBe("not_started");

    const submitted = await (
      await app.request(`/api/v1/submissions/${mine.submission.id}/photos`, {
        method: "POST",
        headers: auth(student.token),
        body: JSON.stringify({ photoUrls: [up.url] }),
      })
    ).json();
    expect(submitted.submission.status).toBe("submitted");
    expect(submitted.submission.photos).toHaveLength(1);

    const graded = await (
      await app.request(`/api/v1/submissions/${mine.submission.id}/grade`, {
        method: "POST",
        headers: auth(teacher.token),
        body: JSON.stringify({
          result: "correct",
          score: 95,
          comment: "工整",
        }),
      })
    ).json();
    expect(graded.submission.status).toBe("completed");
    expect(graded.submission.grade?.comment).toBe("工整");
    expect(graded.submission.score).toBe(95);
  });

  it("require resubmit then student can submit again", async () => {
    const { teacher, student, asg } = await setupClassAndPublish(true);

    const up1 = await (
      await app.request("/api/v1/uploads/photo", {
        method: "POST",
        headers: auth(student.token),
        body: JSON.stringify({ data: TINY_JPEG_B64, mime: "image/jpeg" }),
      })
    ).json();
    const mine = await (
      await app.request(`/api/v1/assignments/${asg.id}/my-submission`, {
        headers: auth(student.token),
      })
    ).json();
    await app.request(`/api/v1/submissions/${mine.submission.id}/photos`, {
      method: "POST",
      headers: auth(student.token),
      body: JSON.stringify({ photoUrls: [up1.url] }),
    });

    const need = await (
      await app.request(`/api/v1/submissions/${mine.submission.id}/grade`, {
        method: "POST",
        headers: auth(teacher.token),
        body: JSON.stringify({
          result: "incorrect",
          comment: "重做",
          requireResubmit: true,
        }),
      })
    ).json();
    expect(need.submission.status).toBe("resubmit_required");

    const up2 = await (
      await app.request("/api/v1/uploads/photo", {
        method: "POST",
        headers: auth(student.token),
        body: JSON.stringify({ data: TINY_JPEG_B64, mime: "image/jpeg" }),
      })
    ).json();
    const again = await (
      await app.request(`/api/v1/submissions/${mine.submission.id}/photos`, {
        method: "POST",
        headers: auth(student.token),
        body: JSON.stringify({ photoUrls: [up2.url] }),
      })
    ).json();
    expect(again.submission.status).toBe("submitted");

    const done = await (
      await app.request(`/api/v1/submissions/${mine.submission.id}/grade`, {
        method: "POST",
        headers: auth(teacher.token),
        body: JSON.stringify({ result: "partial", score: 70 }),
      })
    ).json();
    expect(done.submission.status).toBe("completed");
  });

  it("revoke hides from student; filter by class works", async () => {
    const { teacher, student, asg, cls } = await setupClassAndPublish(true);
    await app.request(`/api/v1/assignments/${asg.id}/revoke`, {
      method: "POST",
      headers: auth(teacher.token),
    });
    const studentList = await (
      await app.request("/api/v1/assignments", {
        headers: auth(student.token),
      })
    ).json();
    expect(studentList.assignments).toHaveLength(0);

    const teacherList = await (
      await app.request(`/api/v1/assignments?classId=${cls.class.id}`, {
        headers: auth(teacher.token),
      })
    ).json();
    expect(teacherList.assignments).toHaveLength(1);
    expect(teacherList.assignments[0].status).toBe("revoked");
  });

  it("rejects empty photos, freeze after submit, and completed resubmit", async () => {
    const { teacher, student, asg } = await setupClassAndPublish(true);
    const mine = await (
      await app.request(`/api/v1/assignments/${asg.id}/my-submission`, {
        headers: auth(student.token),
      })
    ).json();
    const empty = await app.request(
      `/api/v1/submissions/${mine.submission.id}/photos`,
      {
        method: "POST",
        headers: auth(student.token),
        body: JSON.stringify({ photoUrls: [] }),
      },
    );
    expect(empty.status).toBe(400);

    const up = await (
      await app.request("/api/v1/uploads/photo", {
        method: "POST",
        headers: auth(student.token),
        body: JSON.stringify({ data: TINY_JPEG_B64, mime: "image/jpeg" }),
      })
    ).json();
    await app.request(`/api/v1/submissions/${mine.submission.id}/photos`, {
      method: "POST",
      headers: auth(student.token),
      body: JSON.stringify({ photoUrls: [up.url] }),
    });

    // submitted is frozen — cannot replace until teacher requires resubmit
    const whilePending = await app.request(
      `/api/v1/submissions/${mine.submission.id}/photos`,
      {
        method: "POST",
        headers: auth(student.token),
        body: JSON.stringify({ photoUrls: [up.url] }),
      },
    );
    expect(whilePending.status).toBe(400);
    const pendingBody = await whilePending.json();
    expect(pendingBody.code).toBe("INVALID_STATUS");

    await app.request(`/api/v1/submissions/${mine.submission.id}/grade`, {
      method: "POST",
      headers: auth(teacher.token),
      body: JSON.stringify({ result: "correct" }),
    });
    const again = await app.request(
      `/api/v1/submissions/${mine.submission.id}/photos`,
      {
        method: "POST",
        headers: auth(student.token),
        body: JSON.stringify({ photoUrls: [up.url] }),
      },
    );
    expect(again.status).toBe(400);
  });

  it("serves uploaded photo only with session token", async () => {
    const { student } = await setupClassAndPublish(true);
    const up = await (
      await app.request("/api/v1/uploads/photo", {
        method: "POST",
        headers: auth(student.token),
        body: JSON.stringify({ data: TINY_JPEG_B64, mime: "image/jpeg" }),
      })
    ).json();
    expect(up.url).toMatch(/^\/uploads\//);

    const anon = await app.request(up.url);
    expect(anon.status).toBe(401);

    const withQuery = await app.request(
      `${up.url}?access_token=${encodeURIComponent(student.token)}`,
    );
    expect(withQuery.status).toBe(200);

    const withBearer = await app.request(up.url, {
      headers: { Authorization: `Bearer ${student.token}` },
    });
    expect(withBearer.status).toBe(200);
  });
});
