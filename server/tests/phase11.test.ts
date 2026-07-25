import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/presentation/http/app.js";
import { openDatabase } from "../src/infrastructure/persistence/db.js";

function testApp() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "math-mini-p11-"));
  const db = openDatabase(":memory:");
  return { app: createApp(db, { wechat: { appId: "", appSecret: "", mock: true }, dataDir }), db };
}

async function loginAs(
  app: ReturnType<typeof testApp>["app"],
  code: string,
  role: "teacher" | "student",
  nickname: string,
) {
  const login = await (
    await app.request("/api/v1/auth/wechat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, nickname }),
    })
  ).json();
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

describe("Phase 11", () => {
  let app: ReturnType<typeof testApp>["app"];
  let db: ReturnType<typeof testApp>["db"];

  beforeEach(() => {
    const t = testApp();
    app = t.app;
    db = t.db;
  });

  it("duplicates assignment as independent draft", async () => {
    const teacher = await loginAs(app, "p11t", "teacher", "王老师");
    const q = await (
      await app.request("/api/v1/questions", {
        method: "POST",
        headers: auth(teacher.token),
        body: JSON.stringify({
          type: "fill_blank",
          stem: "原题",
          answer: "1",
        }),
      })
    ).json();
    const cls = await (
      await app.request("/api/v1/classes", {
        method: "POST",
        headers: auth(teacher.token),
        body: JSON.stringify({ name: "复制班", grade: 3 }),
      })
    ).json();
    const asg = await (
      await app.request("/api/v1/assignments", {
        method: "POST",
        headers: auth(teacher.token),
        body: JSON.stringify({
          classId: cls.class.id,
          type: "daily_drill",
          title: "原作业",
          publish: true,
          questionIds: [q.question.id],
        }),
      })
    ).json();

    const dup = await (
      await app.request(`/api/v1/assignments/${asg.assignment.id}/duplicate`, {
        method: "POST",
        headers: auth(teacher.token),
      })
    ).json();
    expect(dup.assignment.status).toBe("draft");
    expect(dup.assignment.id).not.toBe(asg.assignment.id);
    expect(dup.assignment.title).toContain("副本");
    expect(dup.assignment.questionCount).toBe(1);

    // mutate source; published original unchanged; draft has frozen snapshot from copy time
    await app.request(`/api/v1/questions/${q.question.id}`, {
      method: "PATCH",
      headers: auth(teacher.token),
      body: JSON.stringify({ stem: "已改源题" }),
    });
    const origQs = await (
      await app.request(`/api/v1/assignments/${asg.assignment.id}/questions`, {
        headers: auth(teacher.token),
      })
    ).json();
    expect(origQs.questions[0].snapshot.stem).toBe("原题");

    const dupQs = await (
      await app.request(`/api/v1/assignments/${dup.assignment.id}/questions`, {
        headers: auth(teacher.token),
      })
    ).json();
    expect(dupQs.questions[0].snapshot.stem).toBe("原题");
  });

  it("invite-qr returns dataUrl with SUANBEN payload", async () => {
    const teacher = await loginAs(app, "p11t2", "teacher", "李老师");
    const cls = await (
      await app.request("/api/v1/classes", {
        method: "POST",
        headers: auth(teacher.token),
        body: JSON.stringify({ name: "二维码班", grade: 4 }),
      })
    ).json();
    const qr = await (
      await app.request(`/api/v1/classes/${cls.class.id}/invite-qr`, {
        headers: auth(teacher.token),
      })
    ).json();
    expect(qr.payload).toBe(`SUANBEN:${cls.class.inviteCode}`);
    expect(qr.dataUrl).toMatch(/^data:image\/png;base64,/);
  });

  it("force submit after timer works for partial answers", async () => {
    const teacher = await loginAs(app, "p11t3", "teacher", "赵老师");
    const student = await loginAs(app, "p11s3", "student", "小明");
    const gen = await (
      await app.request("/api/v1/questions/generate", {
        method: "POST",
        headers: auth(teacher.token),
        body: JSON.stringify({
          operationId: "int_mul_table",
          count: 2,
          seed: 1,
        }),
      })
    ).json();
    const cls = await (
      await app.request("/api/v1/classes", {
        method: "POST",
        headers: auth(teacher.token),
        body: JSON.stringify({ name: "限时班", grade: 3 }),
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
          type: "daily_drill",
          title: "限时卷",
          publish: true,
          generatedSnapshots: gen.questions,
          config: { timeLimitSec: 60 },
        }),
      })
    ).json();

    const mine = await (
      await app.request(
        `/api/v1/assignments/${asg.assignment.id}/my-submission`,
        { headers: auth(student.token) },
      )
    ).json();
    expect(mine.submission.timerStartedAt).toBeTruthy();
    expect(mine.submission.timeLimitSec).toBe(60);
    expect(mine.submission.timeRemainingSec).toBeLessThanOrEqual(60);

    // backdate timer so force is allowed
    db.prepare(
      `UPDATE submissions SET timer_started_at = ? WHERE id = ?`,
    ).run(new Date(Date.now() - 120_000).toISOString(), mine.submission.id);

    const forced = await (
      await app.request(`/api/v1/submissions/${mine.submission.id}/answers`, {
        method: "POST",
        headers: auth(student.token),
        body: JSON.stringify({ answers: [], force: true }),
      })
    ).json();
    expect(["completed", "pending_correction"]).toContain(
      forced.submission.status,
    );
  });
});
