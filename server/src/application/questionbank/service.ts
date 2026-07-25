import type Database from "better-sqlite3";
import { createId, nowIso } from "../../infrastructure/persistence/db.js";
import { AppError } from "../../domain/shared/errors.js";
import type {
  ChoiceOption,
  QuestionSnapshot,
  QuestionType,
} from "../../domain/question/types.js";

export type { ChoiceOption, QuestionSnapshot, QuestionType };

export interface PublicQuestion extends QuestionSnapshot {
  id: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export class QuestionBankService {
  constructor(private db: Database.Database) {}

  create(
    teacherId: string,
    input: {
      type: QuestionType;
      stem: string;
      options?: ChoiceOption[] | null;
      answer: string | boolean;
      explanation?: string | null;
      knowledgeNodeId?: string | null;
      source?: "manual" | "generated";
    },
  ): PublicQuestion {
    this.assertTeacher(teacherId);
    const payload = this.normalizeInput(input);
    const id = createId("q");
    const ts = nowIso();
    const source = input.source === "generated" ? "generated" : "manual";
    this.db
      .prepare(
        `INSERT INTO questions
         (id, created_by, type, stem, options_json, answer_json, explanation, knowledge_node_id, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        teacherId,
        payload.type,
        payload.stem,
        payload.options ? JSON.stringify(payload.options) : null,
        JSON.stringify(payload.answer),
        payload.explanation,
        payload.knowledgeNodeId,
        source,
        ts,
        ts,
      );
    return this.getById(id, teacherId)!;
  }

  /** Persist generated snapshots as bank questions (source=generated). */
  createManyGenerated(
    teacherId: string,
    snaps: QuestionSnapshot[],
  ): PublicQuestion[] {
    return snaps.map((s) =>
      this.create(teacherId, {
        type: s.type,
        stem: s.stem,
        options: s.options,
        answer: s.answer,
        explanation: s.explanation,
        knowledgeNodeId: s.knowledgeNodeId,
        source: "generated",
      }),
    );
  }

  update(
    questionId: string,
    teacherId: string,
    input: Partial<{
      type: QuestionType;
      stem: string;
      options: ChoiceOption[] | null;
      answer: string | boolean;
      explanation: string | null;
      knowledgeNodeId: string | null;
    }>,
  ): PublicQuestion {
    const current = this.getRowOwned(questionId, teacherId);
    const merged = this.normalizeInput({
      type: (input.type || current.type) as QuestionType,
      stem: input.stem ?? current.stem,
      options:
        input.options !== undefined
          ? input.options
          : current.options_json
            ? JSON.parse(current.options_json)
            : null,
      answer:
        input.answer !== undefined
          ? input.answer
          : JSON.parse(current.answer_json),
      explanation:
        input.explanation !== undefined
          ? input.explanation
          : current.explanation,
      knowledgeNodeId:
        input.knowledgeNodeId !== undefined
          ? input.knowledgeNodeId
          : current.knowledge_node_id,
    });
    const ts = nowIso();
    this.db
      .prepare(
        `UPDATE questions SET
           type = ?, stem = ?, options_json = ?, answer_json = ?,
           explanation = ?, knowledge_node_id = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        merged.type,
        merged.stem,
        merged.options ? JSON.stringify(merged.options) : null,
        JSON.stringify(merged.answer),
        merged.explanation,
        merged.knowledgeNodeId,
        ts,
        questionId,
      );
    return this.getById(questionId, teacherId)!;
  }

  listForTeacher(
    teacherId: string,
    opts?: { knowledgeNodeId?: string; type?: QuestionType },
  ): PublicQuestion[] {
    this.assertTeacher(teacherId);
    let sql = `SELECT * FROM questions WHERE created_by = ?`;
    const params: unknown[] = [teacherId];
    if (opts?.knowledgeNodeId) {
      sql += ` AND knowledge_node_id = ?`;
      params.push(opts.knowledgeNodeId);
    }
    if (opts?.type) {
      sql += ` AND type = ?`;
      params.push(opts.type);
    }
    sql += ` ORDER BY updated_at DESC`;
    const rows = this.db.prepare(sql).all(...params) as QuestionRow[];
    return rows.map((r) => this.toPublic(r));
  }

  getById(questionId: string, teacherId: string): PublicQuestion | null {
    const row = this.db
      .prepare(`SELECT * FROM questions WHERE id = ? AND created_by = ?`)
      .get(questionId, teacherId) as QuestionRow | undefined;
    return row ? this.toPublic(row) : null;
  }

  getSnapshotById(questionId: string): QuestionSnapshot {
    const row = this.db
      .prepare(`SELECT * FROM questions WHERE id = ?`)
      .get(questionId) as QuestionRow | undefined;
    if (!row) throw new AppError("NOT_FOUND", "题目不存在", 404);
    return this.toSnapshot(row);
  }

  getManyOwned(ids: string[], teacherId: string): QuestionRow[] {
    if (!ids.length) return [];
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT * FROM questions WHERE created_by = ? AND id IN (${placeholders})`,
      )
      .all(teacherId, ...ids) as QuestionRow[];
    if (rows.length !== ids.length) {
      throw new AppError("INVALID_QUESTIONS", "部分题目不存在或无权使用");
    }
    // preserve order of ids
    const map = new Map(rows.map((r) => [r.id, r]));
    return ids.map((id) => map.get(id)!);
  }

  private normalizeInput(input: {
    type: QuestionType;
    stem: string;
    options?: ChoiceOption[] | null;
    answer: string | boolean;
    explanation?: string | null;
    knowledgeNodeId?: string | null;
  }): {
    type: QuestionType;
    stem: string;
    options: ChoiceOption[] | null;
    answer: string | boolean;
    explanation: string | null;
    knowledgeNodeId: string | null;
  } {
    const type = input.type;
    if (!["fill_blank", "choice", "true_false"].includes(type)) {
      throw new AppError("INVALID_TYPE", "题型无效");
    }
    const stem = (input.stem || "").trim();
    if (!stem || stem.length > 2000) {
      throw new AppError("INVALID_STEM", "题干需 1–2000 字");
    }

    let options: ChoiceOption[] | null = null;
    let answer: string | boolean = input.answer;

    if (type === "choice") {
      const opts = (input.options || []).map((o, i) => ({
        id: (o.id || `opt_${i + 1}`).trim(),
        text: (o.text || "").trim(),
      }));
      if (opts.length < 2 || opts.length > 6) {
        throw new AppError("INVALID_OPTIONS", "选择题需 2–6 个选项");
      }
      if (opts.some((o) => !o.text)) {
        throw new AppError("INVALID_OPTIONS", "选项内容不能为空");
      }
      options = opts;
      const ans = String(answer).trim();
      if (!opts.some((o) => o.id === ans)) {
        throw new AppError("INVALID_ANSWER", "答案必须是某个选项 id");
      }
      answer = ans;
    } else if (type === "true_false") {
      if (typeof answer === "string") {
        const v = answer.trim().toLowerCase();
        if (["true", "1", "对", "正确", "t"].includes(v)) answer = true;
        else if (["false", "0", "错", "错误", "f"].includes(v)) answer = false;
        else throw new AppError("INVALID_ANSWER", "判断题答案须为 true/false");
      }
      if (typeof answer !== "boolean") {
        throw new AppError("INVALID_ANSWER", "判断题答案须为布尔值");
      }
      options = null;
    } else {
      // fill_blank
      answer = String(answer ?? "").trim();
      if (!answer) throw new AppError("INVALID_ANSWER", "填空题答案不能为空");
      options = null;
    }

    const explanation = input.explanation?.trim() || null;
    const knowledgeNodeId = input.knowledgeNodeId?.trim() || null;

    return {
      type,
      stem,
      options,
      answer,
      explanation,
      knowledgeNodeId,
    };
  }

  private assertTeacher(userId: string): void {
    const row = this.db
      .prepare(`SELECT role FROM users WHERE id = ?`)
      .get(userId) as { role: string | null } | undefined;
    if (row?.role !== "teacher") {
      throw new AppError("FORBIDDEN", "仅老师可管理题库", 403);
    }
  }

  private getRowOwned(id: string, teacherId: string): QuestionRow {
    const row = this.db
      .prepare(`SELECT * FROM questions WHERE id = ? AND created_by = ?`)
      .get(id, teacherId) as QuestionRow | undefined;
    if (!row) throw new AppError("NOT_FOUND", "题目不存在", 404);
    return row;
  }

  private toSnapshot(row: QuestionRow): QuestionSnapshot {
    return {
      id: row.id,
      type: row.type as QuestionType,
      stem: row.stem,
      options: row.options_json ? JSON.parse(row.options_json) : null,
      answer: JSON.parse(row.answer_json),
      explanation: row.explanation,
      knowledgeNodeId: row.knowledge_node_id,
      source: (row.source as "manual" | "generated") || "manual",
    };
  }

  private toPublic(row: QuestionRow): PublicQuestion {
    const snap = this.toSnapshot(row);
    return {
      ...snap,
      id: row.id,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

export interface QuestionRow {
  id: string;
  created_by: string;
  type: string;
  stem: string;
  options_json: string | null;
  answer_json: string;
  explanation: string | null;
  knowledge_node_id: string | null;
  source: string;
  created_at: string;
  updated_at: string;
}
