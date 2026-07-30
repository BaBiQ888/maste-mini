import type { AppDatabase } from "../../infrastructure/persistence/db.js";
import { AppError } from "../../domain/shared/errors.js";
import {
  computeStreakDays,
  countMonthLitDays,
  shanghaiYmd,
} from "../../domain/mastery/streak.js";
import {
  computeCalendarDayState,
  type CalendarDayState,
} from "../../domain/mastery/rules.js";
import { KnowledgeTreeService } from "../knowledge/service.js";

export interface StudentBrief {
  userId: string;
  nickname: string | null;
  status:
    | "not_started"
    | "in_progress"
    | "submitted"
    | "pending_correction"
    | "resubmit_required"
    | "completed";
  overdue: boolean;
}

export interface AssignmentSummary {
  assignmentId: string;
  title: string;
  classId: string;
  className: string;
  type: string;
  status: string;
  dueAt: string | null;
  /** 在册学生数（分母） */
  totalStudents: number;
  /** 已完成人数（分子） */
  completedCount: number;
  /** 进行中：已提交待批改 / 需重交 */
  inProgressCount: number;
  /** 未开始 */
  notStartedCount: number;
  /** 未完成且已逾期（可与其它态重叠统计时单独展示） */
  overdueCount: number;
  /** 0–100，无学生时为 null */
  completionRate: number | null;
  incomplete: StudentBrief[];
  completed: StudentBrief[];
  inProgress: StudentBrief[];
  notStarted: StudentBrief[];
}

export interface ClassDashboard {
  classId: string;
  className: string;
  studentCount: number;
  pendingGrade: number;
  recentAssignments: Array<{
    id: string;
    title: string;
    type: string;
    status: string;
    completionRate: number | null;
    completedCount: number;
    totalStudents: number;
    pendingGrade: number;
  }>;
}

export interface QuestionStat {
  assignmentQuestionId: string;
  sortOrder: number;
  stem: string;
  type: string;
  knowledgeNodeId: string | null;
  /** Students who have a graded answer on this item */
  answeredCount: number;
  correctCount: number;
  /** 0–100, null if no answers yet */
  correctRate: number | null;
}

export interface StudentClassStats {
  classId: string;
  className: string;
  studentId: string;
  nickname: string | null;
  days: number;
  /** Published assignments in class within window (by published_at/created) */
  assignmentTotal: number;
  completedCount: number;
  completionRate: number | null;
  /** Online items with is_correct not null in window */
  answerTotal: number;
  answerCorrect: number;
  correctRate: number | null;
  recent: Array<{
    assignmentId: string;
    title: string;
    type: string;
    status: string;
    score: number | null;
    completedAt: string | null;
  }>;
}

export interface CalendarDay {
  date: string; // YYYY-MM-DD
  completedCount: number;
  /** S4: none | done | partial | review_due */
  state: CalendarDayState;
  overdueCount: number;
  hasReviewDue: boolean;
}

export interface KnowledgeDoneItem {
  knowledgeNodeId: string;
  name: string;
  unitName?: string | null;
  pathLabel?: string;
  completedCount: number;
  lastCompletedAt: string | null;
}

export class ProgressService {
  private knowledge = new KnowledgeTreeService();

  constructor(private db: AppDatabase) {}

