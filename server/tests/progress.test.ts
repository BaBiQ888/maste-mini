import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/presentation/http/app.js";
import { openDatabase } from "../src/infrastructure/persistence/db.js";

const TINY_JPEG_B64 =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAGcP//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAQUCf//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQMBAT8Bf//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQIBAT8Bf//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEABj8Cf//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAT8hf//Z";

async function testApp() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "math-mini-p5-"));
  const db = await openDatabase(":memory:");
  return createApp(db, {
    wechat: { appId: "", appSecret: "", mock: true },
    dataDir,
  });
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

describe("Progress & NudgeCopy", () => {
  let app: ReturnType<typeof testApp>;

  beforeEach(async () => {
    app = await testApp();
  });

  async function setupTwoStudentsOneDone() {
    const teacher = await loginAs(app, "p5t", "teacher", "王老师");
    const s1 = await loginAs(app, "p5s1", "student", "小明");
    const s2 = await loginAs(app, "p5s2", "student", "小红");

    const cls = await (
      await app.request("/api/v1/classes", {
        method: "POST",
        headers: auth(teacher.token),
        body: JSON.stringify({ name: "汇总班", grade: 4 }),
      })
    ).json();

    for (const s of [s1, s2]) {
      await app.request("/api/v1/classes/join", {
        method: "POST",
        headers: auth(s.token),
        body: JSON.stringify({ inviteCode: cls.class.inviteCode }),
      });
    }

    const asg = await (
      await app.request("/api/v1/assignments", {
        method: "POST",
        headers: auth(teacher.token),
        body: JSON.stringify({
          classId: cls.class.id,
          type: "photo_homework",
          title: "周末练习",
          publish: true,
        }),
      })
    ).json();

    // s1 completes
    const up = await (
      await app.request("/api/v1/uploads/photo", {
        method: "POST",
        headers: auth(s1.token),
        body: JSON.stringify({ data: TINY_JPEG_B64, mime: "image/jpeg" }),
      })
    ).json();
    const mine = await (
      await app.request(`/api/v1/assignments/${asg.assignment.id}/my-submission`, {
        headers: auth(s1.token),
      })
    ).json();
    await app.request(`/api/v1/submissions/${mine.submission.id}/photos`, {
      method: "POST",
      headers: auth(s1.token),
      body: JSON.stringify({ photoUrls: [up.url] }),
    });
    await app.request(`/api/v1/submissions/${mine.submission.id}/grade`, {
      method: "POST",
      headers: auth(teacher.token),
      body: JSON.stringify({ result: "correct", score: 100 }),
    });

    // s2 only submits (in progress)
    const up2 = await (
      await app.request("/api/v1/uploads/photo", {
        method: "POST",
        headers: auth(s2.token),
        body: JSON.stringify({ data: TINY_JPEG_B64, mime: "image/jpeg" }),
      })
    ).json();
    const mine2 = await (
      await app.request(`/api/v1/assignments/${asg.assignment.id}/my-submission`, {
        headers: auth(s2.token),
      })
    ).json();
    await app.request(`/api/v1/submissions/${mine2.submission.id}/photos`, {
      method: "POST",
      headers: auth(s2.token),
      body: JSON.stringify({ photoUrls: [up2.url] }),
    });

    return { teacher, s1, s2, cls, asg: asg.assignment };
  }

  it("summarizes completion buckets and rate", async () => {
    const { teacher, asg, s1, s2 } = await setupTwoStudentsOneDone();
    // add third student not started
    const s3 = await loginAs(app, "p5s3", "student", "小刚");
    const detail = await (
      await app.request(`/api/v1/classes/${asg.classId}`, {
        headers: auth(teacher.token),
      })
    ).json();
    await app.request("/api/v1/classes/join", {
      method: "POST",
      headers: auth(s3.token),
      body: JSON.stringify({ inviteCode: detail.class.inviteCode }),
    });

    const res = await app.request(
      `/api/v1/assignments/${asg.id}/summary`,
      { headers: auth(teacher.token) },
    );
    expect(res.status).toBe(200);
    const { summary } = await res.json();
    expect(summary.totalStudents).toBe(3);
    expect(summary.completedCount).toBe(1);
    expect(summary.inProgressCount).toBe(1);
    expect(summary.notStartedCount).toBe(1);
    expect(summary.completionRate).toBeCloseTo(33.3, 0);
    expect(summary.incomplete.map((x: { userId: string }) => x.userId).sort()).toEqual(
      [s2.userId, s3.userId].sort(),
    );
    expect(summary.completed[0].userId).toBe(s1.userId);
  });

  it("reminder text includes title and incomplete names", async () => {
    const { teacher, asg } = await setupTwoStudentsOneDone();
    const res = await app.request(
      `/api/v1/assignments/${asg.id}/reminder-text`,
      { headers: auth(teacher.token) },
    );
    const { text } = await res.json();
    expect(text).toContain("周末练习");
    expect(text).toContain("小红");
    expect(text).not.toContain("小明");
    expect(text).toContain("【算本】");
  });

  it("removed student is excluded from denominator", async () => {
    const { teacher, asg, s2, cls } = await setupTwoStudentsOneDone();
    await app.request(
      `/api/v1/classes/${cls.class.id}/members/${s2.userId}`,
      { method: "DELETE", headers: auth(teacher.token) },
    );
    const { summary } = await (
      await app.request(`/api/v1/assignments/${asg.id}/summary`, {
        headers: auth(teacher.token),
      })
    ).json();
    expect(summary.totalStudents).toBe(1);
    expect(summary.completedCount).toBe(1);
    expect(summary.completionRate).toBe(100);
    expect(summary.incomplete).toHaveLength(0);
  });

  it("class dashboard returns recent rates and pending grade", async () => {
    const { teacher, cls } = await setupTwoStudentsOneDone();
    const res = await app.request(
      `/api/v1/classes/${cls.class.id}/dashboard`,
      { headers: auth(teacher.token) },
    );
    expect(res.status).toBe(200);
    const { dashboard } = await res.json();
    expect(dashboard.studentCount).toBe(2);
    expect(dashboard.pendingGrade).toBe(1);
    expect(dashboard.recentAssignments.length).toBeGreaterThan(0);
    expect(dashboard.recentAssignments[0].completionRate).toBe(50);
  });

  it("student incompleteCount reflects unfinished tasks", async () => {
    const { s1, s2 } = await setupTwoStudentsOneDone();
    const done = await (
      await app.request("/api/v1/assignments", { headers: auth(s1.token) })
    ).json();
    expect(done.incompleteCount).toBe(0);

    const pending = await (
      await app.request("/api/v1/assignments", { headers: auth(s2.token) })
    ).json();
    expect(pending.incompleteCount).toBe(1);
  });
});
