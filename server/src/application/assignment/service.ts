import type { AppDatabase } from "../../infrastructure/persistence/db.js";
import { createId, nowIso } from "../../infrastructure/persistence/db.js";
import { AppError } from "../../domain/shared/errors.js";
import type {
  QuestionBankService,
  QuestionSnapshot,
} from "../questionbank/service.js";
import { gradeOne } from "../../domain/grading/auto-grade.js";
import { KnowledgeTreeService } from "../knowledge/service.js";
import { isAllowedMediaUrl } from "../../infrastructure/storage/upload-store.js";
import {
  MasteryService,
  missesFromSnapshots,
} from "../mastery/service.js";
import { isWrongReason } from "../../domain/mastery/rules.js";
import { generateDrillQuestions } from "../../domain/drill/generator.js";

export type AssignmentType =
  | "daily_drill"
  | "knowledge_checkin"
  | "photo_homework";
export type AssignmentStatus = "draft" | "published" | "revoked";
/** Unified submission status (photo + online) */
export type SubmissionStatus =
  | "not_started"
  | "in_progress"
  | "submitted"
  | "pending_correction"
  | "completed"
  | "resubmit_required";
export type GradeResult = "correct" | "partial" | "incorrect";

export interface PublicAssignment {
  id: string;
  classId: string;
  className?: string;
  type: AssignmentType;
  title: string;
  description: string | null;
  status: AssignmentStatus;
  dueAt: string | null;
  config: Record<string, unknown>;
  createdBy: string;
  createdAt: string;
  publishedAt: string | null;
  questionCount?: number;
  /**
   * Student list only: submission status without getOrCreate side effects.
   * Absent when no row yet → treat as not_started on clients.
   */
  myStatus?: SubmissionStatus;
  /** Resolved knowledge points for check-in assignments */
  knowledgePoints?: Array<{
    id: string;
    name: string;
    unitName?: string | null;
    pathLabel?: string;
  }>;
}

export interface PublicAssignmentQuestion {
  id: string;
  sortOrder: number;
  sourceQuestionId: string | null;
  /** Immutable snapshot used for display & grading */
  snapshot: QuestionSnapshot;
}

export interface PublicPhoto {
  id: string;
  url: string;
  sortOrder: number;
}

export interface PublicGrade {
  result: GradeResult;
  score: number | null;
  comment: string | null;
  requireResubmit: boolean;
  gradedAt: string;
}

export interface PublicAnswerItem {
  assignmentQuestionId: string;
  response: string | boolean | null;
  isCorrect: boolean | null;
  correctionRound: number;
  /** Optional student self-tag on wrong/correct (S2) */
  wrongReason?: string | null;
  /**
   * Server reveal policy: true only when keys may be shown to the student.
   * Clients must not invent this from isCorrect.
   */
  revealKey: boolean;
  /** Present only when revealKey */
  correctAnswer?: string | boolean;
  explanation?: string | null;
  stem?: string;
  type?: string;
  options?: QuestionSnapshot["options"];
  knowledgeLabel?: string;
}

export interface PublicSubmission {
  id: string;
  assignmentId: string;
  studentId: string;
  studentNickname?: string | null;
  status: SubmissionStatus;
  overdue: boolean;
  score: number | null;
  /** 0–100 after online submit */
  correctRate: number | null;
  photos: PublicPhoto[];
  grade: PublicGrade | null;
  answers: PublicAnswerItem[];
  submittedAt: string | null;
  updatedAt: string;
  timerStartedAt?: string | null;
  /** Seconds remaining when timeLimitSec is set; null if unlimited */
  timeRemainingSec?: number | null;
  timeLimitSec?: number | null;
}

const MAX_PHOTOS = 6;

export class AssignmentService {
  private mastery: MasteryService;

  constructor(
    private db: AppDatabase,
    private questions?: QuestionBankService,
    private knowledge: KnowledgeTreeService = new KnowledgeTreeService(),
  ) {
    this.mastery = new MasteryService(db);
  }