  async getAssignmentSummary(
    assignmentId: string,
    teacherId: string,
  ): Promise<AssignmentSummary> {
    const asg = await this.db.get(`
        SELECT a.*, c.name AS class_name, c.teacher_id
        FROM assignments a
        JOIN classes c ON c.id = a.class_id
        WHERE a.id = ?
        `, assignmentId) as
      | {
          id: string;
          title: string;
          class_id: string;
          class_name: string;
          teacher_id: string;
          type: string;
          status: string;
          due_at: string | null;
        }
      | undefined;

    if (!asg) throw new AppError("NOT_FOUND", "作业不存在", 404);
    if (asg.teacher_id !== teacherId) {
      throw new AppError("FORBIDDEN", "无权查看该作业汇总", 403);
    }

    const students = await this.db.all(`
        SELECT u.id, u.nickname
        FROM class_memberships m
        JOIN users u ON u.id = m.user_id
        WHERE m.class_id = ? AND m.role = 'student'
        ORDER BY m.joined_at ASC
        `, asg.class_id) as Array<{ id: string; nickname: string | null }>;

    const submissions = await this.db.all(`
        SELECT student_id, status, overdue
        FROM submissions
        WHERE assignment_id = ?
        `, assignmentId) as Array<{
      student_id: string;
      status: string;
      overdue: number;
    }>;

    const subMap = new Map(submissions.map((s) => [s.student_id, s]));
    const duePast =
      !!asg.due_at && new Date(asg.due_at).getTime() < Date.now();

    const incomplete: StudentBrief[] = [];
    const completed: StudentBrief[] = [];
    const inProgress: StudentBrief[] = [];
    const notStarted: StudentBrief[] = [];
    let overdueCount = 0;

    for (const st of students) {
      const sub = subMap.get(st.id);
      const status = (sub?.status || "not_started") as StudentBrief["status"];
      const overdue =
        status !== "completed" &&
        (sub?.overdue === 1 || duePast);

      const brief: StudentBrief = {
        userId: st.id,
        nickname: st.nickname,
        status,
        overdue,
      };

      if (status === "completed") {
        completed.push(brief);
      } else if (
        status === "submitted" ||
        status === "resubmit_required" ||
        status === "pending_correction" ||
        status === "in_progress"
      ) {
        inProgress.push(brief);
        incomplete.push(brief);
        if (overdue) overdueCount += 1;
      } else {
        notStarted.push(brief);
        incomplete.push(brief);
        if (overdue) overdueCount += 1;
      }
    }

    const totalStudents = students.length;
    const completedCount = completed.length;
    const completionRate =
      totalStudents === 0
        ? null
        : Math.round((completedCount / totalStudents) * 1000) / 10;

    return {
      assignmentId: asg.id,
      title: asg.title,
      classId: asg.class_id,
      className: asg.class_name,
      type: asg.type,
      status: asg.status,
      dueAt: asg.due_at,
      totalStudents,
      completedCount,
      inProgressCount: inProgress.length,
      notStartedCount: notStarted.length,
      overdueCount,
      completionRate,
      incomplete,
      completed,
      inProgress,
      notStarted,
    };
  }

  async buildReminderText(assignmentId: string, teacherId: string): Promise<string> {
    const summary = await this.getAssignmentSummary(assignmentId, teacherId);
    const names = summary.incomplete.map(
      (s) => s.nickname?.trim() || "未命名同学",
    );
    const nameLine =
      names.length === 0 ? "（全员已完成）" : names.join("、");

    return [
      "【算本】作业催交提醒",
      `作业：${summary.title}`,
      `班级：${summary.className}`,
      `完成：${summary.completedCount}/${summary.totalStudents}` +
        (summary.completionRate != null
          ? `（${summary.completionRate}%）`
          : ""),
      `未完成同学：${nameLine}`,
      "请尽快完成并提交，谢谢。",
    ].join("\n");
  }

