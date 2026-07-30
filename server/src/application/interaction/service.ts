/**
 * Light teacher ↔ student interactions: stamps, stuck reports, class focus,
 * notes, week shares, wrong-reason board, top-wrongs, layered nudge.
 */
import type { AppDatabase } from "../../infrastructure/persistence/db.js";
import { createId, nowIso } from "../../infrastructure/persistence/db.js";
import { AppError } from "../../domain/shared/errors.js";
import { KnowledgeTreeService } from "../knowledge/service.js";
import { ProgressService } from "../progress/service.js";

export const STAMP_TYPES = [
  "careful",
  "progress",
  "retry",
  "passed",
] as const;
export type StampType = (typeof STAMP_TYPES)[number];

const STAMP_LABEL: Record<StampType, string> = {
  careful: "认真",
  progress: "进步",
  retry: "再练一遍",
  passed: "已过关",
};

export class InteractionService {
  private knowledge = new KnowledgeTreeService();

  constructor(
    private db: AppDatabase,
    private progress: ProgressService,
  ) {}

  private async assertTeacherOwnsClass(
    classId: string,
    teacherId: string,
  ): Promise<void> {
    const row = (await this.db.get(
      `SELECT teacher_id FROM classes WHERE id = ?`,
      classId,
    )) as { teacher_id: string } | undefined;
    if (!row) throw new AppError("NOT_FOUND", "班级不存在", 404);
    if (row.teacher_id !== teacherId) {
      throw new AppError("FORBIDDEN", "无权操作该班级", 403);
    }
  }

  private async assertStudentInClass(
    classId: string,
    studentId: string,
  ): Promise<void> {
    const m = await this.db.get(
      `SELECT 1 FROM class_memberships
       WHERE class_id = ? AND user_id = ? AND LOWER(role) = 'student'`,
      classId,
      studentId,
    );
    if (!m) throw new AppError("FORBIDDEN", "你不在该班级", 403);
  }

  // ── Stamps ─────────────────────────────────────────────────────────────

