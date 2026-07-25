import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/presentation/http/app.js";
import { openDatabase } from "../src/infrastructure/persistence/db.js";
import { gradeOne, normalizeText } from "../src/domain/grading/auto-grade.js";

function testApp() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "math-mini-o-"));
  const db = openDatabase(":memory:");
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

describe("auto grade helpers", () => {
  it("normalizes fullwidth digits", () => {
    expect(normalizeText(" １２ ")).toBe("12");
  });

  it("grades fill blank and choice", () => {
    expect(
      gradeOne(
        {
          type: "fill_blank",
          stem: "1+1",
          options: null,
          answer: "2",
          explanation: null,
          knowledgeNodeId: null,
          source: "manual",
        },
        "２",
      ).correct,
    ).toBe(true);

    expect(
      gradeOne(
        {
          type: "choice",
          stem: "?",
          options: [
            { id: "a", text: "1" },
            { id: "b", text: "2" },
          ],
          answer: "b",
          explanation: null,
          knowledgeNodeId: null,
          source: "manual",
        },
        "a",
      ).correct,
    ).toBe(false);
  });
});

describe("Online answer + correction", () => {
  let app: ReturnType<typeof testApp>;

  beforeEach(() => {
    app = testApp();
  });

  async function setupPaper() {
    const teacher = await loginAs(app, "ot", "teacher", "王老师");
    const student = await loginAs(app, "os", "student", "小明");

    const q1 = await (
      await app.request("/api/v1/questions", {
        method: "POST",
        headers: auth(teacher.token),
        body: JSON.stringify({
          type: "fill_blank",
          stem: "3+4=",
          answer: "7",
        }),
      })
    ).json();
    const q2 = await (
      await app.request("/api/v1/questions", {
        method: "POST",
        headers: auth(teacher.token),
        body: JSON.stringify({
          type: "true_false",
          stem: "2 是偶数",
          answer: true,
        }),
      })
    ).json();

    const cls = await (
      await app.request("/api/v1/classes", {
        method: "POST",
        headers: auth(teacher.token),
        body: JSON.stringify({ name: "在线班", grade: 3 }),
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
          title: "口算两题",
          questionIds: [q1.question.id, q2.question.id],
          publish: true,
        }),
      })
    ).json();

    const qs = await (
      await app.request(`/api/v1/assignments/${asg.assignment.id}/questions`, {
        headers: auth(teacher.token),
      })
    ).json();

    return {
      teacher,
      student,
      asg: asg.assignment,
      aqIds: qs.questions.map((x: { id: string }) => x.id) as string[],
    };
  }

  it("all correct -> completed with score 100", async () => {
    const { student, asg, aqIds } = await setupPaper();
    const mine = await (
      await app.request(`/api/v1/assignments/${asg.id}/my-submission`, {
        headers: auth(student.token),
      })
    ).json();

    const res = await app.request(
      `/api/v1/submissions/${mine.submission.id}/answers`,
      {
        method: "POST",
        headers: auth(student.token),
        body: JSON.stringify({
          answers: [
            { assignmentQuestionId: aqIds[0], response: "7" },
            { assignmentQuestionId: aqIds[1], response: true },
          ],
        }),
      },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.submission.status).toBe("completed");
    expect(body.submission.score).toBe(100);
  });

  it("wrong then correct -> pending_correction then completed; rate updates", async () => {
    const { teacher, student, asg, aqIds } = await setupPaper();
    const mine = await (
      await app.request(`/api/v1/assignments/${asg.id}/my-submission`, {
        headers: auth(student.token),
      })
    ).json();

    // wrong on first
    let sub = await (
      await app.request(`/api/v1/submissions/${mine.submission.id}/answers`, {
        method: "POST",
        headers: auth(student.token),
        body: JSON.stringify({
          answers: [
            { assignmentQuestionId: aqIds[0], response: "8" },
            { assignmentQuestionId: aqIds[1], response: true },
          ],
        }),
      })
    ).json();
    expect(sub.submission.status).toBe("pending_correction");
    expect(sub.submission.score).toBe(50);
    expect(
      sub.submission.answers.find(
        (a: { isCorrect: boolean | null }) => a.isCorrect === false,
      ),
    ).toBeTruthy();

    let summary = await (
      await app.request(`/api/v1/assignments/${asg.id}/summary`, {
        headers: auth(teacher.token),
      })
    ).json();
    expect(summary.summary.completedCount).toBe(0);
    expect(summary.summary.inProgressCount).toBe(1);

    // correct the wrong one
    sub = await (
      await app.request(`/api/v1/submissions/${mine.submission.id}/correct`, {
        method: "POST",
        headers: auth(student.token),
        body: JSON.stringify({
          answers: [{ assignmentQuestionId: aqIds[0], response: "7" }],
        }),
      })
    ).json();
    expect(sub.submission.status).toBe("completed");
    expect(sub.submission.score).toBe(100);

    summary = await (
      await app.request(`/api/v1/assignments/${asg.id}/summary`, {
        headers: auth(teacher.token),
      })
    ).json();
    expect(summary.summary.completedCount).toBe(1);
    expect(summary.summary.completionRate).toBe(100);
  });

  it("saves draft and resumes", async () => {
    const { student, asg, aqIds } = await setupPaper();
    const mine = await (
      await app.request(`/api/v1/assignments/${asg.id}/my-submission`, {
        headers: auth(student.token),
      })
    ).json();

    await app.request(`/api/v1/submissions/${mine.submission.id}/draft`, {
      method: "PUT",
      headers: auth(student.token),
      body: JSON.stringify({
        answers: [{ assignmentQuestionId: aqIds[0], response: "7" }],
      }),
    });

    const again = await (
      await app.request(`/api/v1/assignments/${asg.id}/my-submission`, {
        headers: auth(student.token),
      })
    ).json();
    expect(again.submission.status).toBe("in_progress");
    const a0 = again.submission.answers.find(
      (x: { assignmentQuestionId: string }) =>
        x.assignmentQuestionId === aqIds[0],
    );
    expect(a0.response).toBe("7");
  });
});
