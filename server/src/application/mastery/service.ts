import type { AppDatabase } from "../../infrastructure/persistence/db.js";
import { createId, nowIso } from "../../infrastructure/persistence/db.js";
import {
  buildWeekSummaryCopy,
  computeMapNodeState,
  computeReviewAt,
  isReviewPassed,
  isWrongReason,
  MASTERY_ITEM_EXPIRE_DAYS,
  MASTERY_MAP_WINDOW_DAYS,
  MASTERY_MAX_OPEN_PER_USER,
  MASTERY_REVIEW_QUESTION_COUNT,
  MASTERY_SELF_PRACTICE_COUNT,
  resolveMasteryKey,
  shanghaiWeekBounds,
  type MapNodeState,
  type WrongReason,
} from "../../domain/mastery/rules.js";
import { KnowledgeTreeService } from "../knowledge/service.js";
import type { QuestionSnapshot } from "../../domain/question/types.js";
import { gradeOne } from "../../domain/grading/auto-grade.js";
import { generateDrillQuestions } from "../../domain/drill/generator.js";
import { AppError } from "../../domain/shared/errors.js";

export type MasteryStatus =
  | "open"
  | "due"
  | "passed"
  | "failed"
  | "expired";

export interface PublicMasteryItem {
  id: string;
  knowledgeNodeId: string | null;
  skillKey: string | null;
  name: string;
  unitName: string | null;
  pathLabel: string | null;
  status: MasteryStatus;
  missCount: number;
  passCount: number;
  reviewAt: string;
  lastWrongReason: string | null;
  sourceAssignmentId: string | null;
  updatedAt: string;
}

export interface EnqueueMiss {
  knowledgeNodeId?: string | null;
  sourceQuestionId?: string | null;
  stem?: string | null;
  wrongReason?: string | null;
}

export interface PublicReviewQuestion {
  index: number;
  stem: string;
  type: string;
  options: QuestionSnapshot["options"];
  /** Only after submit */
  isCorrect?: boolean | null;
  correctAnswer?: string | boolean;
  explanation?: string | null;
  response?: string | boolean | null;
}

export interface PublicMasteryReview {
  id: string;
  masteryItemId: string;
  source: "review" | "self_practice";
  status: "in_progress" | "completed" | "abandoned";
  title: string;
  knowledgeName: string;
  questions: PublicReviewQuestion[];
  correctCount: number | null;
  totalCount: number;
  passed: boolean | null;
  startedAt: string;
  completedAt: string | null;
}

export interface PublicMapNode {
  knowledgeNodeId: string;
  name: string;
  unitId: string | null;
  unitName: string | null;
  pathLabel: string | null;
  state: MapNodeState;
  masteryItemId: string | null;
  masteryStatus: string | null;
  reviewAt: string | null;
  recentCorrectRate: number | null;
  recentAnswered: number;
  hasCompletion: boolean;
  lastCompletedAt: string | null;
}

export interface PublicUnitStamp {
  unitId: string;
  unitName: string;
  earned: boolean;
  total: number;
  litCount: number;
}

export interface PublicMasteryMap {
  grade: number;
  units: Array<{
    unitId: string;
    unitName: string;
    nodes: PublicMapNode[];
    /** S5: all knowledge in unit lit */
    stampEarned: boolean;
  }>;
  stamps: PublicUnitStamp[];
  summary: { dark: number; half: number; lit: number };
}

export interface PublicWeekSummary {
  weekLabel: string;
  startYmd: string;
  endYmd: string;
  completedTaskCount: number;
  litDays: number;
  reviewPassedCount: number;
  selfPracticeCount: number;
  knowledgeNames: string[];
  bullets: string[];
  copyText: string;
}

/**
 * Student mastery queue + review sessions (S2–S3).
 * Reviews are NOT assignments — never touch assignments table.
 */
export class MasteryService {
  private knowledge = new KnowledgeTreeService();

  constructor(private db: AppDatabase) {}

