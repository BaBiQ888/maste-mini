import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/presentation/http/app.js";
import { openDatabase } from "../src/infrastructure/persistence/db.js";
import {
  generateDrillQuestions,
  listOperations,
} from "../src/domain/drill/generator.js";
import { gradeOne } from "../src/domain/grading/auto-grade.js";

describe("drill generator unit", () => {
  it("lists enabled operations for grade 3", () => {
    const ops = listOperations(3);
    expect(ops.length).toBeGreaterThan(5);
    expect(ops.every((o) => o.grades.includes(3))).toBe(true);
  });

  it("generates fixed count with seed reproducibility", () => {
    const a = generateDrillQuestions({
      operationId: "int_add_2d",
      count: 5,
      difficulty: "normal",
      seed: 42,
    });
    const b = generateDrillQuestions({
      operationId: "int_add_2d",
      count: 5,
      difficulty: "normal",
      seed: 42,
    });
    expect(a.questions).toHaveLength(5);
    expect(a.questions.map((q) => q.stem)).toEqual(
      b.questions.map((q) => q.stem),
    );
    // answers grade as correct against themselves
    for (const q of a.questions) {
      expect(gradeOne(q, q.answer).correct).toBe(true);
    }
  });

  it("rejects bad count and unknown op", () => {
    expect(() =>
      generateDrillQuestions({ operationId: "int_add_2d", count: 0 }),
    ).toThrow();
    expect(() =>
      generateDrillQuestions({ operationId: "nope", count: 5 }),
    ).toThrow();
  });

  it("generates remainder format", () => {
    const r = generateDrillQuestions({
      operationId: "int_div_1d_remainder",
      count: 3,
      seed: 7,
    });
    expect(r.questions[0].answer).toMatch(/^\d+\.\.\.\d+$/);
  });
});

function testApp() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "math-mini-d-"));
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
  return { token: login.token as string };
}

function auth(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

describe("drill API + student loop", () => {
  let app: ReturnType<typeof testApp>;

  beforeEach(() => {
    app = testApp();
  });

  it("preview generate, publish with snapshots, student completes", async () => {
    const teacher = await loginAs(app, "dt", "teacher", "王老师");
    const student = await loginAs(app, "ds", "student", "小明");

    const gen = await (
      await app.request("/api/v1/questions/generate", {
        method: "POST",
        headers: auth(teacher.token),
        body: JSON.stringify({
          operationId: "int_mul_table",
          count: 3,
          difficulty: "basic",
          seed: 99,
        }),
      })
    ).json();
    expect(gen.questions).toHaveLength(3);

    // mix one manual
    const manual = await (
      await app.request("/api/v1/questions", {
        method: "POST",
        headers: auth(teacher.token),
        body: JSON.stringify({
          type: "fill_blank",
          stem: "1+1=",
          answer: "2",
        }),
      })
    ).json();

    const cls = await (
      await app.request("/api/v1/classes", {
        method: "POST",
        headers: auth(teacher.token),
        body: JSON.stringify({ name: "计算班", grade: 3 }),
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
          title: "今日表内乘法",
          publish: true,
          generatedSnapshots: gen.questions,
          questionIds: [manual.question.id],
          config: {
            operationId: "int_mul_table",
            count: 3,
            difficulty: "basic",
            timeLimitSec: 300,
            seed: gen.seed,
          },
        }),
      })
    ).json();
    expect(asg.assignment.questionCount).toBe(4);
    expect(asg.assignment.config.timeLimitSec).toBe(300);

    const mine = await (
      await app.request(
        `/api/v1/assignments/${asg.assignment.id}/my-submission`,
        { headers: auth(student.token) },
      )
    ).json();
    const teacherQs = await (
      await app.request(
        `/api/v1/assignments/${asg.assignment.id}/questions`,
        { headers: auth(teacher.token) },
      )
    ).json();

    const answers = teacherQs.questions.map(
      (q: { id: string; snapshot: { answer: string } }) => ({
        assignmentQuestionId: q.id,
        response: q.snapshot.answer,
      }),
    );
    const done = await (
      await app.request(`/api/v1/submissions/${mine.submission.id}/answers`, {
        method: "POST",
        headers: auth(student.token),
        body: JSON.stringify({ answers }),
      })
    ).json();
    expect(done.submission.status).toBe("completed");
  });
});
