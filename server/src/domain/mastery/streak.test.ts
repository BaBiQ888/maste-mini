import { describe, expect, it } from "vitest";
import {
  addShanghaiDays,
  computeStreakDays,
  countMonthLitDays,
} from "./streak.js";

describe("addShanghaiDays", () => {
  it("steps across month boundary", () => {
    expect(addShanghaiDays("2026-07-01", -1)).toBe("2026-06-30");
    expect(addShanghaiDays("2026-06-30", 1)).toBe("2026-07-01");
  });
});

describe("computeStreakDays", () => {
  it("returns 0 when no dates", () => {
    expect(computeStreakDays([], "2026-07-29")).toBe(0);
  });

  it("counts back from today when today is lit", () => {
    const days = ["2026-07-27", "2026-07-28", "2026-07-29"];
    expect(computeStreakDays(days, "2026-07-29")).toBe(3);
  });

  it("keeps streak alive if today empty but yesterday lit", () => {
    const days = ["2026-07-27", "2026-07-28"];
    expect(computeStreakDays(days, "2026-07-29")).toBe(2);
  });

  it("breaks when yesterday missing and today empty", () => {
    const days = ["2026-07-26", "2026-07-27"];
    expect(computeStreakDays(days, "2026-07-29")).toBe(0);
  });

  it("today alone is streak 1", () => {
    expect(computeStreakDays(["2026-07-29"], "2026-07-29")).toBe(1);
  });

  it("ignores gaps in the middle of history once broken", () => {
    const days = ["2026-07-20", "2026-07-28", "2026-07-29"];
    expect(computeStreakDays(days, "2026-07-29")).toBe(2);
  });
});

describe("countMonthLitDays", () => {
  it("counts unique days in month", () => {
    const days = ["2026-07-01", "2026-07-01", "2026-07-15", "2026-06-30"];
    expect(countMonthLitDays(days, 2026, 7)).toBe(2);
  });
});
