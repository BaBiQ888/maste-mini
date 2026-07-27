import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/presentation/http/app.js";
import { openDatabase } from "../src/infrastructure/persistence/db.js";

async function testApp() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "math-mini-q-"));
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

describe("QuestionBank + snapshots", () => {
  let app: ReturnType<typeof testApp>;

  beforeEach(async () => {
    app = await testApp();
  });

  it("creates three types of manual questions and lists them", async () => {
    const teacher = await loginAs(app, "qt", "teacher", "王老师");

    const fill = await (
      await app.request("/api/v1/questions", {
        method: "POST",
        headers: auth(teacher.token),
        body: JSON.stringify({
          type: "fill_blank",
          stem: "12 + 8 = ____",
          answer: "20",
          knowledgeNodeId: "g3-u-addsub-k-add2",
        }),
      })
    ).json();
    expect(fill.question.type).toBe("fill_blank");
    expect(fill.question.knowledgeNodeId).toBe("g3-u-addsub-k-add2");

    await app.request("/api/v1/questions", {
      method: "POST",
      headers: auth(teacher.token),
      body: JSON.stringify({
        type: "choice",
        stem: "3 × 4 = ?",
        options: [
          { id: "a", text: "7" },
          { id: "b", text: "12" },
        ],
        answer: "b",
      }),
    });

    await app.request("/api/v1/questions", {
      method: "POST",
      headers: auth(teacher.token),
      body: JSON.stringify({
        type: "true_false",
        stem: "0 是偶数",
        answer: true,
      }),
    });

    const list = await (
      await app.request("/api/v1/questions", {
        headers: auth(teacher.token),
      })
    ).json();
    expect(list.questions).toHaveLength(3);
  });

  it("published assignment freezes snapshot when source question changes", async () => {
    const teacher = await loginAs(app, "qt2", "teacher", "李老师");
    const student = await loginAs(app, "qs2", "student", "小明");

    const q = await (
      await app.request("/api/v1/questions", {
        method: "POST",
        headers: auth(teacher.token),
        body: JSON.stringify({
          type: "fill_blank",
          stem: "原题干 5+5=",
          answer: "10",
          explanation: "原解析",
        }),
      })
    ).json();

    const cls = await (
      await app.request("/api/v1/classes", {
        method: "POST",
        headers: auth(teacher.token),
        body: JSON.stringify({ name: "题库班", grade: 3 }),
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
          title: "口算 5 题",
          questionIds: [q.question.id],
          publish: true,
        }),
      })
    ).json();
    expect(asg.assignment.questionCount).toBe(1);
    expect(asg.assignment.type).toBe("daily_drill");

    // mutate source
    await app.request(`/api/v1/questions/${q.question.id}`, {
      method: "PATCH",
      headers: auth(teacher.token),
      body: JSON.stringify({
        stem: "改过的题干 9+9=",
        answer: "18",
        explanation: "新解析",
      }),
    });

    const teacherQs = await (
      await app.request(`/api/v1/assignments/${asg.assignment.id}/questions`, {
        headers: auth(teacher.token),
      })
    ).json();
    expect(teacherQs.questions[0].snapshot.stem).toBe("原题干 5+5=");
    expect(teacherQs.questions[0].snapshot.answer).toBe("10");

    // source bank shows new stem
    const bank = await (
      await app.request(`/api/v1/questions/${q.question.id}`, {
        headers: auth(teacher.token),
      })
    ).json();
    expect(bank.question.stem).toBe("改过的题干 9+9=");

    // student cannot see answer
    const studentQs = await (
      await app.request(`/api/v1/assignments/${asg.assignment.id}/questions`, {
        headers: auth(student.token),
      })
    ).json();
    expect(studentQs.questions[0].snapshot.stem).toBe("原题干 5+5=");
    expect(studentQs.questions[0].snapshot.answer).toBe("");
  });

  it("draft can update questions; publish refreezes from source", async () => {
    const teacher = await loginAs(app, "qt3", "teacher", "赵老师");
    const cls = await (
      await app.request("/api/v1/classes", {
        method: "POST",
        headers: auth(teacher.token),
        body: JSON.stringify({ name: "草稿班", grade: 4 }),
      })
    ).json();

    const q1 = await (
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
    const q2 = await (
      await app.request("/api/v1/questions", {
        method: "POST",
        headers: auth(teacher.token),
        body: JSON.stringify({
          type: "fill_blank",
          stem: "2+2=",
          answer: "4",
        }),
      })
    ).json();

    const asgRes = await app.request("/api/v1/assignments", {
      method: "POST",
      headers: auth(teacher.token),
      body: JSON.stringify({
        classId: cls.class.id,
        type: "knowledge_checkin",
        title: "打卡草稿",
        questionIds: [q1.question.id],
        publish: false,
        config: { knowledgeNodeIds: ["g3-u-addsub-k-add2"] },
      }),
    });
    expect(asgRes.status).toBe(201);
    const asg = await asgRes.json();
    expect(asg.assignment.status).toBe("draft");

    await app.request(`/api/v1/questions/${q1.question.id}`, {
      method: "PATCH",
      headers: auth(teacher.token),
      body: JSON.stringify({ stem: "1+1=（已改）" }),
    });

    await app.request(`/api/v1/assignments/${asg.assignment.id}/questions`, {
      method: "PUT",
      headers: auth(teacher.token),
      body: JSON.stringify({
        questionIds: [q1.question.id, q2.question.id],
      }),
    });

    await app.request(`/api/v1/assignments/${asg.assignment.id}/publish`, {
      method: "POST",
      headers: auth(teacher.token),
    });

    const qs = await (
      await app.request(`/api/v1/assignments/${asg.assignment.id}/questions`, {
        headers: auth(teacher.token),
      })
    ).json();
    expect(qs.questions).toHaveLength(2);
    expect(qs.questions[0].snapshot.stem).toBe("1+1=（已改）");
  });
});
