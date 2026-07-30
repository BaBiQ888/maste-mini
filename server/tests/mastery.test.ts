import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/presentation/http/app.js";
import {
  openDatabase,
  type AppDatabase,
} from "../src/infrastructure/persistence/db.js";
import { MasteryService } from "../src/application/mastery/service.js";

async function testApp(): Promise<{
  app: ReturnType<typeof createApp>;
  db: AppDatabase;
}> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "math-mini-m-"));
  const db = await openDatabase(":memory:");
  const app = createApp(db, {
    wechat: { appId: "", appSecret: "", mock: true },
    dataDir,
  });
  return { app, db };
}

async function loginAs(
  app: ReturnType<typeof createApp>,
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

describe("Mastery S2 enqueue + S3 review", () => {
  let app: ReturnType<typeof createApp>;
  let db: AppDatabase;

  beforeEach(async () => {
    const t = await testApp();
    app = t.app;
    db = t.db;
  });

  async function setupWithKnowledge() {
    const teacher = await loginAs(app, "mt", "teacher", "王老师");
    const student = await loginAs(app, "ms", "student", "小明");

    const knId = "g3-u-addsub-k-add2";
    const q1 = await (
      await app.request("/api/v1/questions", {
        method: "POST",
        headers: auth(teacher.token),
        body: JSON.stringify({
          type: "fill_blank",
          stem: "5+6=",
          answer: "11",
          knowledgeNodeId: knId,
        }),
      })
    ).json();
    const q2 = await (
      await app.request("/api/v1/questions", {
        method: "POST",
        headers: auth(teacher.token),
        body: JSON.stringify({
          type: "fill_blank",
          stem: "7+8=",
          answer: "15",
          knowledgeNodeId: knId,
        }),
      })
    ).json();
    // bank extras for review generation
    await app.request("/api/v1/questions", {
      method: "POST",
      headers: auth(teacher.token),
      body: JSON.stringify({
        type: "fill_blank",
        stem: "9+1=",
        answer: "10",
        knowledgeNodeId: knId,
      }),
    });
    await app.request("/api/v1/questions", {
      method: "POST",
      headers: auth(teacher.token),
      body: JSON.stringify({
        type: "fill_blank",
        stem: "4+4=",
        answer: "8",
        knowledgeNodeId: knId,
      }),
    });

    const cls = await (
      await app.request("/api/v1/classes", {
        method: "POST",
        headers: auth(teacher.token),
        body: JSON.stringify({ name: "掌握班", grade: 3 }),
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
          questionIds: [q1.question.id, q2.question.id],
          config: { knowledgeNodeIds: [knId] },
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
      knId,
      classId: cls.class.id as string,
    };
  }

  async function wrongThenCorrect(
    studentToken: string,
    asgId: string,
    aqIds: string[],
  ) {
    const mine = await (
      await app.request(`/api/v1/assignments/${asgId}/my-submission`, {
        headers: auth(studentToken),
      })
    ).json();
    await app.request(`/api/v1/submissions/${mine.submission.id}/answers`, {
      method: "POST",
      headers: auth(studentToken),
      body: JSON.stringify({
        answers: [
          { assignmentQuestionId: aqIds[0], response: "10" },
          { assignmentQuestionId: aqIds[1], response: "15" },
        ],
      }),
    });
    await app.request(`/api/v1/submissions/${mine.submission.id}/correct`, {
      method: "POST",
      headers: auth(studentToken),
      body: JSON.stringify({
        answers: [{ assignmentQuestionId: aqIds[0], response: "11" }],
        wrongReasons: [
          { assignmentQuestionId: aqIds[0], reason: "careless" },
        ],
      }),
    });
    return mine.submission.id as string;
  }

  it("all correct does not enqueue", async () => {
    const { student, asg, aqIds } = await setupWithKnowledge();
    const mine = await (
      await app.request(`/api/v1/assignments/${asg.id}/my-submission`, {
        headers: auth(student.token),
      })
    ).json();
    await app.request(`/api/v1/submissions/${mine.submission.id}/answers`, {
      method: "POST",
      headers: auth(student.token),
      body: JSON.stringify({
        answers: [
          { assignmentQuestionId: aqIds[0], response: "11" },
          { assignmentQuestionId: aqIds[1], response: "15" },
        ],
      }),
    });
    const list = await (
      await app.request("/api/v1/me/mastery?status=open,due", {
        headers: auth(student.token),
      })
    ).json();
    expect(list.items).toEqual([]);
  });

  it("wrong then correct enqueues open item with review_at; wrong reason saved", async () => {
    const { student, asg, aqIds, knId } = await setupWithKnowledge();
    await wrongThenCorrect(student.token, asg.id, aqIds);

    const list = await (
      await app.request("/api/v1/me/mastery?status=open,due", {
        headers: auth(student.token),
      })
    ).json();
    expect(list.items.length).toBe(1);
    expect(list.items[0].status).toBe("open");
    expect(list.items[0].knowledgeNodeId).toBe(knId);
    expect(list.items[0].lastWrongReason).toBe("careless");
  });

  it("same knowledge merges miss_count", async () => {
    const { student, asg, aqIds, knId } = await setupWithKnowledge();
    const mine = await (
      await app.request(`/api/v1/assignments/${asg.id}/my-submission`, {
        headers: auth(student.token),
      })
    ).json();
    await app.request(`/api/v1/submissions/${mine.submission.id}/answers`, {
      method: "POST",
      headers: auth(student.token),
      body: JSON.stringify({
        answers: [
          { assignmentQuestionId: aqIds[0], response: "0" },
          { assignmentQuestionId: aqIds[1], response: "0" },
        ],
      }),
    });
    await app.request(`/api/v1/submissions/${mine.submission.id}/correct`, {
      method: "POST",
      headers: auth(student.token),
      body: JSON.stringify({
        answers: [
          { assignmentQuestionId: aqIds[0], response: "11" },
          { assignmentQuestionId: aqIds[1], response: "15" },
        ],
      }),
    });

    const list = await (
      await app.request("/api/v1/me/mastery?status=open,due", {
        headers: auth(student.token),
      })
    ).json();
    expect(list.items.length).toBe(1);
    expect(list.items[0].knowledgeNodeId).toBe(knId);
    expect(list.items[0].missCount).toBe(1);
  });

  it("multi-round correction enqueues all ever-wrong items", async () => {
    const { student, asg, aqIds, knId } = await setupWithKnowledge();
    const mine = await (
      await app.request(`/api/v1/assignments/${asg.id}/my-submission`, {
        headers: auth(student.token),
      })
    ).json();
    // both wrong
    await app.request(`/api/v1/submissions/${mine.submission.id}/answers`, {
      method: "POST",
      headers: auth(student.token),
      body: JSON.stringify({
        answers: [
          { assignmentQuestionId: aqIds[0], response: "0" },
          { assignmentQuestionId: aqIds[1], response: "0" },
        ],
      }),
    });
    // round 1: fix only first
    let sub = await (
      await app.request(`/api/v1/submissions/${mine.submission.id}/correct`, {
        method: "POST",
        headers: auth(student.token),
        body: JSON.stringify({
          answers: [{ assignmentQuestionId: aqIds[0], response: "11" }],
        }),
      })
    ).json();
    expect(sub.submission.status).toBe("pending_correction");
    // round 2: fix second → complete
    sub = await (
      await app.request(`/api/v1/submissions/${mine.submission.id}/correct`, {
        method: "POST",
        headers: auth(student.token),
        body: JSON.stringify({
          answers: [{ assignmentQuestionId: aqIds[1], response: "15" }],
        }),
      })
    ).json();
    expect(sub.submission.status).toBe("completed");

    const rows = await db.all<{
      knowledge_node_id: string | null;
      miss_count: number;
    }>(
      `SELECT knowledge_node_id, miss_count FROM mastery_items WHERE user_id = ?`,
      student.userId,
    );
    // same kn merges to one row; both questions had correction_round > 0
    expect(rows.length).toBe(1);
    expect(rows[0].knowledge_node_id).toBe(knId);
    expect(Number(rows[0].miss_count)).toBeGreaterThanOrEqual(1);
  });

  it("self-practice ensure does not create home due slot", async () => {
    const { student, knId } = await setupWithKnowledge();
    const sp = await (
      await app.request("/api/v1/me/mastery/self-practice", {
        method: "POST",
        headers: auth(student.token),
        body: JSON.stringify({ knowledgeNodeId: knId }),
      })
    ).json();
    expect(sp.review.source).toBe("self_practice");
    expect(sp.review.status).toBe("in_progress");

    const due = await (
      await app.request("/api/v1/me/mastery/due", {
        headers: auth(student.token),
      })
    ).json();
    expect(due.review).toBeNull();

    const row = (await db.get(
      `SELECT status, miss_count, review_at FROM mastery_items WHERE user_id = ?`,
      student.userId,
    )) as { status: string; miss_count: number; review_at: string };
    expect(row.status).toBe("open");
    expect(Number(row.miss_count)).toBe(0);
    // far future — not promotable
    expect(new Date(row.review_at).getTime()).toBeGreaterThan(Date.now());

    // map should not force half for scaffold (open miss 0, no completion)
    const mapRes = await (
      await app.request("/api/v1/me/mastery-map?grade=3", {
        headers: auth(student.token),
      })
    ).json();
    const node = mapRes.map.units
      .flatMap((u: { nodes: Array<{ knowledgeNodeId: string; state: string }> }) => u.nodes)
      .find((n: { knowledgeNodeId: string }) => n.knowledgeNodeId === knId);
    expect(node.state).not.toBe("half");
  });

  it("self-practice fail on scaffold does not schedule formal due", async () => {
    const { student, knId } = await setupWithKnowledge();
    const sp = await (
      await app.request("/api/v1/me/mastery/self-practice", {
        method: "POST",
        headers: auth(student.token),
        body: JSON.stringify({ knowledgeNodeId: knId }),
      })
    ).json();
    const wrongAnswers = sp.review.questions.map(
      (_: unknown, questionIndex: number) => ({
        questionIndex,
        response: "__wrong__",
      }),
    );
    await app.request(
      `/api/v1/me/mastery/reviews/${sp.review.id}/submit`,
      {
        method: "POST",
        headers: auth(student.token),
        body: JSON.stringify({ answers: wrongAnswers }),
      },
    );

    const due = await (
      await app.request("/api/v1/me/mastery/due", {
        headers: auth(student.token),
      })
    ).json();
    expect(due.review).toBeNull();

    const row = (await db.get(
      `SELECT status, miss_count, review_at FROM mastery_items WHERE user_id = ?`,
      student.userId,
    )) as { status: string; miss_count: number; review_at: string };
    expect(row.status).toBe("open");
    expect(Number(row.miss_count)).toBe(0);
    expect(new Date(row.review_at).getTime()).toBeGreaterThan(Date.now() + 86400000);
  });

  it("enqueue twice same knowledge stays one row; miss_count merges", async () => {
    const { student, asg, knId, classId } = await setupWithKnowledge();
    const mastery = new MasteryService(db);
    const miss = {
      knowledgeNodeId: knId,
      sourceQuestionId: null,
      stem: "5+6=",
      wrongReason: "careless" as const,
    };
    const input = {
      userId: student.userId,
      classId,
      assignmentId: asg.id as string,
      assignmentType: "knowledge_checkin",
      misses: [miss],
    };

    await mastery.enqueueAfterCorrection(input);
    await mastery.enqueueAfterCorrection(input);

    const rows = await db.all<{
      id: string;
      knowledge_node_id: string | null;
      miss_count: number;
    }>(`SELECT id, knowledge_node_id, miss_count FROM mastery_items WHERE user_id = ?`, student.userId);
    expect(rows.length).toBe(1);
    expect(rows[0].knowledge_node_id).toBe(knId);
    expect(Number(rows[0].miss_count)).toBe(2);
  });

  it("concurrent enqueue same knowledge stays one row (unique + race merge)", async () => {
    const { student, asg, knId, classId } = await setupWithKnowledge();
    const mastery = new MasteryService(db);
    const miss = {
      knowledgeNodeId: knId,
      sourceQuestionId: null,
      stem: "5+6=",
      wrongReason: "concept" as const,
    };
    const input = {
      userId: student.userId,
      classId,
      assignmentId: asg.id as string,
      assignmentType: "knowledge_checkin",
      misses: [miss],
    };

    await Promise.all([
      mastery.enqueueAfterCorrection(input),
      mastery.enqueueAfterCorrection(input),
    ]);

    const rows = await db.all<{
      id: string;
      miss_count: number;
    }>(`SELECT id, miss_count FROM mastery_items WHERE user_id = ?`, student.userId);
    expect(rows.length).toBe(1);
    // Both paths either insert+merge or double-merge → miss_count 2
    expect(Number(rows[0].miss_count)).toBe(2);
  });

  it("cap: merges of open rows leave room for one new key at openCount=19", async () => {
    const { student, asg, knId, classId } = await setupWithKnowledge();
    const mastery = new MasteryService(db);
    const base = {
      userId: student.userId,
      classId,
      assignmentId: asg.id as string,
      assignmentType: "knowledge_checkin" as const,
    };

    // 18 skill slots + 1 kn = 19 open
    for (let i = 0; i < 18; i++) {
      await mastery.enqueueAfterCorrection({
        ...base,
        misses: [
          {
            knowledgeNodeId: null,
            sourceQuestionId: null,
            stem: `seed-open-${i}`,
            wrongReason: "careless",
          },
        ],
      });
    }
    await mastery.enqueueAfterCorrection({
      ...base,
      misses: [
        {
          knowledgeNodeId: knId,
          sourceQuestionId: null,
          stem: "5+6=",
          wrongReason: "careless",
        },
      ],
    });

    // 15 merges of kn must not push newSlots over cap and block the next new insert
    for (let i = 0; i < 15; i++) {
      await mastery.enqueueAfterCorrection({
        ...base,
        misses: [
          {
            knowledgeNodeId: knId,
            sourceQuestionId: null,
            stem: "5+6=",
            wrongReason: "careless",
          },
        ],
      });
    }

    const fresh = await mastery.enqueueAfterCorrection({
      ...base,
      misses: [
        {
          knowledgeNodeId: null,
          sourceQuestionId: null,
          stem: "brand-new-at-19",
          wrongReason: "concept",
        },
      ],
    });
    expect(fresh.enqueued).toBe(1);
    const open = (await db.get(
      `SELECT COUNT(*) AS n FROM mastery_items
       WHERE user_id = ? AND (status = 'due' OR (status = 'open' AND miss_count > 0))`,
      student.userId,
    )) as { n: number };
    expect(Number(open.n)).toBe(20);
  });

  it("cap_reopen skip does not count as enqueued", async () => {
    const { student, asg, classId } = await setupWithKnowledge();
    const mastery = new MasteryService(db);
    const base = {
      userId: student.userId,
      classId,
      assignmentId: asg.id as string,
      assignmentType: "knowledge_checkin" as const,
    };

    // Fill cap with 20 open skill rows
    for (let i = 0; i < 20; i++) {
      await mastery.enqueueAfterCorrection({
        ...base,
        misses: [
          {
            knowledgeNodeId: null,
            sourceQuestionId: null,
            stem: `cap-full-${i}`,
            wrongReason: "careless",
          },
        ],
      });
    }

    // Passed row outside the queue — reopen must be blocked and enqueued stay 0
    const stem = "passed-reopen-target";
    const assignmentType = "knowledge_checkin";
    // Must match resolveMasteryKey: type is sliced to 16 chars
    const skillKey = (() => {
      let h = 0;
      for (let i = 0; i < stem.length; i++) {
        h = (Math.imul(31, h) + stem.charCodeAt(i)) | 0;
      }
      return `stem:${assignmentType.slice(0, 16)}:${(h >>> 0).toString(16)}`;
    })();
    const ts = new Date().toISOString();
    await db.run(
      `INSERT INTO mastery_items (
         id, user_id, class_id, knowledge_node_id, skill_key,
         status, miss_count, pass_count, review_at, last_result_at,
         last_wrong_reason, source_assignment_id, created_at, updated_at
       ) VALUES (?, ?, ?, NULL, ?, 'passed', 0, 1, ?, NULL, NULL, ?, ?, ?)`,
      `mst_pass_${Date.now()}`,
      student.userId,
      classId,
      skillKey,
      ts,
      asg.id,
      ts,
      ts,
    );

    const r = await mastery.enqueueAfterCorrection({
      ...base,
      misses: [
        {
          knowledgeNodeId: null,
          sourceQuestionId: null,
          stem,
          wrongReason: "concept",
        },
      ],
    });
    expect(r.enqueued).toBe(0);
    expect(r.skipped).toBe("cap_or_empty");
    const still = (await db.get(
      `SELECT status, miss_count FROM mastery_items WHERE skill_key = ?`,
      skillKey,
    )) as { status: string; miss_count: number };
    expect(still.status).toBe("passed");
    expect(Number(still.miss_count)).toBe(0);
  });

  it("merge into due keeps status due and does not push review_at", async () => {
    const { student, asg, knId, classId } = await setupWithKnowledge();
    const mastery = new MasteryService(db);
    const input = {
      userId: student.userId,
      classId,
      assignmentId: asg.id as string,
      assignmentType: "knowledge_checkin",
      misses: [
        {
          knowledgeNodeId: knId,
          sourceQuestionId: null,
          stem: "5+6=",
          wrongReason: "careless" as const,
        },
      ],
    };
    await mastery.enqueueAfterCorrection(input);
    const dueAt = "2020-01-01T00:00:00.000Z";
    await db.run(
      `UPDATE mastery_items SET status = 'due', review_at = ? WHERE user_id = ?`,
      dueAt,
      student.userId,
    );

    await mastery.enqueueAfterCorrection(input);

    const row = (await db.get(
      `SELECT status, review_at, miss_count FROM mastery_items WHERE user_id = ?`,
      student.userId,
    )) as { status: string; review_at: string; miss_count: number };
    expect(row.status).toBe("due");
    expect(row.review_at).toBe(dueAt);
    expect(Number(row.miss_count)).toBe(2);
  });

  it("merge into open+past review_at promotes/keeps due without +3d push", async () => {
    const { student, asg, knId, classId } = await setupWithKnowledge();
    const mastery = new MasteryService(db);
    const input = {
      userId: student.userId,
      classId,
      assignmentId: asg.id as string,
      assignmentType: "knowledge_checkin",
      misses: [
        {
          knowledgeNodeId: knId,
          sourceQuestionId: null,
          stem: "5+6=",
          wrongReason: "careless" as const,
        },
      ],
    };
    await mastery.enqueueAfterCorrection(input);
    const pastAt = "2020-06-01T00:00:00.000Z";
    // Simulate never-hit-home path: still open but already past review_at
    await db.run(
      `UPDATE mastery_items SET status = 'open', review_at = ? WHERE user_id = ?`,
      pastAt,
      student.userId,
    );

    await mastery.enqueueAfterCorrection(input);

    const row = (await db.get(
      `SELECT status, review_at, miss_count FROM mastery_items WHERE user_id = ?`,
      student.userId,
    )) as { status: string; review_at: string; miss_count: number };
    expect(row.status).toBe("due");
    // must not be pushed to a future +3d review_at
    expect(new Date(row.review_at).getTime()).toBeLessThanOrEqual(Date.now());
    expect(Number(row.miss_count)).toBe(2);
  });

  it("starting formal review abandons other-source in_progress session", async () => {
    const { student, asg, aqIds, knId } = await setupWithKnowledge();
    await wrongThenCorrect(student.token, asg.id, aqIds);

    // Self-practice while still open (before due)
    const sp = await (
      await app.request("/api/v1/me/mastery/self-practice", {
        method: "POST",
        headers: auth(student.token),
        body: JSON.stringify({ knowledgeNodeId: knId }),
      })
    ).json();
    const spId = sp.review.id as string;
    expect(sp.review.status).toBe("in_progress");
    expect(sp.review.source).toBe("self_practice");

    await db.run(
      `UPDATE mastery_items SET status = 'due', review_at = ? WHERE user_id = ?`,
      "2020-01-01T00:00:00.000Z",
      student.userId,
    );
    const item = (await db.get(
      `SELECT id FROM mastery_items WHERE user_id = ?`,
      student.userId,
    )) as { id: string };

    const formal = await (
      await app.request(`/api/v1/me/mastery/${item.id}/start-review`, {
        method: "POST",
        headers: auth(student.token),
        body: JSON.stringify({}),
      })
    ).json();
    expect(formal.review.status).toBe("in_progress");
    expect(formal.review.source).toBe("review");
    expect(formal.review.id).not.toBe(spId);

    const spRow = (await db.get(
      `SELECT status FROM mastery_reviews WHERE id = ?`,
      spId,
    )) as { status: string };
    expect(spRow.status).toBe("abandoned");

    const live = (await db.get(
      `SELECT COUNT(*) AS n FROM mastery_reviews
       WHERE mastery_item_id = ? AND status = 'in_progress'`,
      item.id,
    )) as { n: number };
    expect(Number(live.n)).toBe(1);
  });

  it("historical review questions are kn-scoped (not starved by other topics)", async () => {
    const { student, asg, aqIds, knId } = await setupWithKnowledge();
    await wrongThenCorrect(student.token, asg.id, aqIds);
    const mastery = new MasteryService(db);

    const knB = "g4-u-int-k-add";
    const ts = new Date().toISOString();
    const clsRow = (await db.get(
      `SELECT class_id FROM assignments WHERE id = ?`,
      asg.id,
    )) as { class_id: string };
    // Separate assignment: unique (assignment_id, student_id) on submissions
    const asgHist = `asg_hist_${Date.now()}`;
    await db.run(
      `INSERT INTO assignments (
         id, class_id, type, title, description, status, due_at, config_json,
         created_by, created_at, published_at, updated_at
       ) VALUES (?, ?, 'daily_drill', 'hist', NULL, 'published', NULL, '{}',
         ?, ?, ?, ?)`,
      asgHist,
      clsRow.class_id,
      student.userId,
      ts,
      ts,
      ts,
    );
    const subId = `sub_hist_${Date.now()}`;
    await db.run(
      `INSERT INTO submissions (
         id, assignment_id, student_id, status, overdue, score,
         created_at, updated_at, submitted_at, timer_started_at
       ) VALUES (?, ?, ?, 'completed', 0, 0, ?, ?, ?, NULL)`,
      subId,
      asgHist,
      student.userId,
      ts,
      ts,
      ts,
    );
    // 50 wrongs on kn B + 2 wrongs on kn A under one submission
    for (let i = 0; i < 52; i++) {
      const isA = i >= 50;
      const kn = isA ? knId : knB;
      const stem = isA ? `UNIQUE_A_HIST_${i}` : `OTHER_B_HIST_${i}`;
      const aqId = `aq_hist_${i}`;
      const aiId = `ai_hist_${i}`;
      const snap = JSON.stringify({
        type: "fill_blank",
        stem,
        options: null,
        answer: "1",
        explanation: null,
        knowledgeNodeId: kn,
        source: "bank",
        id: `q_hist_${i}`,
      });
      await db.run(
        `INSERT INTO assignment_questions (
           id, assignment_id, sort_order, source_question_id, question_snapshot, created_at
         ) VALUES (?, ?, ?, NULL, ?, ?)`,
        aqId,
        asgHist,
        i,
        snap,
        ts,
      );
      await db.run(
        `INSERT INTO answer_items (
           id, submission_id, assignment_question_id, response_json,
           is_correct, correction_round, wrong_reason, updated_at
         ) VALUES (?, ?, ?, ?, 0, 0, 'careless', ?)`,
        aiId,
        subId,
        aqId,
        JSON.stringify("x"),
        ts,
      );
    }

    await db.run(
      `UPDATE mastery_items SET status = 'due', review_at = ? WHERE user_id = ?`,
      "2020-01-01T00:00:00.000Z",
      student.userId,
    );
    const item = (await db.get(
      `SELECT * FROM mastery_items WHERE user_id = ?`,
      student.userId,
    )) as Record<string, unknown>;
    const review = await mastery.startReview(
      student.userId,
      String(item.id),
      "review",
    );
    const stems = review.questions.map((q) => q.stem || "");
    for (const s of stems) {
      expect(s.includes("OTHER_B_HIST")).toBe(false);
    }
    const hasA = stems.some((s) => s.includes("UNIQUE_A_HIST"));
    expect(hasA).toBe(true);
  });

  it("abandoned review submit returns REVIEW_ABANDONED", async () => {
    const { student, asg, aqIds } = await setupWithKnowledge();
    await wrongThenCorrect(student.token, asg.id, aqIds);
    await db.run(
      `UPDATE mastery_items SET review_at = ? WHERE user_id = ?`,
      "2020-01-01T00:00:00.000Z",
      student.userId,
    );
    const start = await (
      await app.request(`/api/v1/me/mastery/due`, {
        headers: auth(student.token),
      })
    ).json();
    const itemId = start.review.masteryItemId as string;
    const first = await (
      await app.request(`/api/v1/me/mastery/${itemId}/start-review`, {
        method: "POST",
        headers: auth(student.token),
        body: JSON.stringify({}),
      })
    ).json();
    const abandonedId = first.review.id as string;
    // Simulate concurrent race orphan (abandon path before second insert)
    await db.run(
      `UPDATE mastery_reviews SET status = 'abandoned', completed_at = ? WHERE id = ?`,
      new Date().toISOString(),
      abandonedId,
    );
    const bad = await app.request(
      `/api/v1/me/mastery/reviews/${abandonedId}/submit`,
      {
        method: "POST",
        headers: auth(student.token),
        body: JSON.stringify({
          answers: [
            { questionIndex: 0, response: "1" },
            { questionIndex: 1, response: "1" },
            { questionIndex: 2, response: "1" },
          ],
        }),
      },
    );
    expect(bad.status).toBe(400);
    const body = await bad.json();
    expect(body.code).toBe("REVIEW_ABANDONED");
  });

  it("photo homework does not create mastery", async () => {
    const teacher = await loginAs(app, "pt", "teacher", "李老师");
    const student = await loginAs(app, "ps", "student", "小红");
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
          title: "拍本",
          publish: true,
        }),
      })
    ).json();
    const mine = await (
      await app.request(`/api/v1/assignments/${asg.assignment.id}/my-submission`, {
        headers: auth(student.token),
      })
    ).json();
    await app.request(`/api/v1/submissions/${mine.submission.id}/photos`, {
      method: "POST",
      headers: auth(student.token),
      body: JSON.stringify({
        photoUrls: ["https://example.com/a.jpg"],
      }),
    });
    await app.request(`/api/v1/submissions/${mine.submission.id}/grade`, {
      method: "POST",
      headers: auth(teacher.token),
      body: JSON.stringify({ result: "correct", score: 100 }),
    });
    const list = await (
      await app.request("/api/v1/me/mastery", {
        headers: auth(student.token),
      })
    ).json();
    expect(list.items.length).toBe(0);
  });

  it("S3: past review_at promotes to due; start + pass → passed", async () => {
    const { student, asg, aqIds } = await setupWithKnowledge();
    await wrongThenCorrect(student.token, asg.id, aqIds);

    await db.run(
      `UPDATE mastery_items SET review_at = ? WHERE user_id = ?`,
      "2020-01-01T00:00:00.000Z",
      student.userId,
    );

    const due = await (
      await app.request("/api/v1/me/mastery/due", {
        headers: auth(student.token),
      })
    ).json();
    expect(due.review).toBeTruthy();
    expect(due.review.masteryItemId).toBeTruthy();

    const started = await (
      await app.request(
        `/api/v1/me/mastery/${due.review.masteryItemId}/start-review`,
        {
          method: "POST",
          headers: auth(student.token),
          body: "{}",
        },
      )
    ).json();
    expect(started.review.status).toBe("in_progress");
    expect(started.review.questions.length).toBeGreaterThanOrEqual(1);
    // must not create assignments
    const asgCount = (await db.get(
      `SELECT COUNT(*) AS n FROM assignments`,
    )) as { n: number };
    expect(Number(asgCount.n)).toBe(1);

    const answers = started.review.questions.map(
      (q: { index: number; stem: string }, i: number) => {
        // grade from bank stems we know; else leave wrong for fail path tests
        const known: Record<string, string> = {
          "5+6=": "11",
          "7+8=": "15",
          "9+1=": "10",
          "4+4=": "8",
        };
        const ans = known[q.stem];
        return {
          questionIndex: q.index ?? i,
          response: ans != null ? ans : "0",
        };
      },
    );

    // force pass by answering correctly when possible; for generated drills parse
    const reviewRow = (await db.get(
      `SELECT question_snapshots_json FROM mastery_reviews WHERE id = ?`,
      started.review.id,
    )) as { question_snapshots_json: string };
    const snaps = JSON.parse(reviewRow.question_snapshots_json) as Array<{
      answer: string | boolean;
    }>;
    const correctAnswers = snaps.map((s, questionIndex) => ({
      questionIndex,
      response: s.answer,
    }));

    const submitted = await (
      await app.request(
        `/api/v1/me/mastery/reviews/${started.review.id}/submit`,
        {
          method: "POST",
          headers: auth(student.token),
          body: JSON.stringify({ answers: correctAnswers }),
        },
      )
    ).json();
    expect(submitted.review.status).toBe("completed");
    expect(submitted.review.passed).toBe(true);

    const list = await (
      await app.request("/api/v1/me/mastery?status=open,due", {
        headers: auth(student.token),
      })
    ).json();
    expect(list.items.length).toBe(0);

    const passedList = await (
      await app.request("/api/v1/me/mastery?status=passed", {
        headers: auth(student.token),
      })
    ).json();
    expect(passedList.items.length).toBe(1);
    // assignments count unchanged
    const asgCount2 = (await db.get(
      `SELECT COUNT(*) AS n FROM assignments`,
    )) as { n: number };
    expect(Number(asgCount2.n)).toBe(1);
  });

  it("S4: mastery-map returns units and states; self-practice starts review", async () => {
    const { student, asg, aqIds, knId } = await setupWithKnowledge();
    await wrongThenCorrect(student.token, asg.id, aqIds);

    const mapRes = await (
      await app.request("/api/v1/me/mastery-map?grade=3", {
        headers: auth(student.token),
      })
    ).json();
    expect(mapRes.map.grade).toBe(3);
    expect(mapRes.map.units.length).toBeGreaterThan(0);
    expect(Array.isArray(mapRes.map.stamps)).toBe(true);
    const allNodes = mapRes.map.units.flatMap(
      (u: { nodes: Array<{ knowledgeNodeId: string; state: string }> }) =>
        u.nodes,
    );
    const node = allNodes.find(
      (n: { knowledgeNodeId: string }) => n.knowledgeNodeId === knId,
    );
    expect(node).toBeTruthy();
    // open mastery after wrong→correct → half
    expect(node.state).toBe("half");
    expect(mapRes.map.summary.half).toBeGreaterThanOrEqual(1);

    const sp = await (
      await app.request("/api/v1/me/mastery/self-practice", {
        method: "POST",
        headers: auth(student.token),
        body: JSON.stringify({ knowledgeNodeId: knId }),
      })
    ).json();
    expect(sp.review.source).toBe("self_practice");
    expect(sp.review.questions.length).toBeGreaterThanOrEqual(1);
    expect(sp.review.questions.length).toBeLessThanOrEqual(5);
    // no new assignment
    const asgCount = (await db.get(
      `SELECT COUNT(*) AS n FROM assignments`,
    )) as { n: number };
    expect(Number(asgCount.n)).toBe(1);
  });

  it("S5: week-summary returns copyText and counts", async () => {
    const { student, asg, aqIds } = await setupWithKnowledge();
    await wrongThenCorrect(student.token, asg.id, aqIds);

    const res = await (
      await app.request("/api/v1/me/mastery/week-summary", {
        headers: auth(student.token),
      })
    ).json();
    expect(res.summary.weekLabel).toBeTruthy();
    expect(res.summary.completedTaskCount).toBeGreaterThanOrEqual(1);
    expect(res.summary.litDays).toBeGreaterThanOrEqual(1);
    expect(res.summary.copyText).toContain("算本本周小结");
    expect(Array.isArray(res.summary.bullets)).toBe(true);
    expect(res.summary.bullets.length).toBeGreaterThanOrEqual(2);
  });

  it("S3: review fail → open again with new review_at", async () => {
    const { student, asg, aqIds } = await setupWithKnowledge();
    await wrongThenCorrect(student.token, asg.id, aqIds);
    await db.run(
      `UPDATE mastery_items SET review_at = ? WHERE user_id = ?`,
      "2020-01-01T00:00:00.000Z",
      student.userId,
    );

    const due = await (
      await app.request("/api/v1/me/mastery/due", {
        headers: auth(student.token),
      })
    ).json();
    const started = await (
      await app.request(
        `/api/v1/me/mastery/${due.review.masteryItemId}/start-review`,
        {
          method: "POST",
          headers: auth(student.token),
          body: "{}",
        },
      )
    ).json();

    const wrongAnswers = started.review.questions.map(
      (_: unknown, questionIndex: number) => ({
        questionIndex,
        response: "__wrong__",
      }),
    );
    const submitted = await (
      await app.request(
        `/api/v1/me/mastery/reviews/${started.review.id}/submit`,
        {
          method: "POST",
          headers: auth(student.token),
          body: JSON.stringify({ answers: wrongAnswers }),
        },
      )
    ).json();
    expect(submitted.review.passed).toBe(false);

    const list = await (
      await app.request("/api/v1/me/mastery?status=open,due", {
        headers: auth(student.token),
      })
    ).json();
    expect(list.items.length).toBe(1);
    expect(list.items[0].status).toBe("open");
    expect(new Date(list.items[0].reviewAt).getTime()).toBeGreaterThan(
      Date.now() - 1000,
    );
  });
});