  /**
   * After online correction completes: upsert open items for each miss.
   */
  async enqueueAfterCorrection(input: {
    userId: string;
    classId: string | null;
    assignmentId: string;
    assignmentType: string;
    misses: EnqueueMiss[];
  }): Promise<{ enqueued: number; skipped: string }> {
    const { userId, classId, assignmentId, assignmentType, misses } = input;
    if (!misses.length) {
      console.info("[mastery.enqueue.skip]", {
        userId,
        reason: "no_misses",
        assignmentId,
      });
      return { enqueued: 0, skipped: "no_misses" };
    }

    const byKey = new Map<
      string,
      {
        knowledgeNodeId: string | null;
        skillKey: string | null;
        wrongReason: WrongReason | null;
      }
    >();
    for (const m of misses) {
      const key = resolveMasteryKey({
        knowledgeNodeId: m.knowledgeNodeId,
        sourceQuestionId: m.sourceQuestionId,
        stem: m.stem,
        assignmentType,
      });
      const mapKey = key.knowledgeNodeId
        ? `kn:${key.knowledgeNodeId}`
        : `sk:${key.skillKey}`;
      const reason =
        m.wrongReason && isWrongReason(m.wrongReason) ? m.wrongReason : null;
      byKey.set(mapKey, {
        knowledgeNodeId: key.knowledgeNodeId,
        skillKey: key.skillKey,
        wrongReason: reason,
      });
    }

    const openCount = await this.countOpenDue(userId);
    let enqueued = 0;
    const ts = nowIso();
    const reviewAt = computeReviewAt(new Date());

    for (const item of byKey.values()) {
      const existing = await this.findExisting(
        userId,
        item.knowledgeNodeId,
        item.skillKey,
      );

      if (existing) {
        await this.mergeEnqueueHit({
          id: existing.id,
          userId,
          knowledgeNodeId: item.knowledgeNodeId,
          skillKey: item.skillKey,
          wrongReason: item.wrongReason,
          assignmentId,
          classId,
          reviewAt,
          ts,
        });
        enqueued += 1;
        continue;
      }

      if (openCount + enqueued >= MASTERY_MAX_OPEN_PER_USER) {
        console.info("[mastery.enqueue.skip]", {
          userId,
          reason: "cap",
          cap: MASTERY_MAX_OPEN_PER_USER,
        });
        break;
      }

      const id = createId("mst");
      try {
        await this.db.run(
          `INSERT INTO mastery_items (
             id, user_id, class_id, knowledge_node_id, skill_key,
             status, miss_count, pass_count, review_at, last_result_at,
             last_wrong_reason, source_assignment_id, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, 'open', 1, 0, ?, ?, ?, ?, ?, ?)`,
          id,
          userId,
          classId,
          item.knowledgeNodeId,
          item.skillKey,
          reviewAt,
          ts,
          item.wrongReason,
          assignmentId,
          ts,
          ts,
        );
        enqueued += 1;
        console.info("[mastery.enqueue]", {
          userId,
          id,
          knowledgeNodeId: item.knowledgeNodeId,
          skillKey: item.skillKey,
          reviewAt,
          merged: false,
        });
      } catch (err) {
        // Concurrent INSERT for same (user, kn|skill) — unique index race.
        if (!isUniqueConstraintError(err)) throw err;
        console.info("[mastery.enqueue.race]", {
          userId,
          knowledgeNodeId: item.knowledgeNodeId,
          skillKey: item.skillKey,
          message: (err as { message?: string })?.message,
        });
        const raced = await this.findExisting(
          userId,
          item.knowledgeNodeId,
          item.skillKey,
        );
        if (!raced) throw err;
        await this.mergeEnqueueHit({
          id: raced.id,
          userId,
          knowledgeNodeId: item.knowledgeNodeId,
          skillKey: item.skillKey,
          wrongReason: item.wrongReason,
          assignmentId,
          classId,
          reviewAt,
          ts,
        });
        enqueued += 1;
      }
    }

    return { enqueued, skipped: enqueued ? "" : "cap_or_empty" };
  }

  /** Promote open→due when review_at <= now. */
  async promoteDue(userId: string): Promise<number> {
    const now = nowIso();
    // Only real misses (miss_count > 0) — never promote self-practice scaffolds
    const result = await this.db.run(
      `UPDATE mastery_items
         SET status = 'due', updated_at = ?
         WHERE user_id = ?
           AND status = 'open'
           AND miss_count > 0
           AND review_at <= ?`,
      now,
      userId,
      now,
    );
    const n = result.changes ?? 0;
    if (n > 0) {
      console.info("[mastery.due.promote]", { userId, count: n });
    }

    // Expire long-stale queue items (plan: 30d without follow-through)
    const expireBefore = new Date(
      Date.now() - MASTERY_ITEM_EXPIRE_DAYS * 86_400_000,
    ).toISOString();
    const exp = await this.db.run(
      `UPDATE mastery_items
         SET status = 'expired', updated_at = ?
         WHERE user_id = ?
           AND status IN ('open', 'due')
           AND miss_count > 0
           AND updated_at < ?`,
      now,
      userId,
      expireBefore,
    );
    if ((exp.changes ?? 0) > 0) {
      console.info("[mastery.expire]", {
        userId,
        count: exp.changes,
      });
    }
    return n;
  }

  async listForUser(
    userId: string,
    statusFilter?: MasteryStatus[],
  ): Promise<PublicMasteryItem[]> {
    await this.promoteDue(userId);

    let rows: Array<Record<string, unknown>>;
    if (statusFilter?.length) {
      const placeholders = statusFilter.map(() => "?").join(",");
      rows = (await this.db.all(
        `SELECT * FROM mastery_items
         WHERE user_id = ? AND status IN (${placeholders})
         ORDER BY review_at ASC, updated_at DESC`,
        userId,
        ...statusFilter,
      )) as Array<Record<string, unknown>>;
    } else {
      rows = (await this.db.all(
        `SELECT * FROM mastery_items
         WHERE user_id = ?
         ORDER BY
           CASE status
             WHEN 'due' THEN 0
             WHEN 'open' THEN 1
             WHEN 'failed' THEN 2
             ELSE 3
           END,
           review_at ASC`,
        userId,
      )) as Array<Record<string, unknown>>;
    }

    return rows.map((r) => this.toPublic(r));
  }

  /** First due item for home review slot (or null). */
  async getPrimaryDue(
    userId: string,
  ): Promise<PublicMasteryItem | null> {
    await this.promoteDue(userId);
    const row = (await this.db.get(
      `SELECT * FROM mastery_items
       WHERE user_id = ? AND status = 'due'
       ORDER BY review_at ASC
       LIMIT 1`,
      userId,
    )) as Record<string, unknown> | undefined;
    return row ? this.toPublic(row) : null;
  }

