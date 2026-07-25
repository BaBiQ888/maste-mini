/**
 * Phase 12: end-to-end main path covering PRD success criteria 1–4
 * and permission isolation.
 */
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/presentation/http/app.js";
import { openDatabase } from "../src/infrastructure/persistence/db.js";

const TINY_JPEG_B64 =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAGcP//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAQUCf//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQMBAT8Bf//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQIBAT8Bf//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEABj8Cf//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAT8hf//Z";

function testApp() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "math-mini-mvp-"));
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

describe("MVP main path (Phase 12)", () => {
  let app: ReturnType<typeof testApp>;

  beforeEach(() => {
    app = testApp();
  });

  it("建班→入班→三类作业→汇总催交→批改/订正", async () => {
    const teacher = await loginAs(app, "mvp-t", "teacher", "王老师");
    const student = await loginAs(app, "mvp-s", "student", "小明");
    const student2 = await loginAs(app, "mvp-s2", "student", "小红");

    // 1. 建班 + 邀请码
    const cls = await (
      await app.request("/api/v1/classes", {
        method: "POST",
        headers: auth(teacher.token),
        body: JSON.stringify({ name: "MVP验收班", grade: 4 }),
      })
    ).json();
    expect(cls.class.inviteCode).toMatch(/^[A-Z2-9]{6}$/);

    // 2. 入班
    for (const s of [student, student2]) {
      const j = await app.request("/api/v1/classes/join", {
        method: "POST",
        headers: auth(s.token),
        body: JSON.stringify({ inviteCode: cls.class.inviteCode }),
      });
      expect(j.status).toBe(200);
    }

    // 3a. 每日计算
    const gen = await (
      await app.request("/api/v1/questions/generate", {
        method: "POST",
        headers: auth(teacher.token),
        body: JSON.stringify({
          operationId: "int_mul_table",
          count: 2,
          seed: 12,
        }),
      })
    ).json();
    const drill = await (
      await app.request("/api/v1/assignments", {
        method: "POST",
        headers: auth(teacher.token),
        body: JSON.stringify({
          classId: cls.class.id,
          type: "daily_drill",
          title: "今日计算",
          publish: true,
          generatedSnapshots: gen.questions,
          config: { operationId: "int_mul_table", count: 2, timeLimitSec: 300 },
        }),
      })
    ).json();
    expect(drill.assignment.status).toBe("published");

    // 3b. 知识点打卡
    const qk = await (
      await app.request("/api/v1/questions", {
        method: "POST",
        headers: auth(teacher.token),
        body: JSON.stringify({
          type: "fill_blank",
          stem: "5+5=",
          answer: "10",
          knowledgeNodeId: "g4-u-int-k-add",
        }),
      })
    ).json();
    const checkin = await (
      await app.request("/api/v1/assignments", {
        method: "POST",
        headers: auth(teacher.token),
        body: JSON.stringify({
          classId: cls.class.id,
          type: "knowledge_checkin",
          title: "加法打卡",
          publish: true,
          questionIds: [qk.question.id],
          config: { knowledgeNodeIds: ["g4-u-int-k-add"] },
        }),
      })
    ).json();
    expect(checkin.assignment.knowledgePoints?.length).toBe(1);

    // 3c. 拍照作业
    const photo = await (
      await app.request("/api/v1/assignments", {
        method: "POST",
        headers: auth(teacher.token),
        body: JSON.stringify({
          classId: cls.class.id,
          type: "photo_homework",
          title: "练习册拍照",
          description: "P12",
          publish: true,
        }),
      })
    ).json();

    // student list sees 3 published
    const list = await (
      await app.request("/api/v1/assignments", {
        headers: auth(student.token),
      })
    ).json();
    expect(list.assignments).toHaveLength(3);
    expect(list.incompleteCount).toBe(3);

    // 4. 学生完成在线计算（全对）
    const mineDrill = await (
      await app.request(
        `/api/v1/assignments/${drill.assignment.id}/my-submission`,
        { headers: auth(student.token) },
      )
    ).json();
    const drillQs = await (
      await app.request(
        `/api/v1/assignments/${drill.assignment.id}/questions`,
        { headers: auth(teacher.token) },
      )
    ).json();
    const drillDone = await (
      await app.request(
        `/api/v1/submissions/${mineDrill.submission.id}/answers`,
        {
          method: "POST",
          headers: auth(student.token),
          body: JSON.stringify({
            answers: drillQs.questions.map(
              (q: { id: string; snapshot: { answer: string } }) => ({
                assignmentQuestionId: q.id,
                response: q.snapshot.answer,
              }),
            ),
          }),
        },
      )
    ).json();
    expect(drillDone.submission.status).toBe("completed");

    // 5. 打卡故意答错 → 订正
    const mineCk = await (
      await app.request(
        `/api/v1/assignments/${checkin.assignment.id}/my-submission`,
        { headers: auth(student.token) },
      )
    ).json();
    const ckQs = await (
      await app.request(
        `/api/v1/assignments/${checkin.assignment.id}/questions`,
        { headers: auth(teacher.token) },
      )
    ).json();
    let ck = await (
      await app.request(
        `/api/v1/submissions/${mineCk.submission.id}/answers`,
        {
          method: "POST",
          headers: auth(student.token),
          body: JSON.stringify({
            answers: [
              {
                assignmentQuestionId: ckQs.questions[0].id,
                response: "99",
              },
            ],
          }),
        },
      )
    ).json();
    expect(ck.submission.status).toBe("pending_correction");
    ck = await (
      await app.request(
        `/api/v1/submissions/${mineCk.submission.id}/correct`,
        {
          method: "POST",
          headers: auth(student.token),
          body: JSON.stringify({
            answers: [
              {
                assignmentQuestionId: ckQs.questions[0].id,
                response: "10",
              },
            ],
          }),
        },
      )
    ).json();
    expect(ck.submission.status).toBe("completed");

    // 6. 拍照上传 + 老师批改
    const up = await (
      await app.request("/api/v1/uploads/photo", {
        method: "POST",
        headers: auth(student.token),
        body: JSON.stringify({ data: TINY_JPEG_B64, mime: "image/jpeg" }),
      })
    ).json();
    const minePh = await (
      await app.request(
        `/api/v1/assignments/${photo.assignment.id}/my-submission`,
        { headers: auth(student.token) },
      )
    ).json();
    const submitted = await (
      await app.request(
        `/api/v1/submissions/${minePh.submission.id}/photos`,
        {
          method: "POST",
          headers: auth(student.token),
          body: JSON.stringify({ photoUrls: [up.url] }),
        },
      )
    ).json();
    expect(submitted.submission.status).toBe("submitted");

    const graded = await (
      await app.request(
        `/api/v1/submissions/${minePh.submission.id}/grade`,
        {
          method: "POST",
          headers: auth(teacher.token),
          body: JSON.stringify({
            result: "correct",
            score: 90,
            comment: "工整",
          }),
        },
      )
    ).json();
    expect(graded.submission.status).toBe("completed");
    expect(graded.submission.grade.comment).toBe("工整");

    // 7. 汇总 + 催交（小红未做计算）
    const summary = await (
      await app.request(
        `/api/v1/assignments/${drill.assignment.id}/summary`,
        { headers: auth(teacher.token) },
      )
    ).json();
    expect(summary.summary.totalStudents).toBe(2);
    expect(summary.summary.completedCount).toBe(1);
    expect(summary.summary.incomplete.some(
      (s: { userId: string }) => s.userId === student2.userId,
    )).toBe(true);

    const nudge = await (
      await app.request(
        `/api/v1/assignments/${drill.assignment.id}/reminder-text`,
        { headers: auth(teacher.token) },
      )
    ).json();
    expect(nudge.text).toContain("今日计算");
    expect(nudge.text).toContain("小红");
    expect(nudge.text).not.toContain("小明");

    // student fully done except student2
    const doneList = await (
      await app.request("/api/v1/assignments", {
        headers: auth(student.token),
      })
    ).json();
    expect(doneList.incompleteCount).toBe(0);
  });

  it("permission: student cannot grade or view other class", async () => {
    const teacher = await loginAs(app, "perm-t", "teacher", "老师A");
    const teacherB = await loginAs(app, "perm-tb", "teacher", "老师B");
    const student = await loginAs(app, "perm-s", "student", "学生");
    const studentB = await loginAs(app, "perm-sb", "student", "学生B");

    const cls = await (
      await app.request("/api/v1/classes", {
        method: "POST",
        headers: auth(teacher.token),
        body: JSON.stringify({ name: "权限班", grade: 3 }),
      })
    ).json();
    await app.request("/api/v1/classes/join", {
      method: "POST",
      headers: auth(student.token),
      body: JSON.stringify({ inviteCode: cls.class.inviteCode }),
    });

    const photo = await (
      await app.request("/api/v1/assignments", {
        method: "POST",
        headers: auth(teacher.token),
        body: JSON.stringify({
          classId: cls.class.id,
          type: "photo_homework",
          title: "权限拍照",
          publish: true,
        }),
      })
    ).json();

    const up = await (
      await app.request("/api/v1/uploads/photo", {
        method: "POST",
        headers: auth(student.token),
        body: JSON.stringify({ data: TINY_JPEG_B64, mime: "image/jpeg" }),
      })
    ).json();
    const mine = await (
      await app.request(
        `/api/v1/assignments/${photo.assignment.id}/my-submission`,
        { headers: auth(student.token) },
      )
    ).json();
    await app.request(`/api/v1/submissions/${mine.submission.id}/photos`, {
      method: "POST",
      headers: auth(student.token),
      body: JSON.stringify({ photoUrls: [up.url] }),
    });

    // student cannot grade
    const gradeAsStudent = await app.request(
      `/api/v1/submissions/${mine.submission.id}/grade`,
      {
        method: "POST",
        headers: auth(student.token),
        body: JSON.stringify({ result: "correct" }),
      },
    );
    expect(gradeAsStudent.status).toBeGreaterThanOrEqual(400);

    // other teacher cannot view class / grade
    const view = await app.request(`/api/v1/classes/${cls.class.id}`, {
      headers: auth(teacherB.token),
    });
    expect(view.status).toBe(403);

    const gradeB = await app.request(
      `/api/v1/submissions/${mine.submission.id}/grade`,
      {
        method: "POST",
        headers: auth(teacherB.token),
        body: JSON.stringify({ result: "correct" }),
      },
    );
    expect(gradeB.status).toBeGreaterThanOrEqual(400);

    // student B not in class cannot access assignment
    const deny = await app.request(
      `/api/v1/assignments/${photo.assignment.id}/my-submission`,
      { headers: auth(studentB.token) },
    );
    expect(deny.status).toBe(403);
  });

  it("revoked assignment is hidden from student", async () => {
    const teacher = await loginAs(app, "rev-t", "teacher", "老师");
    const student = await loginAs(app, "rev-s", "student", "学生");
    const cls = await (
      await app.request("/api/v1/classes", {
        method: "POST",
        headers: auth(teacher.token),
        body: JSON.stringify({ name: "下架班", grade: 3 }),
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
          title: "将下架",
          publish: true,
        }),
      })
    ).json();
    await app.request(`/api/v1/assignments/${asg.assignment.id}/revoke`, {
      method: "POST",
      headers: auth(teacher.token),
    });
    const list = await (
      await app.request("/api/v1/assignments", {
        headers: auth(student.token),
      })
    ).json();
    expect(list.assignments).toHaveLength(0);
  });
});