  async getClassDashboard(classId: string, teacherId: string): Promise<ClassDashboard> {
    const cls = await this.db.get(`SELECT id, name, teacher_id FROM classes WHERE id = ?`, classId) as
      | { id: string; name: string; teacher_id: string }
      | undefined;
    if (!cls) throw new AppError("NOT_FOUND", "班级不存在", 404);
    if (cls.teacher_id !== teacherId) {
      throw new AppError("FORBIDDEN", "无权查看该班学情", 403);
    }

    const studentCount = (
      await this.db.get(`SELECT COUNT(*) AS c FROM class_memberships
           WHERE class_id = ? AND role = 'student'`, classId) as { c: number }
    ).c;

    const pendingGrade = (
      await this.db.get(`
          SELECT COUNT(*) AS c
          FROM submissions s
          JOIN assignments a ON a.id = s.assignment_id
          WHERE a.class_id = ? AND a.status = 'published' AND s.status = 'submitted'
          `, classId) as { c: number }
    ).c;

    const recent = await this.db.all(`
        SELECT id, title, type, status
        FROM assignments
        WHERE class_id = ?
        ORDER BY created_at DESC
        LIMIT 10
        `, classId) as Array<{
      id: string;
      title: string;
      type: string;
      status: string;
    }>;

    // Batch pending + completed counts for recent ids (avoid N×getAssignmentSummary)
    const recentIds = recent.map((a) => a.id);
    const pendingByAsg = new Map<string, number>();
    const completedByAsg = new Map<string, number>();
    if (recentIds.length) {
      const ph = recentIds.map(() => "?").join(",");
      const [pendingRows, completedRows] = await Promise.all([
        this.db.all<{ id: string; c: number }>(
          `SELECT assignment_id AS id, COUNT(*) AS c FROM submissions
             WHERE assignment_id IN (${ph}) AND status = 'submitted'
             GROUP BY assignment_id`,
          ...recentIds,
        ),
        // Only count current class members (same denominator logic as getAssignmentSummary)
        this.db.all<{ id: string; c: number }>(
          `SELECT s.assignment_id AS id, COUNT(*) AS c
             FROM submissions s
             JOIN class_memberships m
               ON m.user_id = s.student_id AND m.class_id = ? AND m.role = 'student'
             WHERE s.assignment_id IN (${ph}) AND s.status = 'completed'
             GROUP BY s.assignment_id`,
          classId,
          ...recentIds,
        ),
      ]);
      for (const r of pendingRows) pendingByAsg.set(r.id, Number(r.c) || 0);
      for (const r of completedRows) completedByAsg.set(r.id, Number(r.c) || 0);
    }

    const totalStudents = studentCount;
    const recentAssignments = recent.map((a) => {
      const completedCount = completedByAsg.get(a.id) ?? 0;
      const completionRate =
        totalStudents === 0
          ? null
          : Math.round((completedCount / totalStudents) * 1000) / 10;
      return {
        id: a.id,
        title: a.title,
        type: a.type,
        status: a.status,
        completionRate,
        completedCount,
        totalStudents,
        pendingGrade: pendingByAsg.get(a.id) ?? 0,
      };
    });

    return {
      classId: cls.id,
      className: cls.name,
      studentCount,
      pendingGrade,
      recentAssignments,
    };
  }

  /** Student: count tasks not yet completed (one query, no N+1) */
  async countStudentIncomplete(studentId: string): Promise<number> {
    const row = (await this.db.get(
      `
        SELECT COUNT(*) AS c
        FROM assignments a
        JOIN class_memberships m ON m.class_id = a.class_id AND m.user_id = ?
        JOIN classes c ON c.id = a.class_id
        LEFT JOIN submissions s
          ON s.assignment_id = a.id AND s.student_id = ?
        WHERE a.status = 'published'
          AND c.archived = 0
          AND (s.id IS NULL OR s.status != 'completed')
        `,
      studentId,
      studentId,
    )) as { c: number };
    return Number(row?.c) || 0;
  }

  /**
   * Per-question class correct rate for online assignments.
   * Uses latest graded answer_items (is_correct not null).
   */
  async getQuestionStats(
    assignmentId: string,
    teacherId: string,
  ): Promise<{ assignmentId: string; type: string; questions: QuestionStat[] }> {
    const asg = await this.db.get(`
        SELECT a.id, a.type, c.teacher_id
        FROM assignments a
        JOIN classes c ON c.id = a.class_id
        WHERE a.id = ?
        `, assignmentId) as
      | { id: string; type: string; teacher_id: string }
      | undefined;
    if (!asg) throw new AppError("NOT_FOUND", "作业不存在", 404);
    if (asg.teacher_id !== teacherId) {
      throw new AppError("FORBIDDEN", "无权查看", 403);
    }

    const rows = await this.db.all(`
        SELECT id, sort_order, question_snapshot
        FROM assignment_questions
        WHERE assignment_id = ?
        ORDER BY sort_order ASC
        `, assignmentId) as Array<{
      id: string;
      sort_order: number;
      question_snapshot: string;
    }>;

    // Single grouped query instead of per-question COUNT/SUM
    const aggRows = (await this.db.all(
      `
        SELECT
          ai.assignment_question_id AS qid,
          COUNT(*) AS answered,
          SUM(CASE WHEN ai.is_correct = 1 THEN 1 ELSE 0 END) AS correct
        FROM answer_items ai
        JOIN submissions s ON s.id = ai.submission_id
        WHERE s.assignment_id = ?
          AND ai.is_correct IS NOT NULL
        GROUP BY ai.assignment_question_id
        `,
      assignmentId,
    )) as Array<{ qid: string; answered: number; correct: number }>;
    const aggByQ = new Map(
      aggRows.map((r) => [
        r.qid,
        {
          answered: Number(r.answered) || 0,
          correct: Number(r.correct) || 0,
        },
      ]),
    );

    const questions: QuestionStat[] = rows.map((r) => {
      const snap = JSON.parse(r.question_snapshot) as {
        stem?: string;
        type?: string;
        knowledgeNodeId?: string | null;
      };
      const agg = aggByQ.get(r.id) || { answered: 0, correct: 0 };
      const answeredCount = agg.answered;
      const correctCount = agg.correct;
      const correctRate =
        answeredCount === 0
          ? null
          : Math.round((correctCount / answeredCount) * 1000) / 10;

      return {
        assignmentQuestionId: r.id,
        sortOrder: r.sort_order,
        stem: snap.stem || "",
        type: snap.type || "fill_blank",
        knowledgeNodeId: snap.knowledgeNodeId ?? null,
        answeredCount,
        correctCount,
        correctRate,
      };
    });

    return { assignmentId, type: asg.type, questions };
  }