  async stampSubmission(
    teacherId: string,
    submissionId: string,
    stampType: StampType,
    note?: string,
  ): Promise<Record<string, unknown>> {
    if (!STAMP_TYPES.includes(stampType)) {
      throw new AppError("INVALID_STAMP", "印章类型无效", 400);
    }
    const sub = (await this.db.get(
      `SELECT s.*, a.class_id, a.id AS assignment_id, c.teacher_id
       FROM submissions s
       JOIN assignments a ON a.id = s.assignment_id
       JOIN classes c ON c.id = a.class_id
       WHERE s.id = ?`,
      submissionId,
    )) as
      | {
          id: string;
          student_id: string;
          assignment_id: string;
          class_id: string;
          teacher_id: string;
        }
      | undefined;
    if (!sub) throw new AppError("NOT_FOUND", "提交不存在", 404);
    if (sub.teacher_id !== teacherId) {
      throw new AppError("FORBIDDEN", "无权盖章", 403);
    }
    const id = createId("stp");
    const ts = nowIso();
    await this.db.run(
      `INSERT INTO interaction_stamps (
         id, class_id, assignment_id, submission_id, student_id, teacher_id,
         stamp_type, note, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      sub.class_id,
      sub.assignment_id,
      submissionId,
      sub.student_id,
      teacherId,
      stampType,
      (note || "").trim().slice(0, 200) || null,
      ts,
    );
    console.info("[interaction.stamp]", {
      id,
      submissionId,
      stampType,
      studentId: sub.student_id,
    });
    return {
      id,
      stampType,
      label: STAMP_LABEL[stampType],
      note: note || null,
      createdAt: ts,
    };
  }

  async listStampsForStudent(
    studentId: string,
    limit = 20,
  ): Promise<Array<Record<string, unknown>>> {
    const n = Math.min(Math.max(limit, 1), 50);
    const rows = (await this.db.all(
      `SELECT s.*, a.title AS assignment_title, c.name AS class_name
       FROM interaction_stamps s
       LEFT JOIN assignments a ON a.id = s.assignment_id
       LEFT JOIN classes c ON c.id = s.class_id
       WHERE s.student_id = ?
       ORDER BY s.created_at DESC
       LIMIT ${n}`,
      studentId,
    )) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id,
      stampType: r.stamp_type,
      label: STAMP_LABEL[r.stamp_type as StampType] || String(r.stamp_type),
      note: r.note,
      assignmentTitle: r.assignment_title,
      className: r.class_name,
      createdAt: r.created_at,
    }));
  }

  async listStampsForSubmission(
    submissionId: string,
    callerId: string,
  ): Promise<Array<Record<string, unknown>>> {
    const sub = (await this.db.get(
      `SELECT s.student_id, c.teacher_id
       FROM submissions s
       JOIN assignments a ON a.id = s.assignment_id
       JOIN classes c ON c.id = a.class_id
       WHERE s.id = ?`,
      submissionId,
    )) as { student_id: string; teacher_id: string } | undefined;
    if (!sub) throw new AppError("NOT_FOUND", "提交不存在", 404);
    if (sub.student_id !== callerId && sub.teacher_id !== callerId) {
      throw new AppError("FORBIDDEN", "无权查看印章", 403);
    }
    const rows = (await this.db.all(
      `SELECT * FROM interaction_stamps
       WHERE submission_id = ?
       ORDER BY created_at DESC`,
      submissionId,
    )) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id,
      stampType: r.stamp_type,
      label: STAMP_LABEL[r.stamp_type as StampType] || String(r.stamp_type),
      note: r.note,
      createdAt: r.created_at,
    }));
  }

  // ── Stuck reports ──────────────────────────────────────────────────────

  async reportStuck(
    studentId: string,
    input: {
      submissionId: string;
      assignmentQuestionId?: string | null;
      note?: string | null;
    },
  ): Promise<Record<string, unknown>> {
    const sub = (await this.db.get(
      `SELECT s.*, a.class_id, a.id AS aid, a.config_json
       FROM submissions s
       JOIN assignments a ON a.id = s.assignment_id
       WHERE s.id = ? AND s.student_id = ?`,
      input.submissionId,
      studentId,
    )) as
      | {
          id: string;
          student_id: string;
          class_id: string;
          aid: string;
          config_json: string;
        }
      | undefined;
    if (!sub) throw new AppError("NOT_FOUND", "提交不存在", 404);

    let allow = true;
    try {
      const cfg = JSON.parse(sub.config_json || "{}") as {
        allowStuckReport?: boolean;
      };
      if (cfg.allowStuckReport === false) allow = false;
    } catch {
      /* default allow */
    }
    if (!allow) {
      throw new AppError("DISABLED", "老师未开启「不会」上报", 400);
    }

    let stem: string | null = null;
    let knId: string | null = null;
    let aqId: string | null = null;
    if (input.assignmentQuestionId) {
      const aq = (await this.db.get(
        `SELECT question_snapshot FROM assignment_questions
         WHERE id = ? AND assignment_id = ?`,
        input.assignmentQuestionId,
        sub.aid,
      )) as { question_snapshot: string } | undefined;
      if (!aq) {
        throw new AppError("INVALID_QUESTION", "题目不属于该作业", 400);
      }
      aqId = input.assignmentQuestionId;
      try {
        const snap = JSON.parse(aq.question_snapshot) as {
          stem?: string;
          knowledgeNodeId?: string;
        };
        stem = snap.stem || null;
        knId = snap.knowledgeNodeId || null;
      } catch {
        /* ignore */
      }
    }

    const id = createId("stk");
    const ts = nowIso();
    await this.db.run(
      `INSERT INTO stuck_reports (
         id, class_id, assignment_id, submission_id, assignment_question_id,
         student_id, stem, knowledge_node_id, note, status, teacher_reply,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', NULL, ?, ?)`,
      id,
      sub.class_id,
      sub.aid,
      sub.id,
      aqId,
      studentId,
      stem,
      knId,
      (input.note || "").trim().slice(0, 300) || null,
      ts,
      ts,
    );
    console.info("[interaction.stuck.report]", {
      id,
      studentId,
      assignmentId: sub.aid,
    });
    return { id, status: "open", createdAt: ts };
  }

  async listStuckForClass(
    classId: string,
    teacherId: string,
    status?: string,
  ): Promise<Array<Record<string, unknown>>> {
    await this.assertTeacherOwnsClass(classId, teacherId);
    const st = status === "open" || status === "resolved" ? status : null;
    const rows = st
      ? ((await this.db.all(
          `SELECT r.*, u.nickname, a.title AS assignment_title
           FROM stuck_reports r
           JOIN users u ON u.id = r.student_id
           JOIN assignments a ON a.id = r.assignment_id
           WHERE r.class_id = ? AND r.status = ?
           ORDER BY r.created_at DESC
           LIMIT 100`,
          classId,
          st,
        )) as Array<Record<string, unknown>>)
      : ((await this.db.all(
          `SELECT r.*, u.nickname, a.title AS assignment_title
           FROM stuck_reports r
           JOIN users u ON u.id = r.student_id
           JOIN assignments a ON a.id = r.assignment_id
           WHERE r.class_id = ?
           ORDER BY CASE r.status WHEN 'open' THEN 0 ELSE 1 END, r.created_at DESC
           LIMIT 100`,
          classId,
        )) as Array<Record<string, unknown>>);
    return rows.map((r) => this.mapStuck(r));
  }

  async replyStuck(
    teacherId: string,
    reportId: string,
    reply: string,
    resolve = true,
  ): Promise<Record<string, unknown>> {
    const row = (await this.db.get(
      `SELECT r.*, c.teacher_id
       FROM stuck_reports r
       JOIN classes c ON c.id = r.class_id
       WHERE r.id = ?`,
      reportId,
    )) as (Record<string, unknown> & { teacher_id: string }) | undefined;
    if (!row) throw new AppError("NOT_FOUND", "上报不存在", 404);
    if (row.teacher_id !== teacherId) {
      throw new AppError("FORBIDDEN", "无权处理", 403);
    }
    const ts = nowIso();
    const status = resolve ? "resolved" : "open";
    await this.db.run(
      `UPDATE stuck_reports
       SET teacher_reply = ?, status = ?, updated_at = ?
       WHERE id = ?`,
      (reply || "").trim().slice(0, 500) || null,
      status,
      ts,
      reportId,
    );
    console.info("[interaction.stuck.reply]", { reportId, status });
    const again = (await this.db.get(
      `SELECT r.*, u.nickname, a.title AS assignment_title
       FROM stuck_reports r
       JOIN users u ON u.id = r.student_id
       JOIN assignments a ON a.id = r.assignment_id
       WHERE r.id = ?`,
      reportId,
    )) as Record<string, unknown>;
    return this.mapStuck(again);
  }

  /** Student inbox: own stuck reports (with teacher replies when present). */
  async listStuckForStudent(
    studentId: string,
    limit = 30,
  ): Promise<Array<Record<string, unknown>>> {
    const n = Math.min(Math.max(limit, 1), 50);
    const rows = (await this.db.all(
      `SELECT r.*, a.title AS assignment_title, u.nickname
       FROM stuck_reports r
       JOIN assignments a ON a.id = r.assignment_id
       JOIN users u ON u.id = r.student_id
       WHERE r.student_id = ?
       ORDER BY r.updated_at DESC
       LIMIT ${n}`,
      studentId,
    )) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapStuck(r));
  }