  async startReview(
    userId: string,
    masteryItemId: string,
    source: "review" | "self_practice" = "review",
  ): Promise<PublicMasteryReview> {
    await this.promoteDue(userId);
    const item = await this.getItemRow(masteryItemId, userId);

    // Resume first — due gate must not block an already open session
    // (e.g. after merge demotes item open while review is still in_progress).
    const existing = (await this.db.get(
      `SELECT * FROM mastery_reviews
       WHERE mastery_item_id = ? AND user_id = ? AND status = 'in_progress'
         AND source = ?
       ORDER BY started_at DESC LIMIT 1`,
      masteryItemId,
      userId,
      source,
    )) as Record<string, unknown> | undefined;
    if (existing) {
      return this.toPublicReview(existing, item);
    }

    if (source === "review" && item.status !== "due") {
      throw new AppError(
        "NOT_DUE",
        item.status === "open"
          ? "还没到回访时间，过几天再来"
          : "该巩固项不可回访（已过关或未开放）",
        400,
      );
    }

    const need =
      source === "self_practice"
        ? MASTERY_SELF_PRACTICE_COUNT
        : MASTERY_REVIEW_QUESTION_COUNT;
    const snapshots = await this.buildReviewSnapshots(item, need);
    if (!snapshots.length) {
      throw new AppError(
        "NO_QUESTIONS",
        "该点暂无练习题，请稍后再试或等老师布置",
        400,
      );
    }

    const id = createId("mrv");
    const ts = nowIso();
    await this.db.run(
      `INSERT INTO mastery_reviews (
         id, mastery_item_id, user_id, source, status,
         question_snapshots_json, answers_json, correct_count, total_count,
         passed, started_at, completed_at
       ) VALUES (?, ?, ?, ?, 'in_progress', ?, NULL, NULL, ?, NULL, ?, NULL)`,
      id,
      masteryItemId,
      userId,
      source,
      JSON.stringify(snapshots),
      snapshots.length,
      ts,
    );
    console.info("[mastery.review.start]", {
      userId,
      reviewId: id,
      itemId: masteryItemId,
      questionCount: snapshots.length,
      source,
    });

    const row = (await this.db.get(
      `SELECT * FROM mastery_reviews WHERE id = ?`,
      id,
    )) as Record<string, unknown>;
    return this.toPublicReview(row, item);
  }

  /**
   * S4: self practice from knowledge map (half node). Ensures a mastery row exists.
   */
  async startSelfPractice(
    userId: string,
    knowledgeNodeId: string,
  ): Promise<PublicMasteryReview> {
    const kn = this.knowledge.getById(knowledgeNodeId);
    if (!kn || kn.type !== "knowledge") {
      throw new AppError("INVALID_KNOWLEDGE", "知识点无效", 400);
    }
    const itemId = await this.ensureItemForKnowledge(userId, knowledgeNodeId);
    return this.startReview(userId, itemId, "self_practice");
  }