  async getStudentStats(
    classId: string,
    studentId: string,
    teacherId: string,
    days = 14,
  ): Promise<StudentClassStats> {
    const cls = await this.db.get(`SELECT id, name, teacher_id FROM classes WHERE id = ?`, classId) as
      | { id: string; name: string; teacher_id: string }
      | undefined;
    if (!cls) throw new AppError("NOT_FOUND", "班级不存在", 404);
    if (cls.teacher_id !== teacherId) {
      throw new AppError("FORBIDDEN", "无权查看", 403);
    }

    const member = await this.db.get(`SELECT 1 FROM class_memberships
         WHERE class_id = ? AND user_id = ? AND role = 'student'`, classId, studentId);
    if (!member) {
      throw new AppError("NOT_FOUND", "学生不在该班", 404);
    }

    const user = await this.db.get(`SELECT nickname FROM users WHERE id = ?`, studentId) as { nickname: string | null } | undefined;

    const windowDays = Math.min(Math.max(days, 1), 90);
    const since = new Date();
    since.setDate(since.getDate() - windowDays);
    const sinceIso = since.toISOString();

    const assignments = await this.db.all(`
        SELECT id, title, type, created_at, published_at
        FROM assignments
        WHERE class_id = ?
          AND status IN ('published', 'revoked')
          AND COALESCE(published_at, created_at) >= ?
        ORDER BY COALESCE(published_at, created_at) DESC
        LIMIT 100
        `, classId, sinceIso) as Array<{
      id: string;
      title: string;
      type: string;
    }>;

    const asgIds = assignments.map((a) => a.id);
    const subByAsg = new Map<
      string,
      {
        status: string;
        score: number | null;
        updated_at: string;
        submitted_at: string | null;
      }
    >();
    if (asgIds.length) {
      const ph = asgIds.map(() => "?").join(",");
      const subs = (await this.db.all(
        `SELECT assignment_id, status, score, updated_at, submitted_at
           FROM submissions
           WHERE student_id = ? AND assignment_id IN (${ph})`,
        studentId,
        ...asgIds,
      )) as Array<{
        assignment_id: string;
        status: string;
        score: number | null;
        updated_at: string;
        submitted_at: string | null;
      }>;
      for (const s of subs) {
        subByAsg.set(s.assignment_id, {
          status: s.status,
          score: s.score,
          updated_at: s.updated_at,
          submitted_at: s.submitted_at,
        });
      }
    }

    let completedCount = 0;
    const recent: StudentClassStats["recent"] = [];

    for (const a of assignments) {
      const sub = subByAsg.get(a.id);
      const status = sub?.status || "not_started";
      if (status === "completed") completedCount += 1;
      recent.push({
        assignmentId: a.id,
        title: a.title,
        type: a.type,
        status,
        score: sub?.score ?? null,
        completedAt:
          status === "completed"
            ? sub?.updated_at || sub?.submitted_at || null
            : null,
      });
    }

    const assignmentTotal = assignments.length;
    const completionRate =
      assignmentTotal === 0
        ? null
        : Math.round((completedCount / assignmentTotal) * 1000) / 10;

    const ansAgg = await this.db.get(`
        SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN ai.is_correct = 1 THEN 1 ELSE 0 END) AS correct
        FROM answer_items ai
        JOIN submissions s ON s.id = ai.submission_id
        JOIN assignments a ON a.id = s.assignment_id
        WHERE s.student_id = ?
          AND a.class_id = ?
          AND ai.is_correct IS NOT NULL
          AND ai.updated_at >= ?
        `, studentId, classId, sinceIso) as {
      total: number;
      correct: number;
    };

    const answerTotal = ansAgg.total || 0;
    const answerCorrect = ansAgg.correct || 0;
    const correctRate =
      answerTotal === 0
        ? null
        : Math.round((answerCorrect / answerTotal) * 1000) / 10;

    return {
      classId: cls.id,
      className: cls.name,
      studentId,
      nickname: user?.nickname ?? null,
      days: windowDays,
      assignmentTotal,
      completedCount,
      completionRate,
      answerTotal,
      answerCorrect,
      correctRate,
      recent,
    };
  }