  async create(
    teacherId: string,
    input: {
      classId: string;
      type: AssignmentType;
      title: string;
      description?: string;
      dueAt?: string | null;
      config?: Record<string, unknown>;
      publish?: boolean;
      /** Manual / generated bank question ids */
      questionIds?: string[];
      /**
       * Generated question snapshots (Phase 8).
       * Will be persisted as generated bank items then attached.
       */
      generatedSnapshots?: QuestionSnapshot[];
    },
  ): Promise<PublicAssignment> {
    await this.assertTeacherOwnsActiveClass(teacherId, input.classId);
    const onlineTypes: AssignmentType[] = ["daily_drill", "knowledge_checkin"];
    if (
      input.type !== "photo_homework" &&
      !onlineTypes.includes(input.type)
    ) {
      throw new AppError("UNSUPPORTED_TYPE", "不支持的作业类型");
    }

    let questionIds = [...(input.questionIds || [])];
    if (input.type === "photo_homework" && (questionIds.length || input.generatedSnapshots?.length)) {
      throw new AppError("INVALID_QUESTIONS", "拍照作业不能挂在线题目");
    }
    if (onlineTypes.includes(input.type)) {
      if (!this.questions) {
        throw new AppError("INTERNAL", "题库服务未配置", 500);
      }
      if (input.generatedSnapshots?.length) {
        const created = await this.questions!.createManyGenerated(
          teacherId,
          input.generatedSnapshots,
        );
        questionIds = [...created.map((q) => q.id), ...questionIds];
      }
      if (!questionIds.length) {
        throw new AppError(
          "INVALID_QUESTIONS",
          "在线作业请至少有 1 道题（生成或手工选题）",
        );
      }
    }

    if (input.type === "knowledge_checkin") {
      const kids = input.config?.knowledgeNodeIds;
      if (!Array.isArray(kids) || kids.length < 1) {
        throw new AppError(
          "INVALID_KNOWLEDGE",
          "知识点打卡请至少选择 1 个知识点",
        );
      }
      const resolved = this.knowledge.getMany(kids as string[]);
      if (resolved.length !== kids.length) {
        throw new AppError("INVALID_KNOWLEDGE", "存在无效知识点 id");
      }
    }

    const title = input.title.trim();
    if (!title || title.length > 80) {
      throw new AppError("INVALID_TITLE", "标题需 1–80 字");
    }

    const id = createId("asg");
    const ts = nowIso();
    const publish = input.publish === true;
    const status: AssignmentStatus = publish ? "published" : "draft";

    await this.db.transaction(async () => {
      await this.db.run(`INSERT INTO assignments
           (id, class_id, type, title, description, status, due_at, config_json, created_by, created_at, updated_at, published_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id,
          input.classId,
          input.type,
          title,
          input.description?.trim() || null,
          status,
          input.dueAt || null,
          JSON.stringify(input.config || {}),
          teacherId,
          ts,
          ts,
          publish ? ts : null,);

      if (questionIds.length) {
        await this.attachQuestionsInternal(id, teacherId, questionIds, ts);
      }
    });

    const __v = await this.getAssignment(id, teacherId); if (!__v) throw new Error("not found"); return __v;
  }

  /** Replace question set on a draft assignment */
  async setQuestions(
    assignmentId: string,
    teacherId: string,
    questionIds: string[],
  ): Promise<PublicAssignmentQuestion[]> {
    const row = await this.getAssignmentRowOwned(assignmentId, teacherId);
    if (row.status !== "draft") {
      throw new AppError("INVALID_STATUS", "仅草稿可修改题目");
    }
    if (row.type === "photo_homework") {
      throw new AppError("INVALID_TYPE", "拍照作业无在线题目");
    }
    if (!questionIds.length) {
      throw new AppError("INVALID_QUESTIONS", "至少选择 1 道题");
    }
    const ts = nowIso();
    await this.db.transaction(async () => {
      await this.db.run(`DELETE FROM assignment_questions WHERE assignment_id = ?`, assignmentId);
      await this.attachQuestionsInternal(assignmentId, teacherId, questionIds, ts);
      await this.db.run(`UPDATE assignments SET updated_at = ? WHERE id = ?`, ts, assignmentId);
    });
    return await this.listAssignmentQuestions(assignmentId, teacherId);
  }

  async listAssignmentQuestions(
    assignmentId: string,
    userId: string,
  ): Promise<PublicAssignmentQuestion[]> {
    // teacher or student member with access
    await this.getAssignment(assignmentId, userId);
    const isTeacher = await this.isClassTeacherOfAssignment(assignmentId, userId);

    const rows = await this.db.all(`SELECT * FROM assignment_questions
         WHERE assignment_id = ?
         ORDER BY sort_order ASC`, assignmentId) as Array<{
      id: string;
      sort_order: number;
      source_question_id: string | null;
      question_snapshot: string;
    }>;

    return rows.map((r) => {
      const snapshot = JSON.parse(r.question_snapshot) as QuestionSnapshot;
      if (!isTeacher) {
        // Phase 6/7: students must not receive answers until grading logic needs them server-side
        const { answer: _a, ...safe } = snapshot as QuestionSnapshot & {
          answer?: unknown;
        };
        return {
          id: r.id,
          sortOrder: r.sort_order,
          sourceQuestionId: null,
          snapshot: { ...safe, answer: "" } as QuestionSnapshot,
        };
      }
      return {
        id: r.id,
        sortOrder: r.sort_order,
        sourceQuestionId: r.source_question_id,
        snapshot,
      };
    });
  }

  private async isClassTeacherOfAssignment(
    assignmentId: string,
    userId: string,
  ): Promise<boolean> {
    const row = await this.db.get(`SELECT 1 AS ok FROM assignments a
         JOIN classes c ON c.id = a.class_id
         WHERE a.id = ? AND c.teacher_id = ?`, assignmentId, userId) as { ok: number } | undefined;
    return !!row;
  }

  async publish(assignmentId: string, teacherId: string): Promise<PublicAssignment> {
    const row = await this.getAssignmentRowOwned(assignmentId, teacherId);
    if (row.status === "published") {
      return await this.toPublicAssignment(row);
    }
    if (row.status === "revoked") {
      throw new AppError("INVALID_STATUS", "已下架的作业不能重新发布，请复制新建");
    }
    await this.assertClassActive(row.class_id);

    if (row.type !== "photo_homework") {
      const count = (
        await this.db.get(`SELECT COUNT(*) AS c FROM assignment_questions WHERE assignment_id = ?`, assignmentId) as { c: number }
      ).c;
      if (!count) {
        throw new AppError("INVALID_QUESTIONS", "请先添加题目再发布");
      }
      // Freeze snapshots from current source at publish time
      await this.refreezeSnapshotsFromSource(assignmentId, teacherId);
    }

    const ts = nowIso();
    await this.db.run(`UPDATE assignments SET status = 'published', published_at = ?, updated_at = ? WHERE id = ?`, ts, ts, assignmentId);
    const __v = await this.getAssignment(assignmentId, teacherId); if (!__v) throw new Error("not found"); return __v;
  }

  private async attachQuestionsInternal(
    assignmentId: string,
    teacherId: string,
    questionIds: string[],
    ts: string,
  ): Promise<void> {
    if (!this.questions) {
      throw new AppError("INTERNAL", "题库服务未配置", 500);
    }
    const rows = await this.questions!.getManyOwned(questionIds, teacherId);
    const __sql_insert = `INSERT INTO assignment_questions
       (id, assignment_id, sort_order, source_question_id, question_snapshot, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`;
    for (const [i, q] of rows.entries()) {
      const snap = await this.questions!.getSnapshotById(q.id);
      const snapshot: QuestionSnapshot = { ...snap };
      await this.db.run(__sql_insert, createId("aq"), assignmentId, i, q.id, JSON.stringify(snapshot), ts);
    }
  }

  /** Re-copy source questions into snapshots (draft → publish). */
  private async refreezeSnapshotsFromSource(
    assignmentId: string,
    teacherId: string,
  ): Promise<void> {
    if (!this.questions) return;
    const links = await this.db.all(`SELECT id, source_question_id, sort_order FROM assignment_questions
         WHERE assignment_id = ? ORDER BY sort_order`, assignmentId) as Array<{
      id: string;
      source_question_id: string | null;
      sort_order: number;
    }>;

    const __sql_update = `UPDATE assignment_questions SET question_snapshot = ? WHERE id = ?`;
    for (const link of links) {
      if (!link.source_question_id) continue;
      // ensure ownership
      await this.questions!.getManyOwned([link.source_question_id], teacherId);
      const snap = await this.questions!.getSnapshotById(link.source_question_id);
      await this.db.run(__sql_update, JSON.stringify(snap), link.id);
    }
  }

  async revoke(assignmentId: string, teacherId: string): Promise<PublicAssignment> {
    await this.getAssignmentRowOwned(assignmentId, teacherId);
    const ts = nowIso();
    await this.db.run(`UPDATE assignments SET status = 'revoked', updated_at = ? WHERE id = ?`, ts, assignmentId);
    const __v = await this.getAssignment(assignmentId, teacherId); if (!__v) throw new Error("not found"); return __v;
  }

  /**
   * Top wrongs via ProgressService stats path (injected lazily to avoid cycles).
   */
  private async getTopWrongStats(
    teacherId: string,
    assignmentId: string,
    limit: number,
  ): Promise<
    Array<{
      knowledgeNodeId: string | null;
      wrongCount: number;
    }>
  > {
    // Lazy import avoids circular module init with ProgressService
    const { ProgressService } = await import("../progress/service.js");
    const progress = new ProgressService(this.db);
    const top = await progress.getTopWrongs(assignmentId, teacherId, limit);
    return top.questions.map((q) => ({
      knowledgeNodeId: q.knowledgeNodeId,
      wrongCount: q.wrongCount,
    }));
  }

  /**
   * One-click variant drill from this assignment's top wrong knowledge/stems.
   * Generates new daily_drill questions and optionally publishes.
   */
  async createVariantFromTopWrongs(
    teacherId: string,
    sourceAssignmentId: string,
    opts?: { count?: number; publish?: boolean },
  ): Promise<PublicAssignment> {
    const row = await this.getAssignmentRowOwned(sourceAssignmentId, teacherId);
    await this.assertClassActive(row.class_id);
    const count = Math.min(Math.max(opts?.count ?? 10, 5), 30);
    const publish = opts?.publish !== false;

    // Single source: question-stats → top wrongs (no third SQL)
    const top = await this.getTopWrongStats(teacherId, sourceAssignmentId, 8);
    const opIds = new Set<string>();
    for (const q of top) {
      const kn = q.knowledgeNodeId
        ? this.knowledge.getById(q.knowledgeNodeId)
        : null;
      for (const op of kn?.suggestedDrillOps || []) {
        opIds.add(op);
      }
    }
    if (!opIds.size) {
      opIds.add("int_add_2d");
      opIds.add("int_sub_2d");
    }

    const ops = [...opIds].slice(0, 3);
    const perOp = Math.ceil(count / ops.length);
    const snapshots: QuestionSnapshot[] = [];
    for (const opId of ops) {
      if (snapshots.length >= count) break;
      try {
        const gen = generateDrillQuestions({
          operationId: opId,
          count: Math.min(perOp, count - snapshots.length),
          difficulty: "basic",
        });
        for (const q of gen.questions) {
          if (snapshots.length >= count) break;
          snapshots.push(q);
        }
      } catch (err) {
        console.warn("[assignment.variant.generate]", {
          opId,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (!snapshots.length) {
      throw new AppError("NO_QUESTIONS", "无法根据错题生成变式，请手动布置", 400);
    }

    const titleBase = (row.title || "练习").slice(0, 60);
    const title = `变式再练 · ${titleBase}`.slice(0, 80);
    console.info("[assignment.variant.create]", {
      sourceAssignmentId,
      teacherId,
      questionCount: snapshots.length,
      ops,
    });
    return this.create(teacherId, {
      classId: row.class_id,
      type: "daily_drill",
      title,
      description: `根据「${titleBase}」易错点自动生成的变式练习`,
      publish,
      generatedSnapshots: snapshots,
      config: {
        requireCorrection: true,
        allowStuckReport: true,
        variantOf: sourceAssignmentId,
        sourceOps: ops,
      },
    });
  }

  /**
   * Permanently delete a draft assignment (and its questions / empty submissions).
   * Published or revoked assignments must be revoked/left as history — not deleted.
   */
  async deleteDraft(assignmentId: string, teacherId: string): Promise<void> {
    const row = await this.getAssignmentRowOwned(assignmentId, teacherId);
    if (row.status !== "draft") {
      throw new AppError(
        "INVALID_STATUS",
        "只能删除草稿作业；已发布的请先下架",
        400,
      );
    }
    await this.db.transaction(async () => {
      const subs = (await this.db.all(
        `SELECT id FROM submissions WHERE assignment_id = ?`,
        assignmentId,
      )) as Array<{ id: string }>;
      for (const s of subs) {
        await this.db.run(`DELETE FROM photo_grades WHERE submission_id = ?`, s.id);
        await this.db.run(`DELETE FROM photo_assets WHERE submission_id = ?`, s.id);
        await this.db.run(`DELETE FROM answer_items WHERE submission_id = ?`, s.id);
      }
      await this.db.run(
        `DELETE FROM submissions WHERE assignment_id = ?`,
        assignmentId,
      );
      await this.db.run(
        `DELETE FROM assignment_questions WHERE assignment_id = ?`,
        assignmentId,
      );
      await this.db.run(`DELETE FROM assignments WHERE id = ?`, assignmentId);
    });
    console.info("[assignment.deleteDraft]", {
      assignmentId,
      teacherId,
      title: row.title,
    });
  }

  async listForTeacher(
    teacherId: string,
    opts?: { classId?: string; status?: AssignmentStatus; limit?: number },
  ): Promise<PublicAssignment[]> {
    let sql = `
      SELECT a.*, c.name AS class_name
      FROM assignments a
      JOIN classes c ON c.id = a.class_id
      WHERE c.teacher_id = ?
    `;
    const params: unknown[] = [teacherId];
    if (opts?.classId) {
      sql += ` AND a.class_id = ?`;
      params.push(opts.classId);
    }
    if (opts?.status) {
      sql += ` AND a.status = ?`;
      params.push(opts.status);
    }
    const limit = Math.min(Math.max(opts?.limit ?? 200, 1), 500);
    sql += ` ORDER BY a.created_at DESC LIMIT ${limit}`;
    const rows = await this.db.all(sql, ...params) as Array<
      AssignmentRow & { class_name: string }
    >;
    const questionCountMap = await this.loadQuestionCounts(rows.map((r) => r.id));
    return Promise.all(
      rows.map(async (r) =>
        await this.toPublicAssignment(r, r.class_name, {
          questionCount: questionCountMap.get(r.id) ?? 0,
        }),
      ),
    );
  }

  async listForStudent(
    studentId: string,
    opts?: { limit?: number },
  ): Promise<PublicAssignment[]> {
    const limit = Math.min(Math.max(opts?.limit ?? 200, 1), 500);
    const rows = await this.db.all(`
        SELECT a.*, c.name AS class_name
        FROM assignments a
        JOIN classes c ON c.id = a.class_id
        JOIN class_memberships m ON m.class_id = c.id AND m.user_id = ?
        WHERE a.status = 'published'
          AND c.archived = 0
        ORDER BY a.due_at IS NULL, a.due_at ASC, a.published_at DESC
        LIMIT ${limit}
        `, studentId) as Array<AssignmentRow & { class_name: string }>;
    const ids = rows.map((r) => r.id);
    const questionCountMap = await this.loadQuestionCounts(ids);
    const myStatusMap = await this.loadMyStatuses(studentId, ids);
    return Promise.all(
      rows.map(async (r) =>
        await this.toPublicAssignment(r, r.class_name, {
          questionCount: questionCountMap.get(r.id) ?? 0,
          myStatus: myStatusMap.get(r.id) ?? "not_started",
        }),
      ),
    );
  }

  async getAssignment(
    assignmentId: string,
    userId: string,
  ): Promise<PublicAssignment | null> {
    const row = await this.db.get(`SELECT a.*, c.name AS class_name, c.teacher_id
         FROM assignments a
         JOIN classes c ON c.id = a.class_id
         WHERE a.id = ?`, assignmentId) as
      | (AssignmentRow & { class_name: string; teacher_id: string })
      | undefined;
    if (!row) return null;

    if (row.teacher_id === userId) {
      return await this.toPublicAssignment(row, row.class_name);
    }

    const member = await this.db.get(`SELECT 1 FROM class_memberships WHERE class_id = ? AND user_id = ?`, row.class_id, userId);
    if (!member) {
      throw new AppError("FORBIDDEN", "无权查看该作业", 403);
    }
    if (row.status !== "published") {
      throw new AppError("FORBIDDEN", "作业未发布", 403);
    }
    return await this.toPublicAssignment(row, row.class_name);
  }

  async getOrCreateMySubmission(
    assignmentId: string,
    studentId: string,
  ): Promise<PublicSubmission> {
    await this.assertStudentCanAccessPublished(assignmentId, studentId);
    let sub = await this.findSubmission(assignmentId, studentId);
    if (!sub) {
      const id = createId("sub");
      const ts = nowIso();
      const asg = await this.db.get(`SELECT type, config_json FROM assignments WHERE id = ?`, assignmentId) as { type: string; config_json: string };
      const limit = await this.readTimeLimitSec(asg.config_json);
      const timerStart =
        asg.type !== "photo_homework" && limit ? ts : null;
      await this.db.run(`INSERT INTO submissions
           (id, assignment_id, student_id, status, overdue, score, created_at, updated_at, submitted_at, timer_started_at)
           VALUES (?, ?, ?, 'not_started', 0, NULL, ?, ?, NULL, ?)`, id, assignmentId, studentId, ts, ts, timerStart);
      sub = await this.findSubmission(assignmentId, studentId); if (!sub) throw new Error("not found");
    } else {
      // start timer on first open for timed online work
      const asg = await this.db.get(`SELECT type, config_json FROM assignments WHERE id = ?`, assignmentId) as { type: string; config_json: string };
      const limit = await this.readTimeLimitSec(asg.config_json);
      if (
        asg.type !== "photo_homework" &&
        limit &&
        !sub.timer_started_at &&
        (sub.status === "not_started" || sub.status === "in_progress")
      ) {
        const ts = nowIso();
        await this.db.run(`UPDATE submissions SET timer_started_at = ?, updated_at = ? WHERE id = ?`, ts, ts, sub.id);
        sub = await this.findSubmission(assignmentId, studentId); if (!sub) throw new Error("not found");
      }
    }
    // Server-side timer: if already expired, force-submit even without client interval
    sub = await this.maybeAutoForceSubmitIfExpired(sub);
    return await this.toPublicSubmission(sub, undefined, true);
  }

  /**
   * When time limit has elapsed and submission is still open, force-submit
   * with whatever answers exist (unanswered count as wrong). Survives client
   * kill / hide without relying on page interval.
   */
  private async maybeAutoForceSubmitIfExpired(
    sub: SubmissionRow,
  ): Promise<SubmissionRow> {
    if (sub.status !== "not_started" && sub.status !== "in_progress") {
      return sub;
    }
    const asg = (await this.db.get(
      `SELECT type, config_json FROM assignments WHERE id = ?`,
      sub.assignment_id,
    )) as { type: string; config_json: string } | undefined;
    if (!asg || asg.type === "photo_homework") return sub;
    const limit = await this.readTimeLimitSec(asg.config_json);
    if (!limit || !sub.timer_started_at) return sub;
    const elapsed =
      (Date.now() - new Date(sub.timer_started_at).getTime()) / 1000;
    if (elapsed < limit) return sub;
    await this.submitOnlineAnswers(sub.id, sub.student_id, [], { force: true });
    return await this.getSubmissionRow(sub.id);
  }

  /** Duplicate assignment as a new draft (independent snapshots). */
  async duplicate(assignmentId: string, teacherId: string): Promise<PublicAssignment> {
    const row = await this.getAssignmentRowOwned(assignmentId, teacherId);
    await this.assertTeacherOwnsActiveClass(teacherId, row.class_id);

    const newId = createId("asg");
    const ts = nowIso();
    const title = `${row.title}（副本）`.slice(0, 80);

    await this.db.transaction(async () => {
      await this.db.run(`INSERT INTO assignments
           (id, class_id, type, title, description, status, due_at, config_json, created_by, created_at, updated_at, published_at)
           VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, NULL)`, newId,
          row.class_id,
          row.type,
          title,
          row.description,
          row.due_at,
          row.config_json,
          teacherId,
          ts,
          ts,);

      const qs = await this.db.all(`SELECT sort_order, source_question_id, question_snapshot
           FROM assignment_questions WHERE assignment_id = ? ORDER BY sort_order`, assignmentId) as Array<{
        sort_order: number;
        source_question_id: string | null;
        question_snapshot: string;
      }>;

      const __sql_insert = `INSERT INTO assignment_questions
         (id, assignment_id, sort_order, source_question_id, question_snapshot, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`;
      for (const q of qs) {
        await this.db.run(__sql_insert, 
          createId("aq"),
          newId,
          q.sort_order,
          q.source_question_id,
          q.question_snapshot,
          ts,
        );
      }
    });
    const __v = await this.getAssignment(newId, teacherId); if (!__v) throw new Error("not found"); return __v;
  }

  /**
   * Save draft answers for online assignment (mid-way resume).
   */
  async saveDraftAnswers(
    submissionId: string,
    studentId: string,
    answers: Array<{ assignmentQuestionId: string; response: unknown }>,
  ): Promise<PublicSubmission> {
    let sub = await this.getSubmissionRow(submissionId);
    if (sub.student_id !== studentId) {
      throw new AppError("FORBIDDEN", "只能保存自己的作答", 403);
    }
    await this.assertOnlineAssignment(sub.assignment_id);
    await this.assertStudentCanAccessPublished(sub.assignment_id, studentId);

    if (sub.status === "completed") {
      throw new AppError("INVALID_STATUS", "已完成，不能再改");
    }
    if (sub.status === "pending_correction") {
      throw new AppError("INVALID_STATUS", "请使用订正接口提交错题");
    }
    // Already closed (e.g. concurrent force-submit) — return as-is
    if (sub.status !== "not_started" && sub.status !== "in_progress") {
      return await this.toPublicSubmission(sub, undefined, true);
    }

    const qMap = await this.loadQuestionMap(sub.assignment_id);
    const ts = nowIso();
    // Persist draft answers FIRST, then force-submit if timer already expired.
    // (Force-before-save would drop the answers in this request body.)
    await this.db.transaction(async () => {
      for (const a of answers) {
        if (!qMap.has(a.assignmentQuestionId)) {
          throw new AppError("INVALID_QUESTION", "题目不属于该作业");
        }
        await this.upsertAnswerItem(
          submissionId,
          a.assignmentQuestionId,
          a.response,
          null,
          0,
          ts,
        );
      }
      if (sub.status === "not_started" || sub.status === "in_progress") {
        await this.db.run(`UPDATE submissions SET status = 'in_progress', updated_at = ? WHERE id = ?`, ts, submissionId);
      }
    });
    sub = await this.getSubmissionRow(submissionId);
    sub = await this.maybeAutoForceSubmitIfExpired(sub);
    return await this.toPublicSubmission(sub, undefined, true);
  }

  /**
   * First submit (or resubmit all while in_progress): auto-grade entire paper.
   * @param force when true (timer auto-submit), unanswered items count as wrong
   */
  async submitOnlineAnswers(
    submissionId: string,
    studentId: string,
    answers: Array<{ assignmentQuestionId: string; response: unknown }>,
    opts?: { force?: boolean },
  ): Promise<PublicSubmission> {
    const sub = await this.getSubmissionRow(submissionId);
    if (sub.student_id !== studentId) {
      throw new AppError("FORBIDDEN", "只能提交自己的作答", 403);
    }
    await this.assertOnlineAssignment(sub.assignment_id);
    await this.assertStudentCanAccessPublished(sub.assignment_id, studentId);

    if (
      sub.status !== "not_started" &&
      sub.status !== "in_progress"
    ) {
      throw new AppError(
        "INVALID_STATUS",
        "当前状态不可整卷提交，请使用订正",
      );
    }

    const qMap = await this.loadQuestionMap(sub.assignment_id);
    if (!qMap.size) {
      throw new AppError("INVALID_QUESTIONS", "作业无题目");
    }

    // merge with existing draft
    const existing = await this.loadAnswerRows(submissionId);
    const responseMap = new Map<string, unknown>();
    for (const e of existing) {
      if (e.response_json != null) {
        responseMap.set(e.assignment_question_id, JSON.parse(e.response_json));
      }
    }
    for (const a of answers) {
      responseMap.set(a.assignmentQuestionId, a.response);
    }

    const assignment = await this.db.get(`SELECT due_at, status, config_json FROM assignments WHERE id = ?`, sub.assignment_id) as {
      due_at: string | null;
      status: string;
      config_json: string;
    };
    if (assignment.status !== "published") {
      throw new AppError("INVALID_STATUS", "作业未发布或已下架");
    }

    const limit = await this.readTimeLimitSec(assignment.config_json);
    let timedOut = false;
    if (limit && sub.timer_started_at) {
      const elapsed =
        (Date.now() - new Date(sub.timer_started_at).getTime()) / 1000;
      // allow 2s clock skew
      timedOut = elapsed >= limit - 2;
    }
    // Client force or server-detected timeout both treat incomplete as wrong
    const force = opts?.force === true || timedOut;
    if (opts?.force === true && limit && sub.timer_started_at && !timedOut) {
      throw new AppError("TIMER_ACTIVE", "限时尚未结束");
    }

    if (!force) {
      for (const qid of qMap.keys()) {
        if (
          !responseMap.has(qid) ||
          responseMap.get(qid) === "" ||
          responseMap.get(qid) === null ||
          responseMap.get(qid) === undefined
        ) {
          throw new AppError("INCOMPLETE", "请答完所有题目再提交");
        }
      }
    }

    const ts = nowIso();
    const overdue =
      assignment.due_at && new Date(assignment.due_at).getTime() < Date.now()
        ? 1
        : 0;

    let correctCount = 0;
    const total = qMap.size;

    const asgRow = (await this.db.get(
      `SELECT config_json, class_id, type FROM assignments WHERE id = ?`,
      sub.assignment_id,
    )) as
      | { config_json: string; class_id: string; type: string }
      | undefined;
    const requireCorrection = this.readRequireCorrection(
      asgRow?.config_json || assignment.config_json,
    );

    let finalStatus: SubmissionStatus = "completed";
    await this.db.transaction(async () => {
      for (const [qid, snap] of qMap) {
        const resp = responseMap.has(qid) ? responseMap.get(qid) : null;
        const { correct } = gradeOne(snap, resp);
        if (correct) correctCount += 1;
        await this.upsertAnswerItem(submissionId, qid, resp, correct, 0, ts);
      }
      const allCorrect = correctCount === total;
      const score = Math.round((correctCount / total) * 1000) / 10;
      // Teacher-controlled: requireCorrection (default true) → wrongs stay pending
      finalStatus =
        allCorrect || !requireCorrection
          ? "completed"
          : "pending_correction";
      await this.db.run(
        `UPDATE submissions
           SET status = ?, overdue = ?, score = ?,
               submitted_at = ?, updated_at = ?
           WHERE id = ?`,
        finalStatus,
        overdue,
        score,
        ts,
        ts,
        submissionId,
      );
    });

    // No-correction path: still enqueue mastery for first-submit wrongs so
    // teachers see weak points / student map updates without a correction loop.
    if (finalStatus === "completed" && correctCount < total) {
      try {
        await this.enqueueMasteryFromSubmission(submissionId, studentId, {
          mode: "first_submit_wrongs",
        });
      } catch (err) {
        console.error("[mastery.enqueue] failed after submit", {
          submissionId,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return await this.toPublicSubmission(
      await this.getSubmissionRow(submissionId),
      undefined,
      true,
    );
  }

  private async readTimeLimitSec(configJson: string): Promise<number | null> {
    try {
      const cfg = JSON.parse(configJson || "{}") as {
        timeLimitSec?: number | null;
      };
      const n = cfg.timeLimitSec;
      if (n != null && Number(n) > 0) return Number(n);
    } catch {
      /* ignore */
    }
    return null;
  }

  /**
   * Whether wrong online answers must be corrected before completed.
   * Default true (legacy / product default). Teacher sets via assignment.config.
   */
  private readRequireCorrection(configJson: string): boolean {
    try {
      const cfg = JSON.parse(configJson || "{}") as {
        requireCorrection?: boolean | null;
      };
      if (cfg.requireCorrection === false) return false;
      return true;
    } catch {
      return true;
    }
  }

  /**
   * After completed: reveal answer keys so student can review.
   * Default true. Set revealAnswerAfterDone:false to keep keys teacher-only.
   */
  private readRevealAnswerAfterDone(configJson: string): boolean {
    try {
      const cfg = JSON.parse(configJson || "{}") as {
        revealAnswerAfterDone?: boolean | null;
      };
      if (cfg.revealAnswerAfterDone === false) return false;
      return true;
    } catch {
      return true;
    }
  }

  /**
   * Correct only wrong items; all must become correct to complete.
   * Optional wrongReasons (S2): student self-tag; does not block submit.
   * On full completion, enqueues mastery_items for questions that were wrong.
   */
  async correctOnlineAnswers(
    submissionId: string,
    studentId: string,
    answers: Array<{ assignmentQuestionId: string; response: unknown }>,
    opts?: {
      wrongReasons?: Array<{
        assignmentQuestionId: string;
        reason: string;
      }>;
    },
  ): Promise<PublicSubmission> {
    const sub = await this.getSubmissionRow(submissionId);
    if (sub.student_id !== studentId) {
      throw new AppError("FORBIDDEN", "只能订正自己的作答", 403);
    }
    await this.assertOnlineAssignment(sub.assignment_id);
    await this.assertStudentCanAccessPublished(sub.assignment_id, studentId);

    if (sub.status !== "pending_correction") {
      throw new AppError("INVALID_STATUS", "当前无需订正");
    }

    const reasonMap = new Map<string, string>();
    for (const wr of opts?.wrongReasons || []) {
      if (wr.assignmentQuestionId && isWrongReason(wr.reason)) {
        reasonMap.set(wr.assignmentQuestionId, wr.reason);
      }
    }

    const qMap = await this.loadQuestionMap(sub.assignment_id);
    const sourceMap = await this.loadSourceQuestionMap(sub.assignment_id);
    const rows = await this.loadAnswerRows(submissionId);
    const wrongIds = new Set(
      rows.filter((r) => r.is_correct === 0).map((r) => r.assignment_question_id),
    );
    if (!wrongIds.size) {
      // nothing wrong — mark completed
      const ts = nowIso();
      await this.db.run(`UPDATE submissions SET status = 'completed', score = 100, updated_at = ? WHERE id = ?`, ts, submissionId);
      return await this.toPublicSubmission(
        await this.getSubmissionRow(submissionId),
        undefined,
        true,
      );
    }

    const ts = nowIso();
    let becameCompleted = false;
    await this.db.transaction(async () => {
      for (const a of answers) {
        if (!wrongIds.has(a.assignmentQuestionId)) {
          throw new AppError("INVALID_QUESTION", "只能订正错题");
        }
        const snap = qMap.get(a.assignmentQuestionId)!;
        const { correct } = gradeOne(snap, a.response);
        const prev = rows.find(
          (r) => r.assignment_question_id === a.assignmentQuestionId,
        );
        const round = (prev?.correction_round || 0) + 1;
        const reason = reasonMap.get(a.assignmentQuestionId) ?? null;
        await this.upsertAnswerItem(
          submissionId,
          a.assignmentQuestionId,
          a.response,
          correct,
          round,
          ts,
          reason,
        );
      }

      // re-check all
      const after = await this.loadAnswerRows(submissionId);
      const stillWrong = after.some((r) => r.is_correct !== 1);
      const correctCount = after.filter((r) => r.is_correct === 1).length;
      const total = after.length || qMap.size;
      const score = Math.round((correctCount / total) * 1000) / 10;

      const assignment = await this.db.get(`SELECT due_at FROM assignments WHERE id = ?`, sub.assignment_id) as { due_at: string | null };
      const overdue =
        assignment.due_at && new Date(assignment.due_at).getTime() < Date.now()
          ? 1
          : sub.overdue;

      becameCompleted = !stillWrong;
      await this.db.run(`UPDATE submissions SET status = ?, score = ?, overdue = ?, updated_at = ? WHERE id = ?`, stillWrong ? "pending_correction" : "completed",
          score,
          overdue,
          ts,
          submissionId,);
    });

    if (becameCompleted) {
      try {
        await this.enqueueMasteryFromSubmission(submissionId, studentId, {
          mode: "correction_round",
          reasonMap,
        });
      } catch (err) {
        console.error("[mastery.enqueue] failed after correct", {
          submissionId,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return await this.toPublicSubmission(
      await this.getSubmissionRow(submissionId),
      undefined,
      true,
    );
  }

  /**
   * Enqueue mastery misses after online work.
   * - correction_round: items that were wrong at least once (correction_round > 0)
   * - first_submit_wrongs: current is_correct=0 rows (no-correction path)
   */
  private async enqueueMasteryFromSubmission(
    submissionId: string,
    studentId: string,
    opts: {
      mode: "correction_round" | "first_submit_wrongs";
      reasonMap?: Map<string, string>;
    },
  ): Promise<void> {
    const sub = await this.getSubmissionRow(submissionId);
    const qMap = await this.loadQuestionMap(sub.assignment_id);
    const sourceMap = await this.loadSourceQuestionMap(sub.assignment_id);
    const finalRows = await this.loadAnswerRows(submissionId);
    const missAqIds =
      opts.mode === "correction_round"
        ? finalRows
            .filter((r) => (r.correction_round || 0) > 0)
            .map((r) => r.assignment_question_id)
        : finalRows
            .filter((r) => r.is_correct === 0)
            .map((r) => r.assignment_question_id);
    if (!missAqIds.length) return;

    const asg = (await this.db.get(
      `SELECT class_id, type FROM assignments WHERE id = ?`,
      sub.assignment_id,
    )) as { class_id: string; type: string } | undefined;
    const reasonMap = opts.reasonMap || new Map<string, string>();
    const missItems = missAqIds
      .map((aqId) => {
        const snap = qMap.get(aqId);
        if (!snap) return null;
        const row = finalRows.find((r) => r.assignment_question_id === aqId);
        return {
          snapshot: snap,
          sourceQuestionId: sourceMap.get(aqId) ?? snap.id ?? null,
          wrongReason: reasonMap.get(aqId) ?? row?.wrong_reason ?? null,
        };
      })
      .filter((x): x is NonNullable<typeof x> => !!x);
    await this.mastery.enqueueAfterCorrection({
      userId: studentId,
      classId: asg?.class_id ?? null,
      assignmentId: sub.assignment_id,
      assignmentType: asg?.type || "daily_drill",
      misses: missesFromSnapshots(missItems),
    });
  }

  private async assertOnlineAssignment(assignmentId: string): Promise<void> {
    const row = await this.db.get(`SELECT type FROM assignments WHERE id = ?`, assignmentId) as { type: string } | undefined;
    if (!row || row.type === "photo_homework") {
      throw new AppError("INVALID_TYPE", "仅在线作业支持此操作");
    }
  }

  private async loadQuestionMap(
    assignmentId: string,
  ): Promise<Map<string, QuestionSnapshot>> {
    const rows = await this.db.all(`SELECT id, question_snapshot FROM assignment_questions WHERE assignment_id = ?`, assignmentId) as Array<{ id: string; question_snapshot: string }>;
    const map = new Map<string, QuestionSnapshot>();
    for (const r of rows) {
      map.set(r.id, JSON.parse(r.question_snapshot) as QuestionSnapshot);
    }
    return map;
  }

  private async loadSourceQuestionMap(
    assignmentId: string,
  ): Promise<Map<string, string | null>> {
    const rows = (await this.db.all(
      `SELECT id, source_question_id FROM assignment_questions WHERE assignment_id = ?`,
      assignmentId,
    )) as Array<{ id: string; source_question_id: string | null }>;
    const map = new Map<string, string | null>();
    for (const r of rows) {
      map.set(r.id, r.source_question_id || null);
    }
    return map;
  }

  private async loadAnswerRows(submissionId: string): Promise<
    Array<{
      assignment_question_id: string;
      response_json: string | null;
      is_correct: number | null;
      correction_round: number;
      wrong_reason?: string | null;
    }>
  > {
    return (await this.db.all(
      `SELECT * FROM answer_items WHERE submission_id = ?`,
      submissionId,
    )) as Array<{
      assignment_question_id: string;
      response_json: string | null;
      is_correct: number | null;
      correction_round: number;
      wrong_reason?: string | null;
    }>;
  }

  private async upsertAnswerItem(
    submissionId: string,
    assignmentQuestionId: string,
    response: unknown,
    isCorrect: boolean | null,
    correctionRound: number,
    ts: string,
    wrongReason?: string | null,
  ): Promise<void> {
    const existing = await this.db.get(`SELECT id FROM answer_items WHERE submission_id = ? AND assignment_question_id = ?`, submissionId, assignmentQuestionId) as { id: string } | undefined;

    const responseJson =
      response === undefined ? null : JSON.stringify(response);
    const correctInt =
      isCorrect === null || isCorrect === undefined ? null : isCorrect ? 1 : 0;
    const reason =
      wrongReason && isWrongReason(wrongReason) ? wrongReason : null;

    if (existing) {
      if (reason != null) {
        await this.db.run(
          `UPDATE answer_items
             SET response_json = ?, is_correct = ?, correction_round = ?,
                 wrong_reason = ?, updated_at = ?
             WHERE id = ?`,
          responseJson,
          correctInt,
          correctionRound,
          reason,
          ts,
          existing.id,
        );
      } else {
        await this.db.run(
          `UPDATE answer_items
             SET response_json = ?, is_correct = ?, correction_round = ?, updated_at = ?
             WHERE id = ?`,
          responseJson,
          correctInt,
          correctionRound,
          ts,
          existing.id,
        );
      }
    } else {
      await this.db.run(
        `INSERT INTO answer_items
           (id, submission_id, assignment_question_id, response_json, is_correct, correction_round, wrong_reason, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        createId("ans"),
        submissionId,
        assignmentQuestionId,
        responseJson,
        correctInt,
        correctionRound,
        reason,
        ts,
      );
    }
  }

  async submitPhotos(
    submissionId: string,
    studentId: string,
    photoUrls: string[],
  ): Promise<PublicSubmission> {
    const sub = await this.getSubmissionRow(submissionId);
    if (sub.student_id !== studentId) {
      throw new AppError("FORBIDDEN", "只能提交自己的作业", 403);
    }
    await this.assertStudentCanAccessPublished(sub.assignment_id, studentId);

    // Freeze after submit: only first submit (not_started) or teacher-required resubmit
    if (sub.status === "submitted") {
      throw new AppError(
        "INVALID_STATUS",
        "已提交，等待老师批改，不能再修改",
      );
    }
    if (sub.status === "completed") {
      throw new AppError("INVALID_STATUS", "作业已批改完成，不能再提交");
    }
    if (
      sub.status !== "not_started" &&
      sub.status !== "resubmit_required"
    ) {
      throw new AppError("INVALID_STATUS", "当前状态不能提交照片");
    }

    const urls = photoUrls.map((u) => u.trim()).filter(Boolean);
    if (!urls.length) {
      throw new AppError("INVALID_PHOTOS", "请至少上传 1 张照片");
    }
    if (urls.length > MAX_PHOTOS) {
      throw new AppError("INVALID_PHOTOS", `最多上传 ${MAX_PHOTOS} 张照片`);
    }
    for (const u of urls) {
      if (!isAllowedMediaUrl(u)) {
        throw new AppError("INVALID_PHOTOS", "图片地址无效");
      }
    }

    const assignment = await this.db.get(`SELECT due_at, status FROM assignments WHERE id = ?`, sub.assignment_id) as { due_at: string | null; status: string };
    if (assignment.status !== "published") {
      throw new AppError("INVALID_STATUS", "作业未发布或已下架");
    }

    const ts = nowIso();
    const overdue =
      assignment.due_at && new Date(assignment.due_at).getTime() < Date.now()
        ? 1
        : 0;

    await this.db.transaction(async () => {
      await this.db.run(`DELETE FROM photo_assets WHERE submission_id = ?`, submissionId);
      // clear previous grade when resubmitting
      await this.db.run(`DELETE FROM photo_grades WHERE submission_id = ?`, submissionId);

      const __sql_insert = `INSERT INTO photo_assets (id, submission_id, url, sort_order, created_at)
         VALUES (?, ?, ?, ?, ?)`;
      for (const [i, url] of urls.entries()) {
        await this.db.run(__sql_insert, createId("ph"), submissionId, url, i, ts);
      }

      await this.db.run(`UPDATE submissions
           SET status = 'submitted', overdue = ?, score = NULL,
               submitted_at = ?, updated_at = ?
           WHERE id = ?`, overdue, ts, ts, submissionId);
    });

    return await this.toPublicSubmission(await this.getSubmissionRow(submissionId));
  }

  async gradePhoto(
    submissionId: string,
    teacherId: string,
    input: {
      result: GradeResult;
      score?: number | null;
      comment?: string | null;
      requireResubmit?: boolean;
    },
  ): Promise<PublicSubmission> {
    const sub = await this.getSubmissionRow(submissionId);
    const asg = await this.getAssignmentRowOwned(sub.assignment_id, teacherId);

    if (asg.type !== "photo_homework") {
      throw new AppError("INVALID_TYPE", "仅拍照作业支持此批改");
    }
    // Allow grade/re-grade when submitted, completed, or awaiting resubmit
    const status = sub.status as SubmissionStatus;
    const gradable: SubmissionStatus[] = [
      "submitted",
      "completed",
      "resubmit_required",
    ];
    if (!gradable.includes(status)) {
      if (status === "not_started" || status === "in_progress") {
        throw new AppError("INVALID_STATUS", "学生尚未提交");
      }
      throw new AppError("INVALID_STATUS", "当前状态不可批改");
    }
    // Must have photos
    const photoCount = (
      await this.db.get(`SELECT COUNT(*) AS c FROM photo_assets WHERE submission_id = ?`, submissionId) as { c: number }
    ).c;
    if (!photoCount) {
      throw new AppError("INVALID_STATUS", "学生尚未提交照片");
    }

    if (!["correct", "partial", "incorrect"].includes(input.result)) {
      throw new AppError("INVALID_RESULT", "批改结果无效");
    }

    let score =
      input.score === undefined || input.score === null
        ? null
        : Number(input.score);
    if (score !== null && (Number.isNaN(score) || score < 0 || score > 100)) {
      throw new AppError("INVALID_SCORE", "分数需在 0–100");
    }

    const requireResubmit = input.requireResubmit === true;
    const newStatus: SubmissionStatus = requireResubmit
      ? "resubmit_required"
      : "completed";
    const ts = nowIso();

    await this.db.transaction(async () => {
      await this.db.run(`INSERT INTO photo_grades
             (submission_id, result, score, comment, require_resubmit, graded_by, graded_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(submission_id) DO UPDATE SET
             result = excluded.result,
             score = excluded.score,
             comment = excluded.comment,
             require_resubmit = excluded.require_resubmit,
             graded_by = excluded.graded_by,
             graded_at = excluded.graded_at`, submissionId,
          input.result,
          score,
          input.comment?.trim() || null,
          requireResubmit ? 1 : 0,
          teacherId,
          ts,);

      await this.db.run(`UPDATE submissions SET status = ?, score = ?, updated_at = ? WHERE id = ?`, newStatus, requireResubmit ? null : score, ts, submissionId);
    });

    return await this.toPublicSubmission(await this.getSubmissionRow(submissionId));
  }

  async listSubmissionsForTeacher(
    assignmentId: string,
    teacherId: string,
  ): Promise<PublicSubmission[]> {
    await this.getAssignmentRowOwned(assignmentId, teacherId);
    const rows = await this.db.all(`
        SELECT s.*, u.nickname
        FROM submissions s
        JOIN users u ON u.id = s.student_id
        WHERE s.assignment_id = ?
        ORDER BY
          CASE s.status
            WHEN 'submitted' THEN 0
            WHEN 'resubmit_required' THEN 1
            WHEN 'completed' THEN 2
            ELSE 3
          END,
          s.updated_at DESC
        `, assignmentId) as Array<SubmissionRow & { nickname: string | null }>;

    if (!rows.length) return [];
    const subIds = rows.map((r) => r.id);
    const [photosBySub, gradesBySub] = await Promise.all([
      this.loadPhotosBySubmissionIds(subIds),
      this.loadGradesBySubmissionIds(subIds),
    ]);
    return Promise.all(
      rows.map(async (r) =>
        await this.toPublicSubmission(r, r.nickname, false, {
          photos: photosBySub.get(r.id) ?? [],
          grade: gradesBySub.get(r.id) ?? null,
        }),
      ),
    );
  }

  async listPendingGradeCount(teacherId: string): Promise<number> {
    const row = await this.db.get(`
        SELECT COUNT(*) AS c
        FROM submissions s
        JOIN assignments a ON a.id = s.assignment_id
        JOIN classes c ON c.id = a.class_id
        WHERE c.teacher_id = ?
          AND a.status = 'published'
          AND s.status = 'submitted'
        `, teacherId) as { c: number };
    return row.c;
  }

  // —— helpers ——

  private async assertTeacherOwnsActiveClass(
    teacherId: string,
    classId: string,
  ): Promise<void> {
    const row = await this.db.get(`SELECT teacher_id, archived FROM classes WHERE id = ?`, classId) as { teacher_id: string; archived: number } | undefined;
    if (!row) throw new AppError("NOT_FOUND", "班级不存在", 404);
    if (row.teacher_id !== teacherId) {
      throw new AppError("FORBIDDEN", "只能在自己的班级布置作业", 403);
    }
    if (row.archived) {
      throw new AppError("CLASS_ARCHIVED", "归档班级不能布置作业");
    }
  }

  private async assertClassActive(classId: string): Promise<void> {
    const row = await this.db.get(`SELECT archived FROM classes WHERE id = ?`, classId) as { archived: number } | undefined;
    if (!row) throw new AppError("NOT_FOUND", "班级不存在", 404);
    if (row.archived) {
      throw new AppError("CLASS_ARCHIVED", "归档班级不能发布作业");
    }
  }

  private async getAssignmentRowOwned(
    assignmentId: string,
    teacherId: string,
  ): Promise<AssignmentRow> {
    const row = await this.db.get(`SELECT a.* FROM assignments a
         JOIN classes c ON c.id = a.class_id
         WHERE a.id = ? AND c.teacher_id = ?`, assignmentId, teacherId) as AssignmentRow | undefined;
    if (!row) throw new AppError("NOT_FOUND", "作业不存在或无权操作", 404);
    return row;
  }

  private async assertStudentCanAccessPublished(
    assignmentId: string,
    studentId: string,
  ): Promise<AssignmentRow> {
    const row = await this.db.get(`
        SELECT a.*
        FROM assignments a
        JOIN class_memberships m ON m.class_id = a.class_id AND m.user_id = ?
        JOIN classes c ON c.id = a.class_id
        WHERE a.id = ? AND a.status = 'published' AND c.archived = 0
        `, studentId, assignmentId) as AssignmentRow | undefined;
    if (!row) {
      throw new AppError("FORBIDDEN", "无权访问该作业", 403);
    }
    return row;
  }

  private async findSubmission(
    assignmentId: string,
    studentId: string,
  ): Promise<SubmissionRow | undefined> {
    return await this.db.get(`SELECT * FROM submissions WHERE assignment_id = ? AND student_id = ?`, assignmentId, studentId) as SubmissionRow | undefined;
  }

  private async getSubmissionRow(id: string): Promise<SubmissionRow> {
    const row = await this.db.get(`SELECT * FROM submissions WHERE id = ?`, id) as SubmissionRow | undefined;
    if (!row) throw new AppError("NOT_FOUND", "提交记录不存在", 404);
    return row;
  }

  /** One GROUP BY query for all assignment ids (avoids N+1 on list). */
  private async loadQuestionCounts(
    assignmentIds: string[],
  ): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    if (!assignmentIds.length) return map;
    const placeholders = assignmentIds.map(() => "?").join(",");
    const rows = (await this.db.all(
      `SELECT assignment_id, COUNT(*) AS c FROM assignment_questions
         WHERE assignment_id IN (${placeholders})
         GROUP BY assignment_id`,
      ...assignmentIds,
    )) as Array<{ assignment_id: string; c: number }>;
    for (const r of rows) {
      map.set(r.assignment_id, Number(r.c) || 0);
    }
    return map;
  }

  /**
   * Batch submission status for student assignment list (read-only; no getOrCreate).
   */
  private async loadMyStatuses(
    studentId: string,
    assignmentIds: string[],
  ): Promise<Map<string, SubmissionStatus>> {
    const map = new Map<string, SubmissionStatus>();
    if (!assignmentIds.length) return map;
    const placeholders = assignmentIds.map(() => "?").join(",");
    const rows = (await this.db.all(
      `SELECT assignment_id, status FROM submissions
         WHERE student_id = ?
           AND assignment_id IN (${placeholders})`,
      studentId,
      ...assignmentIds,
    )) as Array<{ assignment_id: string; status: string }>;
    for (const r of rows) {
      map.set(r.assignment_id, r.status as SubmissionStatus);
    }
    return map;
  }

  private async loadPhotosBySubmissionIds(
    submissionIds: string[],
  ): Promise<Map<string, PublicPhoto[]>> {
    const map = new Map<string, PublicPhoto[]>();
    if (!submissionIds.length) return map;
    for (const id of submissionIds) map.set(id, []);
    const placeholders = submissionIds.map(() => "?").join(",");
    const rows = (await this.db.all(
      `SELECT id, submission_id, url, sort_order FROM photo_assets
         WHERE submission_id IN (${placeholders})
         ORDER BY submission_id, sort_order ASC`,
      ...submissionIds,
    )) as Array<{
      id: string;
      submission_id: string;
      url: string;
      sort_order: number;
    }>;
    for (const p of rows) {
      const list = map.get(p.submission_id) ?? [];
      list.push({ id: p.id, url: p.url, sortOrder: p.sort_order });
      map.set(p.submission_id, list);
    }
    return map;
  }

  private async loadGradesBySubmissionIds(
    submissionIds: string[],
  ): Promise<Map<string, PublicGrade | null>> {
    const map = new Map<string, PublicGrade | null>();
    if (!submissionIds.length) return map;
    for (const id of submissionIds) map.set(id, null);
    const placeholders = submissionIds.map(() => "?").join(",");
    const rows = (await this.db.all(
      `SELECT submission_id, result, score, comment, require_resubmit, graded_at
         FROM photo_grades
         WHERE submission_id IN (${placeholders})`,
      ...submissionIds,
    )) as Array<{
      submission_id: string;
      result: GradeResult;
      score: number | null;
      comment: string | null;
      require_resubmit: number;
      graded_at: string;
    }>;
    for (const g of rows) {
      map.set(g.submission_id, {
        result: g.result,
        score: g.score,
        comment: g.comment,
        requireResubmit: g.require_resubmit === 1,
        gradedAt: g.graded_at,
      });
    }
    return map;
  }

  private async toPublicAssignment(
    row: AssignmentRow,
    className?: string,
    opts?: { questionCount?: number; myStatus?: SubmissionStatus },
  ): Promise<PublicAssignment> {
    let config: Record<string, unknown> = {};
    try {
      config = JSON.parse(row.config_json || "{}");
    } catch {
      config = {};
    }
    let questionCount = opts?.questionCount;
    if (questionCount === undefined) {
      questionCount = (
        await this.db.get(
          `SELECT COUNT(*) AS c FROM assignment_questions WHERE assignment_id = ?`,
          row.id,
        ) as { c: number }
      ).c;
    }

    let knowledgePoints:
      | Array<{
          id: string;
          name: string;
          unitName?: string | null;
          pathLabel?: string;
        }>
      | undefined;
    const kids = config.knowledgeNodeIds;
    if (Array.isArray(kids) && kids.length) {
      knowledgePoints = this.knowledge.getMany(kids as string[]).map((n) => ({
        id: n.id,
        name: n.name,
        unitName: n.unitName,
        pathLabel: n.pathLabel,
      }));
    }

    return {
      id: row.id,
      classId: row.class_id,
      className,
      type: row.type as AssignmentType,
      title: row.title,
      description: row.description,
      status: row.status as AssignmentStatus,
      dueAt: row.due_at,
      config,
      createdBy: row.created_by,
      createdAt: row.created_at,
      publishedAt: row.published_at,
      questionCount,
      ...(opts?.myStatus != null ? { myStatus: opts.myStatus } : {}),
      knowledgePoints,
    };
  }

  private async toPublicSubmission(
    row: SubmissionRow,
    nickname?: string | null,
    includeAnswers = false,
    preloaded?: {
      photos?: PublicPhoto[];
      grade?: PublicGrade | null;
    },
  ): Promise<PublicSubmission> {
    let photos: PublicPhoto[];
    if (preloaded && "photos" in preloaded && preloaded.photos) {
      photos = preloaded.photos;
    } else if (preloaded && "photos" in preloaded) {
      photos = [];
    } else {
      photos = (
        await this.db.all(
          `SELECT id, url, sort_order FROM photo_assets
           WHERE submission_id = ? ORDER BY sort_order ASC`,
          row.id,
        ) as Array<{ id: string; url: string; sort_order: number }>
      ).map((p) => ({
        id: p.id,
        url: p.url,
        sortOrder: p.sort_order,
      }));
    }

    let grade: PublicGrade | null;
    if (preloaded && "grade" in preloaded) {
      grade = preloaded.grade ?? null;
    } else {
      const g = await this.db.get(
        `SELECT * FROM photo_grades WHERE submission_id = ?`,
        row.id,
      ) as
        | {
            result: GradeResult;
            score: number | null;
            comment: string | null;
            require_resubmit: number;
            graded_at: string;
          }
        | undefined;
      grade = g
        ? {
            result: g.result,
            score: g.score,
            comment: g.comment,
            requireResubmit: g.require_resubmit === 1,
            gradedAt: g.graded_at,
          }
        : null;
    }

    let answers: PublicAnswerItem[] = [];
    let correctRate: number | null = null;

    if (includeAnswers) {
      const asgType = (
        await this.db.get(`SELECT type FROM assignments WHERE id = ?`, row.assignment_id) as { type: string } | undefined
      )?.type;

      if (asgType && asgType !== "photo_homework") {
        const qMap = await this.loadQuestionMap(row.assignment_id);
        const items = await this.loadAnswerRows(row.id);
        const asgCfg = (
          await this.db.get(
            `SELECT config_json FROM assignments WHERE id = ?`,
            row.assignment_id,
          )
        ) as { config_json: string } | undefined;
        const revealAfterDone = this.readRevealAnswerAfterDone(
          asgCfg?.config_json || "{}",
        );
        // Never leak answer keys while correcting; only when completed + policy.
        const revealKey =
          row.status === "completed" && revealAfterDone;

        answers = items.map((it) => {
          const snap = qMap.get(it.assignment_question_id);
          let knowledgeLabel: string | undefined;
          if (snap?.knowledgeNodeId) {
            const kn = this.knowledge.getById(snap.knowledgeNodeId);
            knowledgeLabel = kn?.pathLabel || kn?.name;
          }
          const base: PublicAnswerItem = {
            assignmentQuestionId: it.assignment_question_id,
            response:
              it.response_json != null
                ? (JSON.parse(it.response_json) as string | boolean)
                : null,
            isCorrect:
              it.is_correct === null || it.is_correct === undefined
                ? null
                : it.is_correct === 1,
            correctionRound: it.correction_round,
            wrongReason: it.wrong_reason ?? null,
            revealKey,
            stem: snap?.stem,
            type: snap?.type,
            options: snap?.options ?? null,
            knowledgeLabel,
          };
          if (revealKey && snap && it.is_correct !== null) {
            base.correctAnswer = snap.answer;
            base.explanation = snap.explanation;
          }
          return base;
        });

        // ensure all questions appear for draft (even unanswered)
        if (
          row.status === "not_started" ||
          row.status === "in_progress"
        ) {
          const have = new Set(answers.map((a) => a.assignmentQuestionId));
          for (const [qid, snap] of qMap) {
            if (!have.has(qid)) {
              let knowledgeLabel: string | undefined;
              if (snap.knowledgeNodeId) {
                const kn = this.knowledge.getById(snap.knowledgeNodeId);
                knowledgeLabel = kn?.pathLabel || kn?.name;
              }
              answers.push({
                assignmentQuestionId: qid,
                response: null,
                isCorrect: null,
                correctionRound: 0,
                revealKey: false,
                stem: snap.stem,
                type: snap.type,
                options: snap.options,
                knowledgeLabel,
              });
            }
          }
        }

        if (row.score != null) correctRate = row.score;
      }
    }

    let timeLimitSec: number | null = null;
    let timeRemainingSec: number | null = null;
    try {
      const asg = await this.db.get(`SELECT config_json, type FROM assignments WHERE id = ?`, row.assignment_id) as
        | { config_json: string; type: string }
        | undefined;
      if (asg && asg.type !== "photo_homework") {
        timeLimitSec = await this.readTimeLimitSec(asg.config_json);
        if (
          timeLimitSec &&
          row.timer_started_at &&
          (row.status === "not_started" || row.status === "in_progress")
        ) {
          const elapsed =
            (Date.now() - new Date(row.timer_started_at).getTime()) / 1000;
          timeRemainingSec = Math.max(0, Math.ceil(timeLimitSec - elapsed));
        } else if (
          timeLimitSec &&
          (row.status === "not_started" || row.status === "in_progress")
        ) {
          timeRemainingSec = timeLimitSec;
        }
      }
    } catch {
      /* ignore */
    }

    return {
      id: row.id,
      assignmentId: row.assignment_id,
      studentId: row.student_id,
      studentNickname: nickname,
      status: row.status as SubmissionStatus,
      overdue: row.overdue === 1,
      score: row.score,
      correctRate,
      photos,
      grade,
      answers,
      submittedAt: row.submitted_at,
      updatedAt: row.updated_at,
      timerStartedAt: row.timer_started_at ?? null,
      timeLimitSec,
      timeRemainingSec,
    };
  }
}

interface AssignmentRow {
  id: string;
  class_id: string;
  type: string;
  title: string;
  description: string | null;
  status: string;
  due_at: string | null;
  config_json: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  published_at: string | null;
}

interface SubmissionRow {
  id: string;
  assignment_id: string;
  student_id: string;
  status: string;
  overdue: number;
  score: number | null;
  created_at: string;
  updated_at: string;
  submitted_at: string | null;
  timer_started_at?: string | null;
}
