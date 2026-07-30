/**
 * Mastery queue pure rules (S2+). No I/O.
 */
import { addShanghaiDays, shanghaiYmd } from "./streak.js";

export const MASTERY_REVIEW_DELAY_DAYS = 3;
export const MASTERY_MAX_OPEN_PER_USER = 20;
export const MASTERY_REVIEW_QUESTION_COUNT = 3;
export const MASTERY_SELF_PRACTICE_COUNT = 5;
/** All N questions correct to pass (default N=3). */
export const MASTERY_PASS_MIN_CORRECT = 3;
export const MASTERY_ITEM_EXPIRE_DAYS = 30;
/** Recent window for map accuracy (days). */
export const MASTERY_MAP_WINDOW_DAYS = 14;
/**
 * Completions older than this do not count as map "lit" history.
 * Bounds getMasteryMap scan cost vs full student lifetime.
 */
export const MASTERY_MAP_COMPLETION_DAYS = 365;
export const MASTERY_MAP_HALF_RATE = 80;

export type MapNodeState = "dark" | "half" | "lit";

/**
 * Knowledge map node state (S4).
 * - half: real queue (due / open with miss_count&gt;0) OR recent accuracy &lt; 80%
 * - lit: has completion / passed mastery, and not half
 * - dark: never practiced
 * Scaffold rows (open + miss_count 0) do NOT force half.
 * Note: formal review fail reopens as open immediately — status "failed" is not written.
 */
export function computeMapNodeState(input: {
  hasCompletion: boolean;
  masteryStatus: string | null;
  /** When open, missCount 0 = self-practice scaffold only */
  missCount?: number | null;
  recentCorrectRate: number | null;
  recentAnswered: number;
}): MapNodeState {
  const st = input.masteryStatus;
  const miss = Number(input.missCount) || 0;
  const queueActive =
    st === "due" ||
    // legacy / unused: fail path writes open, not failed
    st === "failed" ||
    (st === "open" && miss > 0);
  if (queueActive) return "half";
  if (
    input.recentAnswered > 0 &&
    input.recentCorrectRate != null &&
    input.recentCorrectRate < MASTERY_MAP_HALF_RATE
  ) {
    return "half";
  }
  if (st === "passed" || input.hasCompletion) return "lit";
  return "dark";
}

export type CalendarDayState = "none" | "done" | "partial" | "review_due";

/** Calendar cell state from completion + overdue + review flags. */
export function computeCalendarDayState(input: {
  completedCount: number;
  overdueCount: number;
  hasReviewDue: boolean;
}): CalendarDayState {
  if (input.completedCount <= 0 && input.hasReviewDue) return "review_due";
  if (input.completedCount <= 0) return "none";
  if (input.overdueCount > 0) return "partial";
  return "done";
}

/** Monday-start week bounds in Asia/Shanghai (inclusive YMD, ISO half-open end). */
export function shanghaiWeekBounds(now: Date = new Date()): {
  startYmd: string;
  endYmd: string;
  startIso: string;
  endIsoExclusive: string;
  label: string;
} {
  const today = shanghaiYmd(now);
  const noon = new Date(`${today}T12:00:00+08:00`);
  const wdShort = noon.toLocaleDateString("en-US", {
    timeZone: "Asia/Shanghai",
    weekday: "short",
  });
  const map: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  const wd = map[wdShort] ?? 0;
  const daysFromMonday = wd === 0 ? 6 : wd - 1;
  const startYmd = addShanghaiDays(today, -daysFromMonday);
  const endYmd = addShanghaiDays(startYmd, 6);
  const nextMon = addShanghaiDays(startYmd, 7);
  const startIso = new Date(`${startYmd}T00:00:00+08:00`).toISOString();
  const endIsoExclusive = new Date(`${nextMon}T00:00:00+08:00`).toISOString();
  const fmt = (ymd: string) => {
    const [, m, d] = ymd.split("-");
    return `${Number(m)}/${Number(d)}`;
  };
  return {
    startYmd,
    endYmd,
    startIso,
    endIsoExclusive,
    label: `${fmt(startYmd)}–${fmt(endYmd)}`,
  };
}

/** Build low-pressure weekly copy for parent WeChat paste. */
export function buildWeekSummaryCopy(input: {
  weekLabel: string;
  completedTaskCount: number;
  litDays: number;
  knowledgeNames: string[];
}): string {
  const names = input.knowledgeNames.slice(0, 6);
  const nameLine =
    names.length > 0
      ? names.join("、") + (input.knowledgeNames.length > 6 ? "…" : "")
      : "本周暂无新巩固点";
  return [
    `【算本本周小结】${input.weekLabel}`,
    `· 完成任务 ${input.completedTaskCount} 次`,
    `· 学习点亮 ${input.litDays} 天`,
    `· 点亮/巩固：${nameLine}`,
  ].join("\n");
}

export function isReviewPassed(
  correctCount: number,
  totalCount: number,
  minCorrect: number = MASTERY_PASS_MIN_CORRECT,
): boolean {
  if (totalCount <= 0) return false;
  const need = Math.min(minCorrect, totalCount);
  return correctCount >= need;
}

export const WRONG_REASONS = [
  "careless",
  "concept",
  "procedure",
  "misread",
] as const;

export type WrongReason = (typeof WRONG_REASONS)[number];

export function isWrongReason(v: unknown): v is WrongReason {
  return (
    typeof v === "string" &&
    (WRONG_REASONS as readonly string[]).includes(v)
  );
}

/** Next review_at: Shanghai calendar day of `from` + delayDays at local midnight → ISO. */
export function computeReviewAt(
  from: Date = new Date(),
  delayDays: number = MASTERY_REVIEW_DELAY_DAYS,
): string {
  const ymd = shanghaiYmd(from);
  const dueYmd = addShanghaiDays(ymd, delayDays);
  return new Date(`${dueYmd}T00:00:00+08:00`).toISOString();
}

/**
 * Resolve mastery key from question snapshot.
 * Prefer knowledge_node_id; else skill_key (question id / stem fingerprint).
 */
export function resolveMasteryKey(input: {
  knowledgeNodeId?: string | null;
  sourceQuestionId?: string | null;
  stem?: string | null;
  assignmentType?: string | null;
}): { knowledgeNodeId: string | null; skillKey: string | null } {
  const kid = (input.knowledgeNodeId || "").trim();
  if (kid) {
    return { knowledgeNodeId: kid, skillKey: null };
  }
  const qid = (input.sourceQuestionId || "").trim();
  if (qid) {
    return { knowledgeNodeId: null, skillKey: `question:${qid}` };
  }
  const stem = (input.stem || "").trim().slice(0, 80);
  if (stem) {
    // Short stable key without crypto dep
    let h = 0;
    for (let i = 0; i < stem.length; i++) {
      h = (Math.imul(31, h) + stem.charCodeAt(i)) | 0;
    }
    const type = (input.assignmentType || "online").slice(0, 16);
    return {
      knowledgeNodeId: null,
      skillKey: `stem:${type}:${(h >>> 0).toString(16)}`,
    };
  }
  return { knowledgeNodeId: null, skillKey: "unknown" };
}