  /**
   * Calendar of days with at least one completed submission (Asia/Shanghai date).
   * Date math is done in JS so both SQLite and MySQL work (updated_at is ISO text).
   * Also returns streakDays (cross-month) and monthLitDays for student home (S1).
   */
  async getStudentCalendar(
    studentId: string,
    year: number,
    month: number,
  ): Promise<{
    year: number;
    month: number;
    days: CalendarDay[];
    streakDays: number;
    monthLitDays: number;
  }> {
    if (month < 1 || month > 12 || year < 2000 || year > 2100) {
      throw new AppError("INVALID_DATE", "年月无效");
    }

    // Month grid: ISO bounds for the requested month
    const { startIso, endIso } = shanghaiMonthIsoBounds(year, month);

    const monthRows = (await this.db.all(
      `
        SELECT s.updated_at, s.overdue
        FROM submissions s
        WHERE s.student_id = ?
          AND s.status = 'completed'
          AND s.updated_at >= ?
          AND s.updated_at < ?
        `,
      studentId,
      startIso,
      endIso,
    )) as Array<{ updated_at: string; overdue: number }>;

    const counts = new Map<string, number>();
    const overdueCounts = new Map<string, number>();
    for (const r of monthRows) {
      if (!r.updated_at) continue;
      const d = toShanghaiYmd(r.updated_at);
      // only days in the requested calendar month
      if (!d.startsWith(`${year}-${String(month).padStart(2, "0")}`)) continue;
      counts.set(d, (counts.get(d) || 0) + 1);
      if (Number(r.overdue) === 1) {
        overdueCounts.set(d, (overdueCounts.get(d) || 0) + 1);
      }
    }

    // Review-due markers: align with promoteDue / countOpenDue (miss_count > 0)
    const today = shanghaiYmd();
    const reviewDays = new Set<string>();
    const masteryDue = (await this.db.all(
      `SELECT status, review_at, miss_count FROM mastery_items
       WHERE user_id = ?
         AND (
           status = 'due'
           OR (status = 'open' AND miss_count > 0)
         )`,
      studentId,
    )) as Array<{ status: string; review_at: string; miss_count: number }>;
    for (const m of masteryDue) {
      if (m.status === "due") {
        reviewDays.add(today);
        if (m.review_at) {
          const ymd = toShanghaiYmd(m.review_at);
          if (ymd.startsWith(`${year}-${String(month).padStart(2, "0")}`)) {
            reviewDays.add(ymd);
          }
        }
      } else if (m.review_at && m.review_at <= new Date().toISOString()) {
        // open + real miss, past review_at (not yet promoted in this path)
        reviewDays.add(today);
      }
    }

    const allDates = new Set<string>([
      ...counts.keys(),
      ...reviewDays,
    ]);
    const days: CalendarDay[] = [...allDates]
      .sort((a, b) => a.localeCompare(b))
      .map((date) => {
        const completedCount = counts.get(date) || 0;
        const overdueCount = overdueCounts.get(date) || 0;
        const hasReviewDue = reviewDays.has(date);
        let state = computeCalendarDayState({
          completedCount,
          overdueCount,
          hasReviewDue,
        });
        // Overlay: completion done + review still due → keep done but flag orange
        if (completedCount > 0 && hasReviewDue && state === "done") {
          // keep done; client shows orange corner via hasReviewDue
        }
        return {
          date,
          completedCount,
          overdueCount,
          hasReviewDue,
          state,
        };
      });

    // Streak needs a longer window (look back ~400 days)
    const streakLookbackIso = new Date(
      Date.now() - 400 * 86_400_000,
    ).toISOString();
    const streakRows = (await this.db.all(
      `
        SELECT s.updated_at
        FROM submissions s
        WHERE s.student_id = ?
          AND s.status = 'completed'
          AND s.updated_at >= ?
        `,
      studentId,
      streakLookbackIso,
    )) as Array<{ updated_at: string }>;

    const allYmds = new Set<string>();
    for (const r of streakRows) {
      if (!r.updated_at) continue;
      allYmds.add(toShanghaiYmd(r.updated_at));
    }

    const streakDays = computeStreakDays(allYmds, today);
    const monthLitDays = countMonthLitDays(allYmds, year, month);

    return { year, month, days, streakDays, monthLitDays };
  }

