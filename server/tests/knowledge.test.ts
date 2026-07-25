import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/presentation/http/app.js";
import { openDatabase } from "../src/infrastructure/persistence/db.js";
import {
  KnowledgeTreeService,
  resetKnowledgeTreeCache,
} from "../src/application/knowledge/service.js";

describe("KnowledgeTreeService", () => {
  beforeEach(() => resetKnowledgeTreeCache());

  it("loads grades and knowledge nodes", () => {
    const kt = new KnowledgeTreeService();
    const grades = kt.list({ type: "grade" });
    expect(grades).toHaveLength(4);
    const k3 = kt.list({ grade: 3, type: "knowledge" });
    expect(k3.length).toBeGreaterThan(10);
  });

  it("searches by name", () => {
    const kt = new KnowledgeTreeService();
    const hit = kt.list({ q: "两位数加法", type: "knowledge" });
    expect(hit.some((n) => n.id === "g3-u-addsub-k-add2")).toBe(true);
  });

  it("builds unit tree for grade", () => {
    const tree = new KnowledgeTreeService().treeByGrade(4);
    expect(tree.length).toBeGreaterThan(3);
    expect(tree[0].knowledge.length).toBeGreaterThan(0);
  });
});

async function testApp() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "math-mini-k-"));
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
  return { token: login.token as string };
}

function auth(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

describe("knowledge checkin assignment", () => {
  let app: ReturnType<typeof testApp>;

  beforeEach(async () => {
    resetKnowledgeTreeCache();
    app = await testApp();
  });

  it("lists knowledge nodes via API and publishes checkin", async () => {
    const teacher = await loginAs(app, "kt", "teacher", "王老师");
    const student = await loginAs(app, "ks", "student", "小明");

    const nodes = await (
      await app.request("/api/v1/knowledge-nodes?grade=3&type=knowledge", {
        headers: auth(teacher.token),
      })
    ).json();
    expect(nodes.nodes.length).toBeGreaterThan(5);

    const search = await (
      await app.request(
        `/api/v1/knowledge-nodes?q=${encodeURIComponent("表内乘法")}`,
        { headers: auth(teacher.token) },
      )
    ).json();
    expect(
      search.nodes.some((n: { id: string }) => n.id === "g3-u-mul-k-table"),
    ).toBe(true);

    const q1 = await (
      await app.request("/api/v1/questions", {
        method: "POST",
        headers: auth(teacher.token),
        body: JSON.stringify({
          type: "fill_blank",
          stem: "3×4=",
          answer: "12",
          knowledgeNodeId: "g3-u-mul-k-table",
        }),
      })
    ).json();
    const q2 = await (
      await app.request("/api/v1/questions", {
        method: "POST",
        headers: auth(teacher.token),
        body: JSON.stringify({
          type: "fill_blank",
          stem: "6×7=",
          answer: "42",
          knowledgeNodeId: "g3-u-mul-k-table",
        }),
      })
    ).json();

    const cls = await (
      await app.request("/api/v1/classes", {
        method: "POST",
        headers: auth(teacher.token),
        body: JSON.stringify({ name: "打卡班", grade: 3 }),
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
          title: "表内乘法打卡",
          publish: true,
          questionIds: [q1.question.id, q2.question.id],
          config: {
            knowledgeNodeIds: ["g3-u-mul-k-table", "g3-u-addsub-k-add2"],
          },
        }),
      })
    ).json();

    expect(asg.assignment.type).toBe("knowledge_checkin");
    expect(asg.assignment.knowledgePoints?.length).toBe(2);
    expect(
      asg.assignment.knowledgePoints.some(
        (k: { name: string }) => k.name === "表内乘法口诀",
      ),
    ).toBe(true);

    // student sees knowledge on answers
    const mine = await (
      await app.request(
        `/api/v1/assignments/${asg.assignment.id}/my-submission`,
        { headers: auth(student.token) },
      )
    ).json();
    expect(
      mine.submission.answers.some(
        (a: { knowledgeLabel?: string }) =>
          a.knowledgeLabel && a.knowledgeLabel.includes("表内乘法"),
      ),
    ).toBe(true);

    // complete via phase 7
    const tQs = await (
      await app.request(
        `/api/v1/assignments/${asg.assignment.id}/questions`,
        { headers: auth(teacher.token) },
      )
    ).json();
    const answers = tQs.questions.map(
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

  it("rejects checkin without knowledge nodes", async () => {
    const teacher = await loginAs(app, "kt2", "teacher", "李老师");
    const q = await (
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
        body: JSON.stringify({ name: "空知识点", grade: 3 }),
      })
    ).json();
    const res = await app.request("/api/v1/assignments", {
      method: "POST",
      headers: auth(teacher.token),
      body: JSON.stringify({
        classId: cls.class.id,
        type: "knowledge_checkin",
        title: "无效",
        questionIds: [q.question.id],
        config: {},
      }),
    });
    expect(res.status).toBe(400);
  });
});
