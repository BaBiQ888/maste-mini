import type { QuestionSnapshot, QuestionType } from "../question/types.js";

/** Limited normalize per PRD: trim + fullwidth digits/punct to half */
export function normalizeText(input: string): string {
  return input
    .trim()
    .replace(/[\uFF10-\uFF19]/g, (ch) =>
      String.fromCharCode(ch.charCodeAt(0) - 0xff10 + 0x30),
    )
    .replace(/\uFF0E/g, ".")
    .replace(/\u2212/g, "-")
    .replace(/\uFF0D/g, "-")
    // remainder formats: 12余3 / 商12余3 → 12...3
    .replace(/商/g, "")
    .replace(/余/g, "...")
    .replace(/\s+/g, "");
}

/**
 * Parse simple numeric / fraction strings for fill-blank math equivalence.
 * Supports integers, decimals, and a/b fractions (e.g. 1/2, -3/4).
 */
export function parseMathNumber(input: string): number | null {
  const s = normalizeText(input);
  if (!s) return null;
  const frac = s.match(/^(-?\d+)\/(\d+)$/);
  if (frac) {
    const den = Number(frac[2]);
    if (!den) return null;
    return Number(frac[1]) / den;
  }
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** True when strings are equal after normalize, or represent the same number. */
export function answersMatch(expected: string, actual: string): boolean {
  const a = normalizeText(expected);
  const b = normalizeText(actual);
  if (a === b) return true;
  const na = parseMathNumber(a);
  const nb = parseMathNumber(b);
  if (na != null && nb != null) {
    return Math.abs(na - nb) < 1e-9;
  }
  return false;
}

export function normalizeResponse(
  type: QuestionType,
  response: unknown,
): string | boolean | null {
  if (type === "true_false") {
    if (typeof response === "boolean") return response;
    if (response === null || response === undefined || response === "") {
      return null;
    }
    const v = String(response).trim().toLowerCase();
    if (["true", "1", "对", "正确", "t", "yes"].includes(v)) return true;
    if (["false", "0", "错", "错误", "f", "no"].includes(v)) return false;
    return null;
  }
  if (response === null || response === undefined) return null;
  const s = normalizeText(String(response));
  return s === "" ? null : s;
}

export function gradeOne(
  snapshot: QuestionSnapshot,
  response: unknown,
): { correct: boolean; normalized: string | boolean | null } {
  const normalized = normalizeResponse(snapshot.type, response);
  if (normalized === null) {
    return { correct: false, normalized: null };
  }

  if (snapshot.type === "true_false") {
    return {
      correct: normalized === Boolean(snapshot.answer),
      normalized,
    };
  }

  if (snapshot.type === "choice") {
    return {
      correct: String(normalized) === String(snapshot.answer),
      normalized,
    };
  }

  // fill_blank — string normalize + simple math equivalence (1/2 ≡ 0.5)
  const expected = normalizeText(String(snapshot.answer));
  return {
    correct: answersMatch(expected, String(normalized)),
    normalized,
  };
}