  /**
   * S4 knowledge map by grade, grouped by unit.
   */
  async getMasteryMap(
    userId: string,
    grade?: number,
  ): Promise<PublicMasteryMap> {
    await this.promoteDue(userId);

    let g = grade;
    if (g == null || !Number.isFinite(g)) {
      const row = (await this.db.get(
        `SELECT c.grade FROM class_memberships m
         JOIN classes c ON c.id = m.class_id
         WHERE m.user_id = ? AND c.archived = 0
         ORDER BY m.joined_at DESC LIMIT 1`,
        userId,
      )) as { grade: number } | undefined;
      g = row?.grade ?? 3;
    }
    g = Math.min(6, Math.max(3, Math.floor(Number(g))));

    const knowledgeNodes = this.knowledge.list({
      grade: g,
      type: "knowledge",
    });
    const units = this.knowledge.list({ grade: g, type: "unit" });

    // mastery by knowledge_node_id
    const masteryRows = (await this.db.all(
      `SELECT * FROM mastery_items
       WHERE user_id = ? AND knowledge_node_id IS NOT NULL`,
      userId,
    )) as Array<Record<string, unknown>>;
    const masteryByKn = new Map<string, Record<string, unknown>>();
    for (const r of masteryRows) {
      const kid = String(r.knowledge_node_id || "");
      if (kid) masteryByKn.set(kid, r);
    }

    // completions + accuracy window
    const sinceIso = new Date(
      Date.now() - MASTERY_MAP_WINDOW_DAYS * 86_400_000,
    ).toISOString();

    const doneRows = (await this.db.all(
      `SELECT aq.question_snapshot, s.updated_at, s.status
       FROM submissions s
       JOIN assignment_questions aq ON aq.assignment_id = s.assignment_id
       WHERE s.student_id = ? AND s.status = 'completed'`,
      userId,
    )) as Array<{ question_snapshot: string; updated_at: string }>;

    const completionByKn = new Map<
      string,
      { count: number; last: string | null }
    >();
    for (const r of doneRows) {
      try {
        const snap = JSON.parse(r.question_snapshot) as QuestionSnapshot;
        const kid = (snap.knowledgeNodeId || "").trim();
        if (!kid) continue;
        const prev = completionByKn.get(kid) || { count: 0, last: null };
        prev.count += 1;
        if (!prev.last || r.updated_at > prev.last) prev.last = r.updated_at;
        completionByKn.set(kid, prev);
      } catch {
        /* skip */
      }
    }

    // also knowledge_checkin config ids
    const checkinRows = (await this.db.all(
      `SELECT a.config_json, s.updated_at
       FROM submissions s
       JOIN assignments a ON a.id = s.assignment_id
       WHERE s.student_id = ?
         AND s.status = 'completed'
         AND a.type = 'knowledge_checkin'`,
      userId,
    )) as Array<{ config_json: string; updated_at: string }>;
    for (const r of checkinRows) {
      try {
        const cfg = JSON.parse(r.config_json || "{}") as {
          knowledgeNodeIds?: string[];
        };
        for (const id of cfg.knowledgeNodeIds || []) {
          const prev = completionByKn.get(id) || { count: 0, last: null };
          prev.count += 1;
          if (!prev.last || r.updated_at > prev.last) prev.last = r.updated_at;
          completionByKn.set(id, prev);
        }
      } catch {
        /* skip */
      }
    }

    const accRows = (await this.db.all(
      `SELECT aq.question_snapshot, ai.is_correct
       FROM answer_items ai
       JOIN submissions s ON s.id = ai.submission_id
       JOIN assignment_questions aq ON aq.id = ai.assignment_question_id
       WHERE s.student_id = ?
         AND ai.is_correct IS NOT NULL
         AND ai.updated_at >= ?`,
      userId,
      sinceIso,
    )) as Array<{ question_snapshot: string; is_correct: number }>;

    const accByKn = new Map<string, { correct: number; total: number }>();
    for (const r of accRows) {
      try {
        const snap = JSON.parse(r.question_snapshot) as QuestionSnapshot;
        const kid = (snap.knowledgeNodeId || "").trim();
        if (!kid) continue;
        const prev = accByKn.get(kid) || { correct: 0, total: 0 };
        prev.total += 1;
        if (r.is_correct === 1) prev.correct += 1;
        accByKn.set(kid, prev);
      } catch {
        /* skip */
      }
    }

    const summary = { dark: 0, half: 0, lit: 0 };
    const nodesByUnit = new Map<string, PublicMapNode[]>();

    for (const kn of knowledgeNodes) {
      const m = masteryByKn.get(kn.id);
      const masteryStatus = m ? String(m.status) : null;
      const missCount = m != null ? Number(m.miss_count) || 0 : 0;
      const completion = completionByKn.get(kn.id);
      const hasCompletion = !!(completion && completion.count > 0);
      const acc = accByKn.get(kn.id);
      const recentAnswered = acc?.total || 0;
      const recentCorrectRate =
        recentAnswered > 0 && acc
          ? Math.round((acc.correct / acc.total) * 1000) / 10
          : null;
      const state = computeMapNodeState({
        hasCompletion,
        masteryStatus,
        missCount,
        recentCorrectRate,
        recentAnswered,
      });
      summary[state] += 1;

      const unitId = kn.parentId || "unknown";
      const node: PublicMapNode = {
        knowledgeNodeId: kn.id,
        name: kn.name,
        unitId: kn.parentId,
        unitName: kn.unitName ?? null,
        pathLabel: kn.pathLabel ?? null,
        state,
        masteryItemId: m ? String(m.id) : null,
        masteryStatus,
        reviewAt: m ? String(m.review_at) : null,
        recentCorrectRate,
        recentAnswered,
        hasCompletion,
        lastCompletedAt: completion?.last ?? null,
      };
      const list = nodesByUnit.get(unitId) || [];
      list.push(node);
      nodesByUnit.set(unitId, list);
    }

    const unitBlocks = units.map((u) => {
      const nodes = nodesByUnit.get(u.id) || [];
      const litCount = nodes.filter((n) => n.state === "lit").length;
      const stampEarned = nodes.length > 0 && litCount === nodes.length;
      return {
        unitId: u.id,
        unitName: u.name,
        nodes,
        stampEarned,
      };
    });

    const stamps: PublicUnitStamp[] = unitBlocks
      .filter((u) => u.nodes.length > 0)
      .map((u) => ({
        unitId: u.unitId,
        unitName: u.unitName,
        earned: u.stampEarned,
        total: u.nodes.length,
        litCount: u.nodes.filter((n) => n.state === "lit").length,
      }));

    return { grade: g, units: unitBlocks, stamps, summary };
  }

  /**
   * S5: weekly recap for student (copy-friendly, no ranking).
   */
  async getWeekSummary(userId: string): Promise<PublicWeekSummary> {
    const week = shanghaiWeekBounds(new Date());
    const { startIso, endIsoExclusive, startYmd, endYmd, label } = week;

    const completedRows = (await this.db.all(
      `SELECT updated_at FROM submissions
       WHERE student_id = ?
         AND status = 'completed'
         AND updated_at >= ?
         AND updated_at < ?`,
      userId,
      startIso,
      endIsoExclusive,
    )) as Array<{ updated_at: string }>;

    const litDaySet = new Set<string>();
    for (const r of completedRows) {
      if (!r.updated_at) continue;
      try {
        litDaySet.add(
          new Date(r.updated_at).toLocaleDateString("en-CA", {
            timeZone: "Asia/Shanghai",
          }),
        );
      } catch {
        /* skip */
      }
    }

    const reviewRows = (await this.db.all(
      `SELECT r.passed, r.source, r.completed_at, m.knowledge_node_id, m.skill_key
       FROM mastery_reviews r
       JOIN mastery_items m ON m.id = r.mastery_item_id
       WHERE r.user_id = ?
         AND r.status = 'completed'
         AND r.completed_at >= ?
         AND r.completed_at < ?`,
      userId,
      startIso,
      endIsoExclusive,
    )) as Array<{
      passed: number | null;
      source: string;
      completed_at: string;
      knowledge_node_id: string | null;
      skill_key: string | null;
    }>;

    let reviewPassedCount = 0;
    let selfPracticeCount = 0;
    const nameSet = new Set<string>();
    for (const r of reviewRows) {
      if (Number(r.passed) === 1) {
        if (r.source === "self_practice") selfPracticeCount += 1;
        else reviewPassedCount += 1;
        if (r.knowledge_node_id) {
          const kn = this.knowledge.getById(r.knowledge_node_id);
          if (kn) nameSet.add(kn.name);
        }
      }
    }

    // also knowledge from completed submissions this week (path labels)
    const snapRows = (await this.db.all(
      `SELECT aq.question_snapshot
       FROM submissions s
       JOIN assignment_questions aq ON aq.assignment_id = s.assignment_id
       WHERE s.student_id = ?
         AND s.status = 'completed'
         AND s.updated_at >= ?
         AND s.updated_at < ?`,
      userId,
      startIso,
      endIsoExclusive,
    )) as Array<{ question_snapshot: string }>;
    for (const r of snapRows) {
      try {
        const snap = JSON.parse(r.question_snapshot) as QuestionSnapshot;
        const kid = (snap.knowledgeNodeId || "").trim();
        if (!kid) continue;
        const kn = this.knowledge.getById(kid);
        if (kn) nameSet.add(kn.name);
      } catch {
        /* skip */
      }
    }

    const knowledgeNames = [...nameSet];
    const completedTaskCount = completedRows.length;
    const litDays = litDaySet.size;
    const copyText = buildWeekSummaryCopy({
      weekLabel: label,
      completedTaskCount,
      litDays,
      knowledgeNames,
    });
    const bullets = [
      `完成任务 ${completedTaskCount} 次`,
      `学习点亮 ${litDays} 天`,
      knowledgeNames.length
        ? `点亮/巩固：${knowledgeNames.slice(0, 5).join("、")}`
        : "本周暂无新巩固点，下周继续",
    ];

    console.info("[mastery.week.summary]", {
      userId,
      week: label,
      completedTaskCount,
      litDays,
      reviewPassedCount,
    });

    return {
      weekLabel: label,
      startYmd,
      endYmd,
      completedTaskCount,
      litDays,
      reviewPassedCount,
      selfPracticeCount,
      knowledgeNames,
      bullets,
      copyText,
    };
  }

