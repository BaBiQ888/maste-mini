/**
 * Student completion streak helpers (Asia/Shanghai calendar days).
 * Pure functions — no I/O. Used by ProgressService and unit tests.
 */

/** YYYY-MM-DD in Asia/Shanghai for a given instant */
export function shanghaiYmd(now: Date = new Date()): string {
  return now.toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
}

/** Add whole calendar days to a Shanghai YYYY-MM-DD (noon +08 avoids edge cases). */
export function addShanghaiDays(ymd: string, delta: number): string {
  const base = new Date(`${ymd}T12:00:00+08:00`);
  if (Number.isNaN(base.getTime())) return ymd;
  base.setTime(base.getTime() + delta * 86_400_000);
  return base.toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
}

/**
 * Consecutive lit days ending at "today".
 * - If today is lit: count back from today.
 * - If today is not lit but yesterday is: streak still alive (pending today).
 * - If neither today nor yesterday is lit: 0.
 */
export function computeStreakDays(
  completedYmds: Iterable<string>,
  todayYmd: string = shanghaiYmd(),
): number {
  const set = new Set<string>();
  for (const d of completedYmds) {
    if (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) set.add(d);
  }
  let cursor = todayYmd;
  if (!set.has(cursor)) {
    cursor = addShanghaiDays(todayYmd, -1);
    if (!set.has(cursor)) return 0;
  }
  let n = 0;
  while (set.has(cursor)) {
    n += 1;
    cursor = addShanghaiDays(cursor, -1);
  }
  return n;
}

/** Count unique YYYY-MM-DD in a set that fall in year-month. */
export function countMonthLitDays(
  completedYmds: Iterable<string>,
  year: number,
  month: number,
): number {
  const prefix = `${year}-${String(month).padStart(2, "0")}`;
  const seen = new Set<string>();
  for (const d of completedYmds) {
    if (d && d.startsWith(prefix)) seen.add(d);
  }
  return seen.size;
}
