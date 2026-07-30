import { describe, expect, it } from "vitest";
import {
  buildWeekSummaryCopy,
  computeCalendarDayState,
  computeMapNodeState,
  computeReviewAt,
  isReviewPassed,
  isWrongReason,
  resolveMasteryKey,
  shanghaiWeekBounds,
} from "./rules.js";
import { shanghaiYmd } from "./streak.js";

describe("mastery rules", () => {
  it("validates wrong reasons", () => {
    expect(isWrongReason("careless")).toBe(true);
    expect(isWrongReason("nope")).toBe(false);
  });

  it("isReviewPassed requires min correct", () => {
    expect(isReviewPassed(3, 3)).toBe(true);
    expect(isReviewPassed(2, 3)).toBe(false);
    expect(isReviewPassed(2, 2, 2)).toBe(true);
  });

  it("map node states", () => {
    expect(
      computeMapNodeState({
        hasCompletion: false,
        masteryStatus: null,
        recentCorrectRate: null,
        recentAnswered: 0,
      }),
    ).toBe("dark");
    expect(
      computeMapNodeState({
        hasCompletion: true,
        masteryStatus: "open",
        recentCorrectRate: 100,
        recentAnswered: 5,
      }),
    ).toBe("half");
    expect(
      computeMapNodeState({
        hasCompletion: true,
        masteryStatus: null,
        recentCorrectRate: 50,
        recentAnswered: 4,
      }),
    ).toBe("half");
    expect(
      computeMapNodeState({
        hasCompletion: true,
        masteryStatus: "passed",
        recentCorrectRate: 90,
        recentAnswered: 4,
      }),
    ).toBe("lit");
  });

  it("calendar day states", () => {
    expect(
      computeCalendarDayState({
        completedCount: 0,
        overdueCount: 0,
        hasReviewDue: false,
      }),
    ).toBe("none");
    expect(
      computeCalendarDayState({
        completedCount: 2,
        overdueCount: 0,
        hasReviewDue: false,
      }),
    ).toBe("done");
    expect(
      computeCalendarDayState({
        completedCount: 1,
        overdueCount: 1,
        hasReviewDue: false,
      }),
    ).toBe("partial");
    expect(
      computeCalendarDayState({
        completedCount: 0,
        overdueCount: 0,
        hasReviewDue: true,
      }),
    ).toBe("review_due");
  });

  it("shanghai week bounds Mon–Sun", () => {
    // 2026-07-29 is Wednesday
    const w = shanghaiWeekBounds(new Date("2026-07-29T12:00:00+08:00"));
    expect(w.startYmd).toBe("2026-07-27");
    expect(w.endYmd).toBe("2026-08-02");
    expect(w.label).toContain("7/27");
  });

  it("builds week summary copy", () => {
    const t = buildWeekSummaryCopy({
      weekLabel: "7/27–8/2",
      completedTaskCount: 3,
      litDays: 4,
      knowledgeNames: ["两位数加法", "分数加减"],
    });
    expect(t).toContain("算本本周小结");
    expect(t).toContain("两位数加法");
    expect(t).toContain("完成任务 3 次");
  });

  it("prefers knowledge node id", () => {
    expect(
      resolveMasteryKey({
        knowledgeNodeId: "g3-u-add",
        sourceQuestionId: "q1",
        stem: "1+1",
      }),
    ).toEqual({ knowledgeNodeId: "g3-u-add", skillKey: null });
  });

  it("falls back to question then stem skill key", () => {
    expect(
      resolveMasteryKey({ knowledgeNodeId: null, sourceQuestionId: "qid" }),
    ).toEqual({ knowledgeNodeId: null, skillKey: "question:qid" });
    const a = resolveMasteryKey({
      knowledgeNodeId: null,
      stem: "3+4=",
      assignmentType: "daily_drill",
    });
    const b = resolveMasteryKey({
      knowledgeNodeId: null,
      stem: "3+4=",
      assignmentType: "daily_drill",
    });
    expect(a.skillKey).toBe(b.skillKey);
    expect(a.skillKey?.startsWith("stem:")).toBe(true);
  });

  it("computeReviewAt is after today in Shanghai", () => {
    const at = computeReviewAt(new Date("2026-07-29T12:00:00+08:00"), 3);
    // 2026-08-01 00:00+08
    expect(at).toContain("2026-07-31"); // ISO may be 31st UTC evening
    const ymd = shanghaiYmd(new Date(at));
    expect(ymd).toBe("2026-08-01");
  });
});