  private async ensureItemForKnowledge(
    userId: string,
    knowledgeNodeId: string,
  ): Promise<string> {
    const existing = await this.findExisting(userId, knowledgeNodeId, null);
    if (existing) return existing.id;
    const id = createId("mst");
    const ts = nowIso();
    // Scaffold only: open + far-future review_at so promoteDue never makes a
    // false home「回访」for map self-practice. Real misses set review_at = +3d.
    const reviewAt = computeReviewAt(new Date(), 3650);
    try {
      await this.db.run(
        `INSERT INTO mastery_items (
           id, user_id, class_id, knowledge_node_id, skill_key,
           status, miss_count, pass_count, review_at, last_result_at,
           last_wrong_reason, source_assignment_id, created_at, updated_at
         ) VALUES (?, ?, NULL, ?, NULL, 'open', 0, 0, ?, NULL, NULL, NULL, ?, ?)`,
        id,
        userId,
        knowledgeNodeId,
        reviewAt,
        ts,
        ts,
      );
      console.info("[mastery.enqueue]", {
        userId,
        id,
        knowledgeNodeId,
        skillKey: null,
        reviewAt,
        merged: false,
        source: "self_practice_ensure",
      });
      return id;
    } catch (err) {
      if (!isUniqueConstraintError(err)) throw err;
      console.info("[mastery.enqueue.race]", {
        userId,
        knowledgeNodeId,
        skillKey: null,
        source: "self_practice_ensure",
        message: (err as { message?: string })?.message,
      });
      const raced = await this.findExisting(userId, knowledgeNodeId, null);
      if (!raced) throw err;
      return raced.id;
    }
  }

  async getReview(
    userId: string,
    reviewId: string,
  ): Promise<PublicMasteryReview> {
    const row = await this.getReviewRow(reviewId, userId);
    const item = await this.getItemRow(String(row.mastery_item_id), userId);
    return this.toPublicReview(row, item);
  }

  async submitReview(
    userId: string,
    reviewId: string,
    answers: Array<{ questionIndex: number; response: unknown }>,
  ): Promise<PublicMasteryReview> {
    const row = await this.getReviewRow(reviewId, userId);
    if (row.status !== "in_progress") {
      throw new AppError("INVALID_STATUS", "该回访已提交", 400);
    }

    const snapshots = JSON.parse(
      String(row.question_snapshots_json),
    ) as QuestionSnapshot[];
    const total = snapshots.length;
    const responseByIndex = new Map<number, unknown>();
    for (const a of answers) {
      responseByIndex.set(a.questionIndex, a.response);
    }

    let correctCount = 0;
    const graded: Array<{
      questionIndex: number;
      response: unknown;
      isCorrect: boolean;
    }> = [];

    for (let i = 0; i < total; i++) {
      const snap = snapshots[i];
      const resp = responseByIndex.has(i) ? responseByIndex.get(i) : null;
      const { correct } = gradeOne(snap, resp);
      if (correct) correctCount += 1;
      graded.push({ questionIndex: i, response: resp ?? null, isCorrect: correct });
    }

    const passed = isReviewPassed(correctCount, total);
    const ts = nowIso();
    const itemId = String(row.mastery_item_id);

    await this.db.transaction(async () => {
      // CAS: only one concurrent submit wins
      const cas = await this.db.run(
        `UPDATE mastery_reviews
           SET status = 'completed',
               answers_json = ?,
               correct_count = ?,
               passed = ?,
               completed_at = ?
           WHERE id = ? AND status = 'in_progress'`,
        JSON.stringify(graded),
        correctCount,
        passed ? 1 : 0,
        ts,
        reviewId,
      );
      if ((cas.changes ?? 0) === 0) {
        throw new AppError("INVALID_STATUS", "该回访已提交", 400);
      }

      const source = String(row.source || "review");
      const itemRow = await this.getItemRow(itemId, userId);

      if (passed) {
        await this.db.run(
          `UPDATE mastery_items
             SET status = 'passed',
                 pass_count = pass_count + 1,
                 last_result_at = ?,
                 updated_at = ?
             WHERE id = ? AND user_id = ?`,
          ts,
          ts,
          itemId,
          userId,
        );
      } else if (source === "self_practice") {
        // Optional consolidate: only schedule formal +3d if already a real miss/due
        const wasRealMiss =
          Number(itemRow.miss_count) > 0 ||
          itemRow.status === "due" ||
          itemRow.status === "failed" ||
          !!itemRow.source_assignment_id;
        if (wasRealMiss) {
          const nextReview = computeReviewAt(new Date());
          await this.db.run(
            `UPDATE mastery_items
               SET status = 'open',
                   miss_count = CASE WHEN miss_count < 1 THEN 1 ELSE miss_count + 1 END,
                   review_at = ?,
                   last_result_at = ?,
                   updated_at = ?
               WHERE id = ? AND user_id = ?`,
            nextReview,
            ts,
            ts,
            itemId,
            userId,
          );
        } else {
          // Scaffold: keep miss_count 0 and far-future review_at (do not promote to due)
          const far = computeReviewAt(new Date(), 3650);
          await this.db.run(
            `UPDATE mastery_items
               SET status = 'open',
                   miss_count = 0,
                   review_at = ?,
                   last_result_at = ?,
                   updated_at = ?
               WHERE id = ? AND user_id = ?`,
            far,
            ts,
            ts,
            itemId,
            userId,
          );
        }
      } else {
        const nextReview = computeReviewAt(new Date());
        await this.db.run(
          `UPDATE mastery_items
             SET status = 'open',
                 miss_count = miss_count + 1,
                 review_at = ?,
                 last_result_at = ?,
                 updated_at = ?
             WHERE id = ? AND user_id = ?`,
          nextReview,
          ts,
          ts,
          itemId,
          userId,
        );
      }
    });

    console.info("[mastery.review.submit]", {
      userId,
      reviewId,
      passed,
      correctCount,
      total,
      source: row.source,
    });

    return this.getReview(userId, reviewId);
  }