  private mapStuck(r: Record<string, unknown>) {
    return {
      id: r.id,
      classId: r.class_id,
      assignmentId: r.assignment_id,
      assignmentTitle: r.assignment_title,
      submissionId: r.submission_id,
      assignmentQuestionId: r.assignment_question_id,
      studentId: r.student_id,
      studentNickname: r.nickname,
      stem: r.stem,
      knowledgeNodeId: r.knowledge_node_id,
      note: r.note,
      status: r.status,
      teacherReply: r.teacher_reply,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  // ── Class focus ────────────────────────────────────────────────────────

  async setClassFocus(
    teacherId: string,
    classId: string,
    input: { knowledgeNodeId?: string | null; label: string; note?: string },
  ): Promise<Record<string, unknown>> {
    await this.assertTeacherOwnsClass(classId, teacherId);
    const label = (input.label || "").trim().slice(0, 80);
    if (!label) throw new AppError("INVALID_LABEL", "请填写焦点内容", 400);
    let knId = (input.knowledgeNodeId || "").trim() || null;
    if (knId && !this.knowledge.getById(knId)) {
      knId = null;
    }
    const ts = nowIso();
    const existing = await this.db.get(
      `SELECT class_id FROM class_focus WHERE class_id = ?`,
      classId,
    );
    if (existing) {
      await this.db.run(
        `UPDATE class_focus
         SET knowledge_node_id = ?, label = ?, note = ?, set_by = ?, updated_at = ?
         WHERE class_id = ?`,
        knId,
        label,
        (input.note || "").trim().slice(0, 300) || null,
        teacherId,
        ts,
        classId,
      );
    } else {
      await this.db.run(
        `INSERT INTO class_focus (
           class_id, knowledge_node_id, label, note, set_by, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
        classId,
        knId,
        label,
        (input.note || "").trim().slice(0, 300) || null,
        teacherId,
        ts,
      );
    }
    console.info("[interaction.focus.set]", { classId, label });
    const focus = await this.getClassFocus(classId);
    return focus || { classId, label, knowledgeNodeId: null, note: null };
  }

  async getClassFocus(
    classId: string,
    callerId?: string,
  ): Promise<Record<string, unknown> | null> {
    if (callerId) {
      const ok = (await this.db.get(
        `SELECT 1 AS ok FROM classes c
         LEFT JOIN class_memberships m
           ON m.class_id = c.id AND m.user_id = ?
         WHERE c.id = ?
           AND (c.teacher_id = ? OR m.user_id IS NOT NULL)`,
        callerId,
        classId,
        callerId,
      )) as { ok: number } | undefined;
      if (!ok) throw new AppError("FORBIDDEN", "无权查看该班级焦点", 403);
    }
    const row = (await this.db.get(
      `SELECT * FROM class_focus WHERE class_id = ?`,
      classId,
    )) as Record<string, unknown> | undefined;
    if (!row) return null;
    let knName: string | null = null;
    if (row.knowledge_node_id) {
      const n = this.knowledge.getById(String(row.knowledge_node_id));
      knName = n?.name || null;
    }
    return {
      classId: row.class_id,
      knowledgeNodeId: row.knowledge_node_id,
      knowledgeName: knName,
      label: row.label,
      note: row.note,
      updatedAt: row.updated_at,
    };
  }

  async listFocusForStudent(studentId: string): Promise<Array<Record<string, unknown>>> {
    const rows = (await this.db.all(
      `SELECT f.*, c.name AS class_name
       FROM class_focus f
       JOIN class_memberships m ON m.class_id = f.class_id AND m.user_id = ?
       JOIN classes c ON c.id = f.class_id
       WHERE c.archived = 0 AND LOWER(m.role) = 'student'
       ORDER BY f.updated_at DESC`,
      studentId,
    )) as Array<Record<string, unknown>>;
    return rows.map((row) => {
      let knName: string | null = null;
      if (row.knowledge_node_id) {
        const n = this.knowledge.getById(String(row.knowledge_node_id));
        knName = n?.name || null;
      }
      return {
        classId: row.class_id,
        className: row.class_name,
        knowledgeNodeId: row.knowledge_node_id,
        knowledgeName: knName,
        label: row.label,
        note: row.note,
        updatedAt: row.updated_at,
      };
    });
  }

  // ── Class notes (小纸条) ───────────────────────────────────────────────

  async sendNote(
    teacherId: string,
    classId: string,
    input: { body: string; studentId?: string | null; kind?: string },
  ): Promise<Record<string, unknown>> {
    await this.assertTeacherOwnsClass(classId, teacherId);
    const body = (input.body || "").trim().slice(0, 500);
    if (!body) throw new AppError("INVALID_BODY", "请填写内容", 400);
    if (input.studentId) {
      await this.assertStudentInClass(classId, input.studentId);
    }
    const id = createId("nte");
    const ts = nowIso();
    await this.db.run(
      `INSERT INTO class_notes (
         id, class_id, teacher_id, student_id, body, kind, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id,
      classId,
      teacherId,
      input.studentId || null,
      body,
      (input.kind || "note").slice(0, 32),
      ts,
    );
    console.info("[interaction.note]", {
      id,
      classId,
      studentId: input.studentId || null,
    });
    return {
      id,
      classId,
      studentId: input.studentId || null,
      body,
      kind: input.kind || "note",
      createdAt: ts,
    };
  }

  async listNotesForStudent(
    studentId: string,
    limit = 30,
  ): Promise<Array<Record<string, unknown>>> {
    const n = Math.min(Math.max(limit, 1), 50);
    const rows = (await this.db.all(
      `SELECT n.*, c.name AS class_name
       FROM class_notes n
       JOIN classes c ON c.id = n.class_id
       WHERE n.student_id = ? OR (
         n.student_id IS NULL AND n.class_id IN (
           SELECT class_id FROM class_memberships WHERE user_id = ?
         )
       )
       ORDER BY n.created_at DESC
       LIMIT ${n}`,
      studentId,
      studentId,
    )) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id,
      classId: r.class_id,
      className: r.class_name,
      body: r.body,
      kind: r.kind,
      broadcast: !r.student_id,
      createdAt: r.created_at,
    }));
  }

  // ── Week share ─────────────────────────────────────────────────────────

  async shareWeekSummary(
    studentId: string,
    input: {
      classId: string;
      weekLabel: string;
      copyText: string;
      payload?: Record<string, unknown>;
    },
  ): Promise<Record<string, unknown>> {
    await this.assertStudentInClass(input.classId, studentId);
    const id = createId("wsh");
    const ts = nowIso();
    await this.db.run(
      `INSERT INTO week_shares (
         id, class_id, student_id, week_label, copy_text, payload_json,
         teacher_reply, created_at, replied_at
       ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL)`,
      id,
      input.classId,
      studentId,
      (input.weekLabel || "").slice(0, 80) || "本周",
      (input.copyText || "").slice(0, 2000),
      JSON.stringify(input.payload || {}),
      ts,
    );
    console.info("[interaction.weekShare]", { id, studentId });
    return { id, createdAt: ts };
  }

  async listWeekShares(
    classId: string,
    teacherId: string,
  ): Promise<Array<Record<string, unknown>>> {
    await this.assertTeacherOwnsClass(classId, teacherId);
    const rows = (await this.db.all(
      `SELECT w.*, u.nickname
       FROM week_shares w
       JOIN users u ON u.id = w.student_id
       WHERE w.class_id = ?
       ORDER BY w.created_at DESC
       LIMIT 50`,
      classId,
    )) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id,
      studentId: r.student_id,
      studentNickname: r.nickname,
      weekLabel: r.week_label,
      copyText: r.copy_text,
      teacherReply: r.teacher_reply,
      createdAt: r.created_at,
      repliedAt: r.replied_at,
    }));
  }

  async replyWeekShare(
    teacherId: string,
    shareId: string,
    reply: string,
  ): Promise<Record<string, unknown>> {
    const row = (await this.db.get(
      `SELECT w.*, c.teacher_id
       FROM week_shares w
       JOIN classes c ON c.id = w.class_id
       WHERE w.id = ?`,
      shareId,
    )) as (Record<string, unknown> & { teacher_id: string }) | undefined;
    if (!row) throw new AppError("NOT_FOUND", "小结不存在", 404);
    if (row.teacher_id !== teacherId) {
      throw new AppError("FORBIDDEN", "无权回复", 403);
    }
    const ts = nowIso();
    const text = (reply || "").trim().slice(0, 500);
    if (!text) throw new AppError("INVALID_BODY", "请填写回复", 400);
    await this.db.run(
      `UPDATE week_shares SET teacher_reply = ?, replied_at = ? WHERE id = ?`,
      text,
      ts,
      shareId,
    );
    console.info("[interaction.weekShare.reply]", { shareId });
    return {
      id: shareId,
      teacherReply: text,
      repliedAt: ts,
    };
  }

  async listMyWeekShareReplies(
    studentId: string,
  ): Promise<Array<Record<string, unknown>>> {
    const rows = (await this.db.all(
      `SELECT w.*, c.name AS class_name
       FROM week_shares w
       JOIN classes c ON c.id = w.class_id
       WHERE w.student_id = ? AND w.teacher_reply IS NOT NULL
       ORDER BY w.replied_at DESC
       LIMIT 20`,
      studentId,
    )) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id,
      className: r.class_name,
      weekLabel: r.week_label,
      teacherReply: r.teacher_reply,
      repliedAt: r.replied_at,
    }));
  }

  // ── Wrong reason board + top wrongs ────────────────────────────────────

  async wrongReasonStats(
    classId: string,
    teacherId: string,
    days = 14,
  ): Promise<{ reasons: Array<{ reason: string; count: number }> }> {
    await this.assertTeacherOwnsClass(classId, teacherId);
    const since = new Date(
      Date.now() - Math.min(Math.max(days, 1), 90) * 86_400_000,
    ).toISOString();
    const rows = (await this.db.all(
      `SELECT ai.wrong_reason AS reason, COUNT(*) AS c
       FROM answer_items ai
       JOIN submissions s ON s.id = ai.submission_id
       JOIN assignments a ON a.id = s.assignment_id
       WHERE a.class_id = ?
         AND ai.wrong_reason IS NOT NULL
         AND ai.wrong_reason != ''
         AND ai.updated_at >= ?
       GROUP BY ai.wrong_reason
       ORDER BY c DESC`,
      classId,
      since,
    )) as Array<{ reason: string; c: number }>;
    return {
      reasons: rows.map((r) => ({
        reason: r.reason,
        count: Number(r.c) || 0,
      })),
    };
  }

  /** Delegate to ProgressService — single stats SQL path. */
  async topWrongs(
    assignmentId: string,
    teacherId: string,
    limit = 3,
  ): Promise<{
    questions: Array<{
      assignmentQuestionId: string;
      stem: string;
      wrongCount: number;
      answeredCount: number;
      knowledgeNodeId: string | null;
    }>;
  }> {
    return this.progress.getTopWrongs(assignmentId, teacherId, limit);
  }

  // ── Class map co-light (person-event units, no ranking) ────────────────

  async classMapProgress(
    classId: string,
    teacherId: string,
  ): Promise<{
    studentCount: number;
    /** 待回访人次（due 行） */
    dueReviewEvents: number;
    /** 巩固队列人次（due + open miss>0） */
    queueEvents: number;
    /** 本周过关人次 */
    passEventsWeek: number;
    /** 历史过关人次（passed 行） */
    passEventsTotal: number;
    // legacy aliases for older clients
    litNodeCount: number;
    halfNodeCount: number;
    dueReviewCount: number;
    passCountWeek: number;
  }> {
    await this.assertTeacherOwnsClass(classId, teacherId);
    const students = (await this.db.get(
      `SELECT COUNT(*) AS n FROM class_memberships
       WHERE class_id = ? AND LOWER(role) = 'student'`,
      classId,
    )) as { n: number };
    const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const due = (await this.db.get(
      `SELECT COUNT(*) AS n FROM mastery_items m
       JOIN class_memberships cm ON cm.user_id = m.user_id AND cm.class_id = ?
       WHERE m.status = 'due' AND m.miss_count > 0 AND LOWER(cm.role) = 'student'`,
      classId,
    )) as { n: number };
    const queue = (await this.db.get(
      `SELECT COUNT(*) AS n FROM mastery_items m
       JOIN class_memberships cm ON cm.user_id = m.user_id AND cm.class_id = ?
       WHERE m.miss_count > 0
         AND (m.status = 'due' OR m.status = 'open')
         AND LOWER(cm.role) = 'student'`,
      classId,
    )) as { n: number };
    const passWeek = (await this.db.get(
      `SELECT COUNT(*) AS n FROM mastery_items m
       JOIN class_memberships cm ON cm.user_id = m.user_id AND cm.class_id = ?
       WHERE m.status = 'passed' AND m.updated_at >= ?
         AND LOWER(cm.role) = 'student'`,
      classId,
      weekAgo,
    )) as { n: number };
    const passTotal = (await this.db.get(
      `SELECT COUNT(*) AS n FROM mastery_items m
       JOIN class_memberships cm ON cm.user_id = m.user_id AND cm.class_id = ?
       WHERE m.status = 'passed' AND LOWER(cm.role) = 'student'`,
      classId,
    )) as { n: number };
    const dueReviewEvents = Number(due?.n) || 0;
    const queueEvents = Number(queue?.n) || 0;
    const passEventsWeek = Number(passWeek?.n) || 0;
    const passEventsTotal = Number(passTotal?.n) || 0;
    return {
      studentCount: Number(students?.n) || 0,
      dueReviewEvents,
      queueEvents,
      passEventsWeek,
      passEventsTotal,
      // legacy: same units so UI not more misleading
      litNodeCount: passEventsTotal,
      halfNodeCount: queueEvents,
      dueReviewCount: dueReviewEvents,
      passCountWeek: passEventsWeek,
    };
  }

  // ── Layered reminder ───────────────────────────────────────────────────

  async buildLayeredReminder(
    assignmentId: string,
    teacherId: string,
  ): Promise<{ text: string; layers: Record<string, string[]> }> {
    const summary = await this.progress.getAssignmentSummary(
      assignmentId,
      teacherId,
    );
    const notStarted = summary.notStarted.map(
      (s) => s.nickname?.trim() || "未命名同学",
    );
    const correcting = summary.inProgress
      .filter((s) => s.status === "pending_correction")
      .map((s) => s.nickname?.trim() || "未命名同学");
    const otherProgress = summary.inProgress
      .filter((s) => s.status !== "pending_correction")
      .map((s) => s.nickname?.trim() || "未命名同学");
    const overdue = summary.incomplete
      .filter((s) => s.overdue)
      .map((s) => s.nickname?.trim() || "未命名同学");

    const lines = [
      "【算本】分层催交",
      `作业：${summary.title}`,
      `班级：${summary.className}`,
      `完成：${summary.completedCount}/${summary.totalStudents}` +
        (summary.completionRate != null
          ? `（${summary.completionRate}%）`
          : ""),
    ];
    if (notStarted.length) {
      lines.push(`尚未开始：${notStarted.join("、")}`);
    }
    if (correcting.length) {
      lines.push(`待订正：${correcting.join("、")}`);
    }
    if (otherProgress.length) {
      lines.push(`进行中：${otherProgress.join("、")}`);
    }
    if (overdue.length) {
      lines.push(`已逾期：${overdue.join("、")}`);
    }
    if (!summary.incomplete.length) {
      lines.push("全员已完成，真棒！");
    } else {
      lines.push("请按自己的进度完成，有不会的可点「还不会」告诉老师。");
    }
    return {
      text: lines.join("\n"),
      layers: {
        notStarted,
        pendingCorrection: correcting,
        inProgress: otherProgress,
        overdue,
      },
    };
  }

  // ── Badges + unified inbox ─────────────────────────────────────────────

  private async getInboxLastSeen(userId: string): Promise<string> {
    const row = (await this.db.get(
      `SELECT last_seen_at FROM interaction_inbox_state WHERE user_id = ?`,
      userId,
    )) as { last_seen_at: string } | undefined;
    return row?.last_seen_at || "1970-01-01T00:00:00.000Z";
  }

  async ackInbox(userId: string): Promise<{ lastSeenAt: string }> {
    const ts = nowIso();
    const existing = await this.db.get(
      `SELECT user_id FROM interaction_inbox_state WHERE user_id = ?`,
      userId,
    );
    if (existing) {
      await this.db.run(
        `UPDATE interaction_inbox_state SET last_seen_at = ? WHERE user_id = ?`,
        ts,
        userId,
      );
    } else {
      await this.db.run(
        `INSERT INTO interaction_inbox_state (user_id, last_seen_at) VALUES (?, ?)`,
        userId,
        ts,
      );
    }
    console.info("[interaction.inbox.ack]", { userId });
    return { lastSeenAt: ts };
  }

  async getBadge(
    userId: string,
    role: string | null,
    opts?: { classId?: string | null },
  ): Promise<{
    total: number;
    classId?: string | null;
    stuckOpen?: number;
    weekSharesPending?: number;
    stamps?: number;
    notes?: number;
    stuckReplies?: number;
    weekReplies?: number;
  }> {
    if (role === "teacher") {
      // Prefer current class so badge matches interact hub (same classId).
      const classId = (opts?.classId || "").trim() || null;
      if (classId) {
        await this.assertTeacherOwnsClass(classId, userId);
        const stuck = (await this.db.get(
          `SELECT COUNT(*) AS n FROM stuck_reports
           WHERE class_id = ? AND status = 'open'`,
          classId,
        )) as { n: number };
        const shares = (await this.db.get(
          `SELECT COUNT(*) AS n FROM week_shares
           WHERE class_id = ? AND teacher_reply IS NULL`,
          classId,
        )) as { n: number };
        const stuckOpen = Number(stuck?.n) || 0;
        const weekSharesPending = Number(shares?.n) || 0;
        return {
          total: stuckOpen + weekSharesPending,
          classId,
          stuckOpen,
          weekSharesPending,
        };
      }
      const stuck = (await this.db.get(
        `SELECT COUNT(*) AS n FROM stuck_reports r
         JOIN classes c ON c.id = r.class_id
         WHERE c.teacher_id = ? AND r.status = 'open' AND c.archived = 0`,
        userId,
      )) as { n: number };
      const shares = (await this.db.get(
        `SELECT COUNT(*) AS n FROM week_shares w
         JOIN classes c ON c.id = w.class_id
         WHERE c.teacher_id = ? AND w.teacher_reply IS NULL AND c.archived = 0`,
        userId,
      )) as { n: number };
      const stuckOpen = Number(stuck?.n) || 0;
      const weekSharesPending = Number(shares?.n) || 0;
      return {
        total: stuckOpen + weekSharesPending,
        classId: null,
        stuckOpen,
        weekSharesPending,
      };
    }

    // student: items after last inbox ack
    const since = await this.getInboxLastSeen(userId);
    const stamps = (await this.db.get(
      `SELECT COUNT(*) AS n FROM interaction_stamps
       WHERE student_id = ? AND created_at > ?`,
      userId,
      since,
    )) as { n: number };
    const notes = (await this.db.get(
      `SELECT COUNT(*) AS n FROM class_notes n
       WHERE (n.student_id = ? OR (
         n.student_id IS NULL AND n.class_id IN (
           SELECT class_id FROM class_memberships WHERE user_id = ?
         )
       )) AND n.created_at > ?`,
      userId,
      userId,
      since,
    )) as { n: number };
    const stuckReplies = (await this.db.get(
      `SELECT COUNT(*) AS n FROM stuck_reports
       WHERE student_id = ? AND teacher_reply IS NOT NULL AND updated_at > ?`,
      userId,
      since,
    )) as { n: number };
    const weekReplies = (await this.db.get(
      `SELECT COUNT(*) AS n FROM week_shares
       WHERE student_id = ? AND teacher_reply IS NOT NULL AND replied_at > ?`,
      userId,
      since,
    )) as { n: number };
    const s = Number(stamps?.n) || 0;
    const n = Number(notes?.n) || 0;
    const sr = Number(stuckReplies?.n) || 0;
    const wr = Number(weekReplies?.n) || 0;
    return {
      total: s + n + sr + wr,
      stamps: s,
      notes: n,
      stuckReplies: sr,
      weekReplies: wr,
    };
  }

  async getInbox(
    userId: string,
    role: string | null,
  ): Promise<{ items: Array<Record<string, unknown>> }> {
    if (role === "teacher") {
      const stuck = await this.db.all(
        `SELECT r.id, r.note, r.stem, r.created_at, r.status, u.nickname, a.title AS assignment_title, c.name AS class_name
         FROM stuck_reports r
         JOIN classes c ON c.id = r.class_id
         JOIN users u ON u.id = r.student_id
         JOIN assignments a ON a.id = r.assignment_id
         WHERE c.teacher_id = ? AND r.status = 'open' AND c.archived = 0
         ORDER BY r.created_at DESC LIMIT 40`,
        userId,
      );
      const shares = await this.db.all(
        `SELECT w.id, w.week_label, w.copy_text, w.created_at, u.nickname, c.name AS class_name
         FROM week_shares w
         JOIN classes c ON c.id = w.class_id
         JOIN users u ON u.id = w.student_id
         WHERE c.teacher_id = ? AND w.teacher_reply IS NULL AND c.archived = 0
         ORDER BY w.created_at DESC LIMIT 40`,
        userId,
      );
      const items: Array<Record<string, unknown>> = [];
      for (const r of stuck as Array<Record<string, unknown>>) {
        items.push({
          kind: "stuck",
          id: r.id,
          title: `${r.nickname} · 还不会`,
          body: r.stem || r.note || "学生上报了不会的题",
          className: r.class_name,
          createdAt: r.created_at,
        });
      }
      for (const r of shares as Array<Record<string, unknown>>) {
        items.push({
          kind: "week_share",
          id: r.id,
          title: `${r.nickname} · 周小结`,
          body: String(r.copy_text || "").slice(0, 120),
          className: r.class_name,
          createdAt: r.created_at,
        });
      }
      items.sort((a, b) =>
        String(b.createdAt).localeCompare(String(a.createdAt)),
      );
      return { items: items.slice(0, 50) };
    }

    // student feed
    const stamps = await this.listStampsForStudent(userId, 20);
    const notes = await this.listNotesForStudent(userId, 20);
    const stuck = await this.listStuckForStudent(userId, 20);
    const week = await this.listMyWeekShareReplies(userId);
    const items: Array<Record<string, unknown>> = [];
    for (const s of stamps) {
      items.push({
        kind: "stamp",
        kindLabel: "印章",
        id: s.id,
        title: `印章「${s.label}」`,
        body: s.assignmentTitle || s.note || "",
        createdAt: s.createdAt,
      });
    }
    for (const n of notes) {
      items.push({
        kind: "note",
        kindLabel: "小纸条",
        id: n.id,
        title: n.broadcast ? "全班小纸条" : "老师小纸条",
        body: n.body,
        className: n.className,
        createdAt: n.createdAt,
      });
    }
    for (const s of stuck) {
      if (!s.teacherReply) continue;
      items.push({
        kind: "stuck_reply",
        kindLabel: "还不会回复",
        id: s.id,
        title: "老师答「还不会」",
        body: s.teacherReply,
        meta: s.stem,
        createdAt: s.updatedAt || s.createdAt,
      });
    }
    for (const w of week) {
      items.push({
        kind: "week_reply",
        kindLabel: "周小结回复",
        id: w.id,
        title: "老师回周小结",
        body: w.teacherReply,
        createdAt: w.repliedAt,
      });
    }
    items.sort((a, b) =>
      String(b.createdAt || "").localeCompare(String(a.createdAt || "")),
    );
    return { items: items.slice(0, 60) };
  }

  /**
   * Student home display contract — one round-trip for badge + focus + preview.
   */
  async getStudentHomeBundle(studentId: string): Promise<{
    badge: Awaited<ReturnType<InteractionService["getBadge"]>>;
    focus: Array<Record<string, unknown>>;
    preview: Array<Record<string, unknown>>;
  }> {
    const [badge, focus, inbox] = await Promise.all([
      this.getBadge(studentId, "student"),
      this.listFocusForStudent(studentId),
      this.getInbox(studentId, "student"),
    ]);
    return {
      badge,
      focus,
      preview: (inbox.items || []).slice(0, 5),
    };
  }
}
