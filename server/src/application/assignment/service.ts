import type Database from "better-sqlite3";
import { createId, nowIso } from "../../infrastructure/persistence/db.js";
import { AppError } from "../../domain/shared/errors.js";
import type {
  QuestionBankService,
  QuestionSnapshot,
} from "../questionbank/service.js";
import { gradeOne } from "../../domain/grading/auto-grade.js";
import { KnowledgeTreeService } from "../knowledge/service.js";

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
  /** Shown after first submit */
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
  constructor(
    private db: Database.Database,
    private questions?: QuestionBankService,
    private knowledge: KnowledgeTreeService = new KnowledgeTreeService(),
  ) {}

  create(
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
  ): PublicAssignment {
    this.assertTeacherOwnsActiveClass(teacherId, input.classId);
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
        const created = this.questions.createManyGenerated(
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

    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO assignments
           (id, class_id, type, title, description, status, due_at, config_json, created_by, created_at, updated_at, published_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
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
          publish ? ts : null,
        );

      if (questionIds.length) {
        this.attachQuestionsInternal(id, teacherId, questionIds, ts);
      }
    });
    tx();

    return this.getAssignment(id, teacherId)!;
  }

  /** Replace question set on a draft assignment */
  setQuestions(
    assignmentId: string,
    teacherId: string,
    questionIds: string[],
  ): PublicAssignmentQuestion[] {
    const row = this.getAssignmentRowOwned(assignmentId, teacherId);
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
    const tx = this.db.transaction(() => {
      this.db
        .prepare(`DELETE FROM assignment_questions WHERE assignment_id = ?`)
        .run(assignmentId);
      this.attachQuestionsInternal(assignmentId, teacherId, questionIds, ts);
      this.db
        .prepare(`UPDATE assignments SET updated_at = ? WHERE id = ?`)
        .run(ts, assignmentId);
    });
    tx();
    return this.listAssignmentQuestions(assignmentId, teacherId);
  }

  listAssignmentQuestions(
    assignmentId: string,
    userId: string,
  ): PublicAssignmentQuestion[] {
    // teacher or student member with access
    this.getAssignment(assignmentId, userId);
    const isTeacher = this.isClassTeacherOfAssignment(assignmentId, userId);

    const rows = this.db
      .prepare(
        `SELECT * FROM assignment_questions
         WHERE assignment_id = ?
         ORDER BY sort_order ASC`,
      )
      .all(assignmentId) as Array<{
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

  private isClassTeacherOfAssignment(
    assignmentId: string,
    userId: string,
  ): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 AS ok FROM assignments a
         JOIN classes c ON c.id = a.class_id
         WHERE a.id = ? AND c.teacher_id = ?`,
      )
      .get(assignmentId, userId) as { ok: number } | undefined;
    return !!row;
  }

  publish(assignmentId: string, teacherId: string): PublicAssignment {
    const row = this.getAssignmentRowOwned(assignmentId, teacherId);
    if (row.status === "published") {
      return this.toPublicAssignment(row);
    }
    if (row.status === "revoked") {
      throw new AppError("INVALID_STATUS", "已下架的作业不能重新发布，请复制新建");
    }
    this.assertClassActive(row.class_id);

    if (row.type !== "photo_homework") {
      const count = (
        this.db
          .prepare(
            `SELECT COUNT(*) AS c FROM assignment_questions WHERE assignment_id = ?`,
          )
          .get(assignmentId) as { c: number }
      ).c;
      if (!count) {
        throw new AppError("INVALID_QUESTIONS", "请先添加题目再发布");
      }
      // Freeze snapshots from current source at publish time
      this.refreezeSnapshotsFromSource(assignmentId, teacherId);
    }

    const ts = nowIso();
    this.db
      .prepare(
        `UPDATE assignments SET status = 'published', published_at = ?, updated_at = ? WHERE id = ?`,
      )
      .run(ts, ts, assignmentId);
    return this.getAssignment(assignmentId, teacherId)!;
  }

  private attachQuestionsInternal(
    assignmentId: string,
    teacherId: string,
    questionIds: string[],
    ts: string,
  ): void {
    if (!this.questions) {
      throw new AppError("INTERNAL", "题库服务未配置", 500);
    }
    const rows = this.questions.getManyOwned(questionIds, teacherId);
    const insert = this.db.prepare(
      `INSERT INTO assignment_questions
       (id, assignment_id, sort_order, source_question_id, question_snapshot, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    rows.forEach((q, i) => {
      const snap = this.questions!.getSnapshotById(q.id);
      // strip mutable source id from answer surface? keep id for debug as sourceQuestionId
      const snapshot: QuestionSnapshot = { ...snap };
      insert.run(
        createId("aq"),
        assignmentId,
        i,
        q.id,
        JSON.stringify(snapshot),
        ts,
      );
    });
  }

  /** Re-copy source questions into snapshots (draft → publish). */
  private refreezeSnapshotsFromSource(
    assignmentId: string,
    teacherId: string,
  ): void {
    if (!this.questions) return;
    const links = this.db
      .prepare(
        `SELECT id, source_question_id, sort_order FROM assignment_questions
         WHERE assignment_id = ? ORDER BY sort_order`,
      )
      .all(assignmentId) as Array<{
      id: string;
      source_question_id: string | null;
      sort_order: number;
    }>;

    const update = this.db.prepare(
      `UPDATE assignment_questions SET question_snapshot = ? WHERE id = ?`,
    );
    for (const link of links) {
      if (!link.source_question_id) continue;
      // ensure ownership
      this.questions.getManyOwned([link.source_question_id], teacherId);
      const snap = this.questions.getSnapshotById(link.source_question_id);
      update.run(JSON.stringify(snap), link.id);
    }
  }

  revoke(assignmentId: string, teacherId: string): PublicAssignment {
    this.getAssignmentRowOwned(assignmentId, teacherId);
    const ts = nowIso();
    this.db
      .prepare(
        `UPDATE assignments SET status = 'revoked', updated_at = ? WHERE id = ?`,
      )
      .run(ts, assignmentId);
    return this.getAssignment(assignmentId, teacherId)!;
  }

  listForTeacher(
    teacherId: string,
    opts?: { classId?: string; status?: AssignmentStatus },
  ): PublicAssignment[] {
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
    sql += ` ORDER BY a.created_at DESC`;
    const rows = this.db.prepare(sql).all(...params) as Array<
      AssignmentRow & { class_name: string }
    >;
    return rows.map((r) => this.toPublicAssignment(r, r.class_name));
  }

  listForStudent(studentId: string): PublicAssignment[] {
    const rows = this.db
      .prepare(
        `
        SELECT a.*, c.name AS class_name
        FROM assignments a
        JOIN classes c ON c.id = a.class_id
        JOIN class_memberships m ON m.class_id = c.id AND m.user_id = ?
        WHERE a.status = 'published'
          AND c.archived = 0
        ORDER BY a.due_at IS NULL, a.due_at ASC, a.published_at DESC
        `,
      )
      .all(studentId) as Array<AssignmentRow & { class_name: string }>;
    return rows.map((r) => this.toPublicAssignment(r, r.class_name));
  }

  getAssignment(
    assignmentId: string,
    userId: string,
  ): PublicAssignment | null {
    const row = this.db
      .prepare(
        `SELECT a.*, c.name AS class_name, c.teacher_id
         FROM assignments a
         JOIN classes c ON c.id = a.class_id
         WHERE a.id = ?`,
      )
      .get(assignmentId) as
      | (AssignmentRow & { class_name: string; teacher_id: string })
      | undefined;
    if (!row) return null;

    if (row.teacher_id === userId) {
      return this.toPublicAssignment(row, row.class_name);
    }

    const member = this.db
      .prepare(
        `SELECT 1 FROM class_memberships WHERE class_id = ? AND user_id = ?`,
      )
      .get(row.class_id, userId);
    if (!member) {
      throw new AppError("FORBIDDEN", "无权查看该作业", 403);
    }
    if (row.status !== "published") {
      throw new AppError("FORBIDDEN", "作业未发布", 403);
    }
    return this.toPublicAssignment(row, row.class_name);
  }

  getOrCreateMySubmission(
    assignmentId: string,
    studentId: string,
  ): PublicSubmission {
    this.assertStudentCanAccessPublished(assignmentId, studentId);
    let sub = this.findSubmission(assignmentId, studentId);
    if (!sub) {
      const id = createId("sub");
      const ts = nowIso();
      const asg = this.db
        .prepare(`SELECT type, config_json FROM assignments WHERE id = ?`)
        .get(assignmentId) as { type: string; config_json: string };
      const limit = this.readTimeLimitSec(asg.config_json);
      const timerStart =
        asg.type !== "photo_homework" && limit ? ts : null;
      this.db
        .prepare(
          `INSERT INTO submissions
           (id, assignment_id, student_id, status, overdue, score, created_at, updated_at, submitted_at, timer_started_at)
           VALUES (?, ?, ?, 'not_started', 0, NULL, ?, ?, NULL, ?)`,
        )
        .run(id, assignmentId, studentId, ts, ts, timerStart);
      sub = this.findSubmission(assignmentId, studentId)!;
    } else {
      // start timer on first open for timed online work
      const asg = this.db
        .prepare(`SELECT type, config_json FROM assignments WHERE id = ?`)
        .get(assignmentId) as { type: string; config_json: string };
      const limit = this.readTimeLimitSec(asg.config_json);
      if (
        asg.type !== "photo_homework" &&
        limit &&
        !sub.timer_started_at &&
        (sub.status === "not_started" || sub.status === "in_progress")
      ) {
        const ts = nowIso();
        this.db
          .prepare(
            `UPDATE submissions SET timer_started_at = ?, updated_at = ? WHERE id = ?`,
          )
          .run(ts, ts, sub.id);
        sub = this.findSubmission(assignmentId, studentId)!;
      }
    }
    return this.toPublicSubmission(sub, undefined, true);
  }

  /** Duplicate assignment as a new draft (independent snapshots). */
  duplicate(assignmentId: string, teacherId: string): PublicAssignment {
    const row = this.getAssignmentRowOwned(assignmentId, teacherId);
    this.assertTeacherOwnsActiveClass(teacherId, row.class_id);

    const newId = createId("asg");
    const ts = nowIso();
    const title = `${row.title}（副本）`.slice(0, 80);

    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO assignments
           (id, class_id, type, title, description, status, due_at, config_json, created_by, created_at, updated_at, published_at)
           VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, NULL)`,
        )
        .run(
          newId,
          row.class_id,
          row.type,
          title,
          row.description,
          row.due_at,
          row.config_json,
          teacherId,
          ts,
          ts,
        );

      const qs = this.db
        .prepare(
          `SELECT sort_order, source_question_id, question_snapshot
           FROM assignment_questions WHERE assignment_id = ? ORDER BY sort_order`,
        )
        .all(assignmentId) as Array<{
        sort_order: number;
        source_question_id: string | null;
        question_snapshot: string;
      }>;

      const insert = this.db.prepare(
        `INSERT INTO assignment_questions
         (id, assignment_id, sort_order, source_question_id, question_snapshot, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const q of qs) {
        insert.run(
          createId("aq"),
          newId,
          q.sort_order,
          q.source_question_id,
          q.question_snapshot,
          ts,
        );
      }
    });
    tx();
    return this.getAssignment(newId, teacherId)!;
  }

  /**
   * Save draft answers for online assignment (mid-way resume).
   */
  saveDraftAnswers(
    submissionId: string,
    studentId: string,
    answers: Array<{ assignmentQuestionId: string; response: unknown }>,
  ): PublicSubmission {
    const sub = this.getSubmissionRow(submissionId);
    if (sub.student_id !== studentId) {
      throw new AppError("FORBIDDEN", "只能保存自己的作答", 403);
    }
    this.assertOnlineAssignment(sub.assignment_id);
    this.assertStudentCanAccessPublished(sub.assignment_id, studentId);

    if (sub.status === "completed") {
      throw new AppError("INVALID_STATUS", "已完成，不能再改");
    }
    if (sub.status === "pending_correction") {
      throw new AppError("INVALID_STATUS", "请使用订正接口提交错题");
    }

    const qMap = this.loadQuestionMap(sub.assignment_id);
    const ts = nowIso();
    const tx = this.db.transaction(() => {
      for (const a of answers) {
        if (!qMap.has(a.assignmentQuestionId)) {
          throw new AppError("INVALID_QUESTION", "题目不属于该作业");
        }
        this.upsertAnswerItem(
          submissionId,
          a.assignmentQuestionId,
          a.response,
          null,
          0,
          ts,
        );
      }
      if (sub.status === "not_started" || sub.status === "in_progress") {
        this.db
          .prepare(
            `UPDATE submissions SET status = 'in_progress', updated_at = ? WHERE id = ?`,
          )
          .run(ts, submissionId);
      }
    });
    tx();
    return this.toPublicSubmission(
      this.getSubmissionRow(submissionId),
      undefined,
      true,
    );
  }

  /**
   * First submit (or resubmit all while in_progress): auto-grade entire paper.
   * @param force when true (timer auto-submit), unanswered items count as wrong
   */
  submitOnlineAnswers(
    submissionId: string,
    studentId: string,
    answers: Array<{ assignmentQuestionId: string; response: unknown }>,
    opts?: { force?: boolean },
  ): PublicSubmission {
    const sub = this.getSubmissionRow(submissionId);
    if (sub.student_id !== studentId) {
      throw new AppError("FORBIDDEN", "只能提交自己的作答", 403);
    }
    this.assertOnlineAssignment(sub.assignment_id);
    this.assertStudentCanAccessPublished(sub.assignment_id, studentId);

    if (
      sub.status !== "not_started" &&
      sub.status !== "in_progress"
    ) {
      throw new AppError(
        "INVALID_STATUS",
        "当前状态不可整卷提交，请使用订正",
      );
    }

    const qMap = this.loadQuestionMap(sub.assignment_id);
    if (!qMap.size) {
      throw new AppError("INVALID_QUESTIONS", "作业无题目");
    }

    // merge with existing draft
    const existing = this.loadAnswerRows(submissionId);
    const responseMap = new Map<string, unknown>();
    for (const e of existing) {
      if (e.response_json != null) {
        responseMap.set(e.assignment_question_id, JSON.parse(e.response_json));
      }
    }
    for (const a of answers) {
      responseMap.set(a.assignmentQuestionId, a.response);
    }

    const force = opts?.force === true;
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

    const assignment = this.db
      .prepare(`SELECT due_at, status, config_json FROM assignments WHERE id = ?`)
      .get(sub.assignment_id) as {
      due_at: string | null;
      status: string;
      config_json: string;
    };
    if (assignment.status !== "published") {
      throw new AppError("INVALID_STATUS", "作业未发布或已下架");
    }

    // If timed and not force, still allow normal submit
    // If force, verify timer actually expired (or allow for tests with force)
    if (force) {
      const limit = this.readTimeLimitSec(assignment.config_json);
      if (limit && sub.timer_started_at) {
        const elapsed =
          (Date.now() - new Date(sub.timer_started_at).getTime()) / 1000;
        // allow 2s clock skew
        if (elapsed < limit - 2) {
          throw new AppError("TIMER_ACTIVE", "限时尚未结束");
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

    const tx = this.db.transaction(() => {
      for (const [qid, snap] of qMap) {
        const resp = responseMap.has(qid) ? responseMap.get(qid) : null;
        const { correct } = gradeOne(snap, resp);
        if (correct) correctCount += 1;
        this.upsertAnswerItem(submissionId, qid, resp, correct, 0, ts);
      }
      const allCorrect = correctCount === total;
      const score = Math.round((correctCount / total) * 1000) / 10;
      this.db
        .prepare(
          `UPDATE submissions
           SET status = ?, overdue = ?, score = ?,
               submitted_at = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          allCorrect ? "completed" : "pending_correction",
          overdue,
          score,
          ts,
          ts,
          submissionId,
        );
    });
    tx();

    return this.toPublicSubmission(
      this.getSubmissionRow(submissionId),
      undefined,
      true,
    );
  }

  private readTimeLimitSec(configJson: string): number | null {
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
   * Correct only wrong items; all must become correct to complete.
   */
  correctOnlineAnswers(
    submissionId: string,
    studentId: string,
    answers: Array<{ assignmentQuestionId: string; response: unknown }>,
  ): PublicSubmission {
    const sub = this.getSubmissionRow(submissionId);
    if (sub.student_id !== studentId) {
      throw new AppError("FORBIDDEN", "只能订正自己的作答", 403);
    }
    this.assertOnlineAssignment(sub.assignment_id);
    this.assertStudentCanAccessPublished(sub.assignment_id, studentId);

    if (sub.status !== "pending_correction") {
      throw new AppError("INVALID_STATUS", "当前无需订正");
    }

    const qMap = this.loadQuestionMap(sub.assignment_id);
    const rows = this.loadAnswerRows(submissionId);
    const wrongIds = new Set(
      rows.filter((r) => r.is_correct === 0).map((r) => r.assignment_question_id),
    );
    if (!wrongIds.size) {
      // nothing wrong — mark completed
      const ts = nowIso();
      this.db
        .prepare(
          `UPDATE submissions SET status = 'completed', score = 100, updated_at = ? WHERE id = ?`,
        )
        .run(ts, submissionId);
      return this.toPublicSubmission(
        this.getSubmissionRow(submissionId),
        undefined,
        true,
      );
    }

    const ts = nowIso();
    const tx = this.db.transaction(() => {
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
        this.upsertAnswerItem(
          submissionId,
          a.assignmentQuestionId,
          a.response,
          correct,
          round,
          ts,
        );
      }

      // re-check all
      const after = this.loadAnswerRows(submissionId);
      const stillWrong = after.some((r) => r.is_correct !== 1);
      const correctCount = after.filter((r) => r.is_correct === 1).length;
      const total = after.length || qMap.size;
      const score = Math.round((correctCount / total) * 1000) / 10;

      const assignment = this.db
        .prepare(`SELECT due_at FROM assignments WHERE id = ?`)
        .get(sub.assignment_id) as { due_at: string | null };
      const overdue =
        assignment.due_at && new Date(assignment.due_at).getTime() < Date.now()
          ? 1
          : sub.overdue;

      this.db
        .prepare(
          `UPDATE submissions SET status = ?, score = ?, overdue = ?, updated_at = ? WHERE id = ?`,
        )
        .run(
          stillWrong ? "pending_correction" : "completed",
          score,
          overdue,
          ts,
          submissionId,
        );
    });
    tx();

    return this.toPublicSubmission(
      this.getSubmissionRow(submissionId),
      undefined,
      true,
    );
  }

  private assertOnlineAssignment(assignmentId: string): void {
    const row = this.db
      .prepare(`SELECT type FROM assignments WHERE id = ?`)
      .get(assignmentId) as { type: string } | undefined;
    if (!row || row.type === "photo_homework") {
      throw new AppError("INVALID_TYPE", "仅在线作业支持此操作");
    }
  }

  private loadQuestionMap(
    assignmentId: string,
  ): Map<string, QuestionSnapshot> {
    const rows = this.db
      .prepare(
        `SELECT id, question_snapshot FROM assignment_questions WHERE assignment_id = ?`,
      )
      .all(assignmentId) as Array<{ id: string; question_snapshot: string }>;
    const map = new Map<string, QuestionSnapshot>();
    for (const r of rows) {
      map.set(r.id, JSON.parse(r.question_snapshot) as QuestionSnapshot);
    }
    return map;
  }

  private loadAnswerRows(submissionId: string): Array<{
    assignment_question_id: string;
    response_json: string | null;
    is_correct: number | null;
    correction_round: number;
  }> {
    return this.db
      .prepare(`SELECT * FROM answer_items WHERE submission_id = ?`)
      .all(submissionId) as Array<{
      assignment_question_id: string;
      response_json: string | null;
      is_correct: number | null;
      correction_round: number;
    }>;
  }

  private upsertAnswerItem(
    submissionId: string,
    assignmentQuestionId: string,
    response: unknown,
    isCorrect: boolean | null,
    correctionRound: number,
    ts: string,
  ): void {
    const existing = this.db
      .prepare(
        `SELECT id FROM answer_items WHERE submission_id = ? AND assignment_question_id = ?`,
      )
      .get(submissionId, assignmentQuestionId) as { id: string } | undefined;

    const responseJson =
      response === undefined ? null : JSON.stringify(response);
    const correctInt =
      isCorrect === null || isCorrect === undefined ? null : isCorrect ? 1 : 0;

    if (existing) {
      this.db
        .prepare(
          `UPDATE answer_items
           SET response_json = ?, is_correct = ?, correction_round = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          responseJson,
          correctInt,
          correctionRound,
          ts,
          existing.id,
        );
    } else {
      this.db
        .prepare(
          `INSERT INTO answer_items
           (id, submission_id, assignment_question_id, response_json, is_correct, correction_round, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          createId("ans"),
          submissionId,
          assignmentQuestionId,
          responseJson,
          correctInt,
          correctionRound,
          ts,
        );
    }
  }

  submitPhotos(
    submissionId: string,
    studentId: string,
    photoUrls: string[],
  ): PublicSubmission {
    const sub = this.getSubmissionRow(submissionId);
    if (sub.student_id !== studentId) {
      throw new AppError("FORBIDDEN", "只能提交自己的作业", 403);
    }
    this.assertStudentCanAccessPublished(sub.assignment_id, studentId);

    if (
      sub.status !== "not_started" &&
      sub.status !== "resubmit_required" &&
      sub.status !== "submitted"
    ) {
      // allow re-submit only when not_started, resubmit_required; also allow replace while still submitted (before grade)
      if (sub.status === "completed") {
        throw new AppError("INVALID_STATUS", "作业已批改完成，不能再提交");
      }
    }

    if (sub.status === "completed") {
      throw new AppError("INVALID_STATUS", "作业已完成");
    }

    const urls = photoUrls.map((u) => u.trim()).filter(Boolean);
    if (!urls.length) {
      throw new AppError("INVALID_PHOTOS", "请至少上传 1 张照片");
    }
    if (urls.length > MAX_PHOTOS) {
      throw new AppError("INVALID_PHOTOS", `最多上传 ${MAX_PHOTOS} 张照片`);
    }
    for (const u of urls) {
      if (!u.startsWith("/uploads/")) {
        throw new AppError("INVALID_PHOTOS", "图片地址无效");
      }
    }

    const assignment = this.db
      .prepare(`SELECT due_at, status FROM assignments WHERE id = ?`)
      .get(sub.assignment_id) as { due_at: string | null; status: string };
    if (assignment.status !== "published") {
      throw new AppError("INVALID_STATUS", "作业未发布或已下架");
    }

    const ts = nowIso();
    const overdue =
      assignment.due_at && new Date(assignment.due_at).getTime() < Date.now()
        ? 1
        : 0;

    const tx = this.db.transaction(() => {
      this.db
        .prepare(`DELETE FROM photo_assets WHERE submission_id = ?`)
        .run(submissionId);
      // clear previous grade when resubmitting
      this.db
        .prepare(`DELETE FROM photo_grades WHERE submission_id = ?`)
        .run(submissionId);

      const insert = this.db.prepare(
        `INSERT INTO photo_assets (id, submission_id, url, sort_order, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      );
      urls.forEach((url, i) => {
        insert.run(createId("ph"), submissionId, url, i, ts);
      });

      this.db
        .prepare(
          `UPDATE submissions
           SET status = 'submitted', overdue = ?, score = NULL,
               submitted_at = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(overdue, ts, ts, submissionId);
    });
    tx();

    return this.toPublicSubmission(this.getSubmissionRow(submissionId));
  }

  gradePhoto(
    submissionId: string,
    teacherId: string,
    input: {
      result: GradeResult;
      score?: number | null;
      comment?: string | null;
      requireResubmit?: boolean;
    },
  ): PublicSubmission {
    const sub = this.getSubmissionRow(submissionId);
    const asg = this.getAssignmentRowOwned(sub.assignment_id, teacherId);

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
      this.db
        .prepare(
          `SELECT COUNT(*) AS c FROM photo_assets WHERE submission_id = ?`,
        )
        .get(submissionId) as { c: number }
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

    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO photo_grades
             (submission_id, result, score, comment, require_resubmit, graded_by, graded_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(submission_id) DO UPDATE SET
             result = excluded.result,
             score = excluded.score,
             comment = excluded.comment,
             require_resubmit = excluded.require_resubmit,
             graded_by = excluded.graded_by,
             graded_at = excluded.graded_at`,
        )
        .run(
          submissionId,
          input.result,
          score,
          input.comment?.trim() || null,
          requireResubmit ? 1 : 0,
          teacherId,
          ts,
        );

      this.db
        .prepare(
          `UPDATE submissions SET status = ?, score = ?, updated_at = ? WHERE id = ?`,
        )
        .run(newStatus, requireResubmit ? null : score, ts, submissionId);
    });
    tx();

    return this.toPublicSubmission(this.getSubmissionRow(submissionId));
  }

  listSubmissionsForTeacher(
    assignmentId: string,
    teacherId: string,
  ): PublicSubmission[] {
    this.getAssignmentRowOwned(assignmentId, teacherId);
    const rows = this.db
      .prepare(
        `
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
        `,
      )
      .all(assignmentId) as Array<SubmissionRow & { nickname: string | null }>;

    return rows.map((r) => this.toPublicSubmission(r, r.nickname));
  }

  listPendingGradeCount(teacherId: string): number {
    const row = this.db
      .prepare(
        `
        SELECT COUNT(*) AS c
        FROM submissions s
        JOIN assignments a ON a.id = s.assignment_id
        JOIN classes c ON c.id = a.class_id
        WHERE c.teacher_id = ?
          AND a.status = 'published'
          AND s.status = 'submitted'
        `,
      )
      .get(teacherId) as { c: number };
    return row.c;
  }

  // —— helpers ——

  private assertTeacherOwnsActiveClass(
    teacherId: string,
    classId: string,
  ): void {
    const row = this.db
      .prepare(`SELECT teacher_id, archived FROM classes WHERE id = ?`)
      .get(classId) as { teacher_id: string; archived: number } | undefined;
    if (!row) throw new AppError("NOT_FOUND", "班级不存在", 404);
    if (row.teacher_id !== teacherId) {
      throw new AppError("FORBIDDEN", "只能在自己的班级布置作业", 403);
    }
    if (row.archived) {
      throw new AppError("CLASS_ARCHIVED", "归档班级不能布置作业");
    }
  }

  private assertClassActive(classId: string): void {
    const row = this.db
      .prepare(`SELECT archived FROM classes WHERE id = ?`)
      .get(classId) as { archived: number } | undefined;
    if (!row) throw new AppError("NOT_FOUND", "班级不存在", 404);
    if (row.archived) {
      throw new AppError("CLASS_ARCHIVED", "归档班级不能发布作业");
    }
  }

  private getAssignmentRowOwned(
    assignmentId: string,
    teacherId: string,
  ): AssignmentRow {
    const row = this.db
      .prepare(
        `SELECT a.* FROM assignments a
         JOIN classes c ON c.id = a.class_id
         WHERE a.id = ? AND c.teacher_id = ?`,
      )
      .get(assignmentId, teacherId) as AssignmentRow | undefined;
    if (!row) throw new AppError("NOT_FOUND", "作业不存在或无权操作", 404);
    return row;
  }

  private assertStudentCanAccessPublished(
    assignmentId: string,
    studentId: string,
  ): AssignmentRow {
    const row = this.db
      .prepare(
        `
        SELECT a.*
        FROM assignments a
        JOIN class_memberships m ON m.class_id = a.class_id AND m.user_id = ?
        JOIN classes c ON c.id = a.class_id
        WHERE a.id = ? AND a.status = 'published' AND c.archived = 0
        `,
      )
      .get(studentId, assignmentId) as AssignmentRow | undefined;
    if (!row) {
      throw new AppError("FORBIDDEN", "无权访问该作业", 403);
    }
    return row;
  }

  private findSubmission(
    assignmentId: string,
    studentId: string,
  ): SubmissionRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM submissions WHERE assignment_id = ? AND student_id = ?`,
      )
      .get(assignmentId, studentId) as SubmissionRow | undefined;
  }

  private getSubmissionRow(id: string): SubmissionRow {
    const row = this.db
      .prepare(`SELECT * FROM submissions WHERE id = ?`)
      .get(id) as SubmissionRow | undefined;
    if (!row) throw new AppError("NOT_FOUND", "提交记录不存在", 404);
    return row;
  }

  private toPublicAssignment(
    row: AssignmentRow,
    className?: string,
  ): PublicAssignment {
    let config: Record<string, unknown> = {};
    try {
      config = JSON.parse(row.config_json || "{}");
    } catch {
      config = {};
    }
    const questionCount = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS c FROM assignment_questions WHERE assignment_id = ?`,
        )
        .get(row.id) as { c: number }
    ).c;

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
      knowledgePoints,
    };
  }

  private toPublicSubmission(
    row: SubmissionRow,
    nickname?: string | null,
    includeAnswers = false,
  ): PublicSubmission {
    const photos = (
      this.db
        .prepare(
          `SELECT id, url, sort_order FROM photo_assets
           WHERE submission_id = ? ORDER BY sort_order ASC`,
        )
        .all(row.id) as Array<{ id: string; url: string; sort_order: number }>
    ).map((p) => ({
      id: p.id,
      url: p.url,
      sortOrder: p.sort_order,
    }));

    const g = this.db
      .prepare(`SELECT * FROM photo_grades WHERE submission_id = ?`)
      .get(row.id) as
      | {
          result: GradeResult;
          score: number | null;
          comment: string | null;
          require_resubmit: number;
          graded_at: string;
        }
      | undefined;

    let answers: PublicAnswerItem[] = [];
    let correctRate: number | null = null;

    if (includeAnswers) {
      const asgType = (
        this.db
          .prepare(`SELECT type FROM assignments WHERE id = ?`)
          .get(row.assignment_id) as { type: string } | undefined
      )?.type;

      if (asgType && asgType !== "photo_homework") {
        const qMap = this.loadQuestionMap(row.assignment_id);
        const items = this.loadAnswerRows(row.id);
        const showKey =
          row.status === "pending_correction" ||
          row.status === "completed" ||
          row.status === "submitted";

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
            stem: snap?.stem,
            type: snap?.type,
            options: snap?.options ?? null,
            knowledgeLabel,
          };
          if (showKey && snap && it.is_correct !== null) {
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
      const asg = this.db
        .prepare(`SELECT config_json, type FROM assignments WHERE id = ?`)
        .get(row.assignment_id) as
        | { config_json: string; type: string }
        | undefined;
      if (asg && asg.type !== "photo_homework") {
        timeLimitSec = this.readTimeLimitSec(asg.config_json);
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
      grade: g
        ? {
            result: g.result,
            score: g.score,
            comment: g.comment,
            requireResubmit: g.require_resubmit === 1,
            gradedAt: g.graded_at,
          }
        : null,
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