  // ─── question building ───────────────────────────────────────────────────

  private async buildReviewSnapshots(
    item: {
      id: string;
      user_id: string;
      knowledge_node_id: string | null;
      skill_key: string | null;
    },
    need: number = MASTERY_REVIEW_QUESTION_COUNT,
  ): Promise<QuestionSnapshot[]> {
    const out: QuestionSnapshot[] = [];
    const seen = new Set<string>();

    const push = (snap: QuestionSnapshot | null | undefined) => {
      if (!snap || !snap.stem) return;
      const key = `${snap.stem}|${String(snap.answer)}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({
        type: snap.type,
        stem: snap.stem,
        options: snap.options ?? null,
        answer: snap.answer,
        explanation: snap.explanation ?? null,
        knowledgeNodeId: snap.knowledgeNodeId ?? item.knowledge_node_id,
        source: snap.source || "manual",
        id: snap.id,
      });
    };

    // 1) Historical wrong / tagged snapshots for this student + knowledge
    const hist = await this.loadHistoricalSnapshots(item);
    for (const s of hist) {
      if (out.length >= need) break;
      push(s);
    }

    // 2) Bank questions by knowledge
    if (out.length < need && item.knowledge_node_id) {
      const bank = (await this.db.all(
        `SELECT type, stem, options_json, answer_json, explanation, knowledge_node_id, source, id
         FROM questions
         WHERE knowledge_node_id = ?
         ORDER BY updated_at DESC
         LIMIT 20`,
        item.knowledge_node_id,
      )) as Array<Record<string, unknown>>;
      for (const r of bank) {
        if (out.length >= need) break;
        push(this.rowToSnapshot(r));
      }
    }

    // 3) Drill generator from suggested ops or skill fallback
    if (out.length < need) {
      const ops = this.resolveDrillOps(item);
      for (const opId of ops) {
        if (out.length >= need) break;
        try {
          const remain = need - out.length;
          const gen = generateDrillQuestions({
            operationId: opId,
            count: remain,
            difficulty: "basic",
          });
          for (const q of gen.questions) {
            if (out.length >= need) break;
            push({
              ...q,
              knowledgeNodeId: item.knowledge_node_id,
            });
          }
        } catch (err) {
          console.warn("[mastery.review.generate]", {
            opId,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    // 4) Last resort: generic int add
    if (out.length < need) {
      try {
        const remain = need - out.length;
        const gen = generateDrillQuestions({
          operationId: "int_add_2d",
          count: remain,
          difficulty: "basic",
        });
        for (const q of gen.questions) {
          if (out.length >= need) break;
          push(q);
        }
      } catch {
        /* ignore */
      }
    }

    return out.slice(0, need);
  }

  private resolveDrillOps(item: {
    knowledge_node_id: string | null;
    skill_key: string | null;
  }): string[] {
    if (item.knowledge_node_id) {
      const node = this.knowledge.getById(item.knowledge_node_id);
      if (node?.suggestedDrillOps?.length) {
        return node.suggestedDrillOps.slice(0, 3);
      }
    }
    return ["int_add_2d", "int_sub_2d"];
  }

  private async loadHistoricalSnapshots(item: {
    user_id: string;
    knowledge_node_id: string | null;
    skill_key: string | null;
  }): Promise<QuestionSnapshot[]> {
    // Snapshots from completed online submissions for this student
    let rows: Array<{ question_snapshot: string; is_correct: number | null }>;
    if (item.knowledge_node_id) {
      rows = (await this.db.all(
        `SELECT aq.question_snapshot, ai.is_correct
         FROM answer_items ai
         JOIN submissions s ON s.id = ai.submission_id
         JOIN assignment_questions aq ON aq.id = ai.assignment_question_id
         WHERE s.student_id = ?
           AND ai.is_correct IS NOT NULL
         ORDER BY CASE WHEN ai.is_correct = 0 THEN 0 ELSE 1 END, ai.updated_at DESC
         LIMIT 40`,
        item.user_id,
      )) as Array<{ question_snapshot: string; is_correct: number | null }>;
      const kn = item.knowledge_node_id;
      return rows
        .map((r) => {
          try {
            return JSON.parse(r.question_snapshot) as QuestionSnapshot;
          } catch {
            return null;
          }
        })
        .filter((s): s is QuestionSnapshot => !!s && s.knowledgeNodeId === kn);
    }

    // skill_key question:xxx → try load that bank question
    if (item.skill_key?.startsWith("question:")) {
      const qid = item.skill_key.slice("question:".length);
      const r = (await this.db.get(
        `SELECT type, stem, options_json, answer_json, explanation, knowledge_node_id, source, id
         FROM questions WHERE id = ?`,
        qid,
      )) as Record<string, unknown> | undefined;
      if (r) return [this.rowToSnapshot(r)];
    }

    return [];
  }

  private rowToSnapshot(r: Record<string, unknown>): QuestionSnapshot {
    let options: QuestionSnapshot["options"] = null;
    try {
      options = r.options_json
        ? (JSON.parse(String(r.options_json)) as QuestionSnapshot["options"])
        : null;
    } catch {
      options = null;
    }
    let answer: string | boolean = "";
    try {
      answer = JSON.parse(String(r.answer_json)) as string | boolean;
    } catch {
      answer = String(r.answer_json || "");
    }
    return {
      id: r.id ? String(r.id) : undefined,
      type: r.type as QuestionSnapshot["type"],
      stem: String(r.stem || ""),
      options,
      answer,
      explanation: r.explanation != null ? String(r.explanation) : null,
      knowledgeNodeId: r.knowledge_node_id
        ? String(r.knowledge_node_id)
        : null,
      source: (r.source as "manual" | "generated") || "manual",
    };
  }

  // ─── row helpers ─────────────────────────────────────────────────────────

  private async getItemRow(
    id: string,
    userId: string,
  ): Promise<{
    id: string;
    user_id: string;
    knowledge_node_id: string | null;
    skill_key: string | null;
    status: string;
    review_at: string;
    miss_count: number;
    pass_count: number;
    source_assignment_id: string | null;
  }> {
    const row = (await this.db.get(
      `SELECT * FROM mastery_items WHERE id = ? AND user_id = ?`,
      id,
      userId,
    )) as
      | {
          id: string;
          user_id: string;
          knowledge_node_id: string | null;
          skill_key: string | null;
          status: string;
          review_at: string;
          miss_count: number;
          pass_count: number;
          source_assignment_id: string | null;
        }
      | undefined;
    if (!row) throw new AppError("NOT_FOUND", "巩固项不存在", 404);
    return row;
  }

  private async getReviewRow(
    id: string,
    userId: string,
  ): Promise<Record<string, unknown>> {
    const row = (await this.db.get(
      `SELECT * FROM mastery_reviews WHERE id = ? AND user_id = ?`,
      id,
      userId,
    )) as Record<string, unknown> | undefined;
    if (!row) throw new AppError("NOT_FOUND", "回访不存在", 404);
    return row;
  }

  /** Count real queue slots (exclude self-practice scaffolds: open + miss_count 0). */
  private async countOpenDue(userId: string): Promise<number> {
    const row = (await this.db.get(
      `SELECT COUNT(*) AS n FROM mastery_items
       WHERE user_id = ?
         AND (
           status = 'due'
           OR (status = 'open' AND miss_count > 0)
         )`,
      userId,
    )) as { n: number } | undefined;
    return Number(row?.n) || 0;
  }

  private async findExisting(
    userId: string,
    knowledgeNodeId: string | null,
    skillKey: string | null,
  ): Promise<{ id: string } | undefined> {
    if (knowledgeNodeId) {
      return (await this.db.get(
        `SELECT id FROM mastery_items
         WHERE user_id = ? AND knowledge_node_id = ?
         LIMIT 1`,
        userId,
        knowledgeNodeId,
      )) as { id: string } | undefined;
    }
    if (skillKey) {
      return (await this.db.get(
        `SELECT id FROM mastery_items
         WHERE user_id = ? AND skill_key = ?
         LIMIT 1`,
        userId,
        skillKey,
      )) as { id: string } | undefined;
    }
    return undefined;
  }

  /** Merge miss into an existing mastery row (enqueue hit / race fallback). */
  private async mergeEnqueueHit(input: {
    id: string;
    userId: string;
    knowledgeNodeId: string | null;
    skillKey: string | null;
    wrongReason: WrongReason | null;
    assignmentId: string;
    classId: string | null;
    reviewAt: string;
    ts: string;
  }): Promise<void> {
    const {
      id,
      userId,
      knowledgeNodeId,
      skillKey,
      wrongReason,
      assignmentId,
      classId,
      reviewAt,
      ts,
    } = input;
    const prev = (await this.db.get(
      `SELECT status, miss_count FROM mastery_items WHERE id = ?`,
      id,
    )) as { status: string; miss_count: number } | undefined;
    const alreadyQueued =
      prev &&
      (prev.status === "due" ||
        (prev.status === "open" && Number(prev.miss_count) > 0));
    // Reopening passed/expired/scaffold into real open counts against cap
    if (!alreadyQueued) {
      const openCount = await this.countOpenDue(userId);
      if (openCount >= MASTERY_MAX_OPEN_PER_USER) {
        console.info("[mastery.enqueue.skip]", {
          userId,
          id,
          reason: "cap_reopen",
          cap: MASTERY_MAX_OPEN_PER_USER,
        });
        return;
      }
    }
    await this.db.run(
      `UPDATE mastery_items
         SET status = 'open',
             miss_count = miss_count + 1,
             review_at = ?,
             last_result_at = ?,
             last_wrong_reason = COALESCE(?, last_wrong_reason),
             source_assignment_id = ?,
             class_id = COALESCE(?, class_id),
             updated_at = ?
         WHERE id = ?`,
      reviewAt,
      ts,
      wrongReason,
      assignmentId,
      classId,
      ts,
      id,
    );
    console.info("[mastery.enqueue]", {
      userId,
      id,
      knowledgeNodeId,
      skillKey,
      reviewAt,
      merged: true,
    });
  }

  private toPublic(r: Record<string, unknown>): PublicMasteryItem {
    const knId = (r.knowledge_node_id as string) || null;
    const skillKey = (r.skill_key as string) || null;
    let name = "待巩固练习";
    let unitName: string | null = null;
    let pathLabel: string | null = null;
    if (knId) {
      const node = this.knowledge.getById(knId);
      if (node) {
        name = node.name;
        unitName = node.unitName ?? null;
        pathLabel = node.pathLabel ?? null;
      }
    } else if (skillKey?.startsWith("question:")) {
      name = "错题巩固";
    } else if (skillKey?.startsWith("stem:")) {
      name = "计算巩固";
    }

    return {
      id: String(r.id),
      knowledgeNodeId: knId,
      skillKey,
      name,
      unitName,
      pathLabel,
      status: r.status as MasteryStatus,
      missCount: Number(r.miss_count) || 0,
      passCount: Number(r.pass_count) || 0,
      reviewAt: String(r.review_at),
      lastWrongReason: (r.last_wrong_reason as string) || null,
      sourceAssignmentId: (r.source_assignment_id as string) || null,
      updatedAt: String(r.updated_at),
    };
  }

  private toPublicReview(
    row: Record<string, unknown>,
    item: { knowledge_node_id: string | null; skill_key: string | null },
  ): PublicMasteryReview {
    const pubItem = this.toPublic({
      ...item,
      id: row.mastery_item_id,
      knowledge_node_id: item.knowledge_node_id,
      skill_key: item.skill_key,
      status: "due",
      miss_count: 0,
      pass_count: 0,
      review_at: "",
      last_wrong_reason: null,
      source_assignment_id: null,
      updated_at: "",
    });

    const snapshots = JSON.parse(
      String(row.question_snapshots_json),
    ) as QuestionSnapshot[];
    const status = String(row.status) as PublicMasteryReview["status"];
    const showKey = status === "completed";
    const source =
      (row.source as "review" | "self_practice") || "review";

    let graded: Array<{
      questionIndex: number;
      response: unknown;
      isCorrect: boolean;
    }> = [];
    if (row.answers_json) {
      try {
        graded = JSON.parse(String(row.answers_json)) as typeof graded;
      } catch {
        graded = [];
      }
    }
    const byIdx = new Map(graded.map((g) => [g.questionIndex, g]));

    const questions: PublicReviewQuestion[] = snapshots.map((snap, index) => {
      const g = byIdx.get(index);
      const q: PublicReviewQuestion = {
        index,
        stem: snap.stem,
        type: snap.type,
        options: snap.options ?? null,
      };
      if (showKey && g) {
        q.isCorrect = g.isCorrect;
        q.response =
          g.response === undefined || g.response === null
            ? null
            : (g.response as string | boolean);
        q.correctAnswer = snap.answer;
        q.explanation = snap.explanation;
      }
      return q;
    });

    return {
      id: String(row.id),
      masteryItemId: String(row.mastery_item_id),
      source,
      status,
      title:
        source === "self_practice"
          ? `巩固：${pubItem.name}`
          : `回访：${pubItem.name}`,
      knowledgeName: pubItem.name,
      questions,
      correctCount:
        row.correct_count != null ? Number(row.correct_count) : null,
      totalCount: Number(row.total_count) || snapshots.length,
      passed: row.passed == null ? null : Number(row.passed) === 1,
      startedAt: String(row.started_at),
      completedAt: row.completed_at ? String(row.completed_at) : null,
    };
  }
}

/** MySQL ER_DUP_ENTRY / SQLite UNIQUE constraint — concurrent upsert race. */
function isUniqueConstraintError(err: unknown): boolean {
  const e = err as { code?: string; errno?: number; message?: string };
  const code = e?.code || "";
  if (code === "ER_DUP_ENTRY" || e?.errno === 1062) return true;
  if (
    code === "SQLITE_CONSTRAINT_UNIQUE" ||
    code === "SQLITE_CONSTRAINT"
  ) {
    return true;
  }
  const msg = String(e?.message || "");
  return (
    /UNIQUE constraint failed/i.test(msg) || /Duplicate entry/i.test(msg)
  );
}

/** Build enqueue misses from graded snapshots (used by AssignmentService). */
export function missesFromSnapshots(
  items: Array<{
    snapshot: QuestionSnapshot;
    sourceQuestionId?: string | null;
    wrongReason?: string | null;
  }>,
): EnqueueMiss[] {
  return items.map((it) => ({
    knowledgeNodeId: it.snapshot.knowledgeNodeId,
    sourceQuestionId: it.sourceQuestionId ?? it.snapshot.id ?? null,
    stem: it.snapshot.stem,
    wrongReason: it.wrongReason ?? null,
  }));
}
