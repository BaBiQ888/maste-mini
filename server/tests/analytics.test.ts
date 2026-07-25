import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/presentation/http/app.js";
import { openDatabase } from "../src/infrastructure/persistence/db.js";

async function testApp() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "math-mini-a-"));
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

describe("Phase 10 analytics", () => {
  let app: ReturnType<typeof testApp>;

  beforeEach(async () => {
    app = await testApp();
  });

  async function setupOnlineComplete() {
    const teacher = await loginAs(app, "at", "teacher", "王老师");
    const student = await loginAs(app, "as", "student", "小明");

    const q1 = await (
      await app.request("/api/v1/questions", {
        method: "POST",
        headers: auth(teacher.token),
        body: JSON.stringify({
          type: "fill_blank",
          stem: "1+1=",
          answer: "2",
          knowledgeNodeId: "g3-u-addsub-k-add2",
        }),
      })
    ).json();
    const q2 = await (
      await app.request("/api/v1/questions", {
        method: "POST",
        headers: auth(teacher.token),
        body: JSON.stringify({
          type: "fill_blank",
          stem: "2+2=",
          answer: "4",
          knowledgeNodeId: "g3-u-addsub-k-add2",
        }),
      })
    ).json();

    const cls = await (
      await app.request("/api/v1/classes", {
        method: "POST",
        headers: auth(teacher.token),
        body: JSON.stringify({ name: "学情班", grade: 3 }),
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
          type: "knowledge_checkin",
          title: "加法打卡",
          publish: true,
          questionIds: [q1.question.id, q2.question.id],
          config: { knowledgeNodeIds: ["g3-u-addsub-k-add2"] },
        }),
      })
    ).json();

    const mine = await (
      await app.request(
        `/api/v1/assignments/${asg.assignment.id}/my-submission`,
        { headers: auth(student.token) },
      )
    ).json();
    const tQs = await (
      await app.request(
        `/api/v1/assignments/${asg.assignment.id}/questions`,
        { headers: auth(teacher.token) },
      )
    ).json();

    // first wrong then correct on q1 path - submit one wrong one right first
    await app.request(`/api/v1/submissions/${mine.submission.id}/answers`, {
      method: "POST",
      headers: auth(student.token),
      body: JSON.stringify({
        answers: [
          {
            assignmentQuestionId: tQs.questions[0].id,
            response: "9",
          },
          {
            assignmentQuestionId: tQs.questions[1].id,
            response: "4",
          },
        ],
      }),
    });
    await app.request(`/api/v1/submissions/${mine.submission.id}/correct`, {
      method: "POST",
      headers: auth(student.token),
      body: JSON.stringify({
        answers: [
          {
            assignmentQuestionId: tQs.questions[0].id,
            response: "2",
          },
        ],
      }),
    });

    return { teacher, student, cls, asg: asg.assignment };
  }

  it("returns per-question correct rates", async () => {
    const { teacher, asg } = await setupOnlineComplete();
    const res = await app.request(
      `/api/v1/assignments/${asg.id}/question-stats`,
      { headers: auth(teacher.token) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.questions).toHaveLength(2);
    // both eventually correct (latest answer is correct)
    expect(body.questions.every((q: { correctRate: number }) => q.correctRate === 100)).toBe(
      true,
    );
  });

  it("student stats over 14 days", async () => {
    const { teacher, student, cls } = await setupOnlineComplete();
    const res = await app.request(
      `/api/v1/classes/${cls.class.id}/students/${student.userId}/stats?days=14`,
      { headers: auth(teacher.token) },
    );
    expect(res.status).toBe(200);
    const { stats } = await res.json();
    expect(stats.completedCount).toBe(1);
    expect(stats.completionRate).toBe(100);
    expect(stats.answerTotal).toBeGreaterThanOrEqual(2);
    expect(stats.correctRate).toBeGreaterThan(0);
  });

  it("calendar and knowledge progress for student", async () => {
    const { student } = await setupOnlineComplete();
    const now = new Date();
    const cal = await (
      await app.request(
        `/api/v1/me/calendar?year=${now.getFullYear()}&month=${now.getMonth() + 1}`,
        { headers: auth(student.token) },
      )
    ).json();
    expect(cal.calendar.days.length).toBeGreaterThanOrEqual(1);
    expect(cal.calendar.days[0].completedCount).toBeGreaterThanOrEqual(1);

    const kp = await (
      await app.request("/api/v1/me/knowledge-progress", {
        headers: auth(student.token),
      })
    ).json();
    expect(kp.items.some((i: { knowledgeNodeId: string }) => i.knowledgeNodeId === "g3-u-addsub-k-add2")).toBe(
      true,
    );
  });
});