  /**
   * Knowledge points the student has completed via check-in (or any online item tagged).
   * JSON fields are parsed in JS for SQLite/MySQL portability.
   */
  async getStudentKnowledgeDone(studentId: string): Promise<KnowledgeDoneItem[]> {
    const onlineRows = (await this.db.all(
      `
        SELECT a.id AS assignment_id, aq.question_snapshot, s.updated_at
        FROM submissions s
        JOIN assignments a ON a.id = s.assignment_id
        JOIN assignment_questions aq ON aq.assignment_id = a.id
        WHERE s.student_id = ?
          AND s.status = 'completed'
        `,
      studentId,
    )) as Array<{
      assignment_id: string;
      question_snapshot: string;
      updated_at: string;
    }>;

    const checkinRows = (await this.db.all(
      `
        SELECT a.config_json, s.updated_at
        FROM submissions s
        JOIN assignments a ON a.id = s.assignment_id
        WHERE s.student_id = ?
          AND s.status = 'completed'
          AND a.type = 'knowledge_checkin'
        `,
      studentId,
    )) as Array<{ config_json: string; updated_at: string }>;

    const map = new Map<
      string,
      { count: number; last: string | null; asg: Set<string> }
    >();

    const touch = (id: string, at: string, assignmentId?: string) => {
      if (!id) return;
      const prev = map.get(id) || {
        count: 0,
        last: null as string | null,
        asg: new Set<string>(),
      };
      if (assignmentId) prev.asg.add(assignmentId);
      else prev.count += 1;
      map.set(id, {
        count: assignmentId ? prev.asg.size : prev.count,
        last: !prev.last || at > prev.last ? at : prev.last,
        asg: prev.asg,
      });
    };

    for (const r of onlineRows) {
      try {
        const snap = JSON.parse(r.question_snapshot || "{}") as {
          knowledgeNodeId?: string | null;
        };
        const kid = (snap.knowledgeNodeId || "").trim();
        if (kid) touch(kid, r.updated_at, r.assignment_id);
      } catch {
        /* ignore bad snapshot */
      }
    }

    for (const r of checkinRows) {
      try {
        const cfg = JSON.parse(r.config_json || "{}") as {
          knowledgeNodeIds?: string[];
        };
        for (const id of cfg.knowledgeNodeIds || []) {
          touch(id, r.updated_at);
        }
      } catch {
        /* ignore */
      }
    }

    const items: KnowledgeDoneItem[] = [];
    for (const [id, v] of map) {
      const node = this.knowledge.getById(id);
      items.push({
        knowledgeNodeId: id,
        name: node?.name || id,
        unitName: node?.unitName,
        pathLabel: node?.pathLabel,
        completedCount: v.count,
        lastCompletedAt: v.last,
      });
    }
    items.sort((a, b) =>
      (b.lastCompletedAt || "").localeCompare(a.lastCompletedAt || ""),
    );
    return items;
  }
}

/** YYYY-MM-DD in Asia/Shanghai */
function toShanghaiYmd(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("en-CA", {
      timeZone: "Asia/Shanghai",
    });
  } catch {
    return (iso || "").slice(0, 10);
  }
}

/** ISO bounds that cover the full Shanghai calendar month */
function shanghaiMonthIsoBounds(
  year: number,
  month: number,
): { startIso: string; endIso: string } {
  // Shanghai local midnight of month start / next month start → UTC ISO
  const startLocal = `${year}-${String(month).padStart(2, "0")}-01T00:00:00+08:00`;
  const endMonth = month === 12 ? 1 : month + 1;
  const endYear = month === 12 ? year + 1 : year;
  const endLocal = `${endYear}-${String(endMonth).padStart(2, "0")}-01T00:00:00+08:00`;
  return {
    startIso: new Date(startLocal).toISOString(),
    endIso: new Date(endLocal).toISOString(),
  };
}
