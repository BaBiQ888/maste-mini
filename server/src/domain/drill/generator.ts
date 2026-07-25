import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AppError } from "../shared/errors.js";
import type { QuestionSnapshot } from "../question/types.js";

export type Difficulty = "basic" | "normal" | "challenge";

export interface GenerateSpec {
  operationId: string;
  count: number;
  difficulty?: Difficulty;
  /** For reproducible tests */
  seed?: number;
}

export interface OperationMeta {
  id: string;
  name: string;
  category: string;
  grades: number[];
  enabled: boolean;
  stemTemplate?: string;
  generator: Record<string, unknown>;
  answer?: { type?: string; format?: string; display?: string };
  relatedKnowledgeIds?: string[];
}

interface Catalog {
  operations: OperationMeta[];
  gradeDefaultOperations?: Record<string, string[]>;
  defaults?: {
    defaultCountOptions?: number[];
    defaultTimeLimitSecOptions?: (number | null)[];
    difficultyLevels?: string[];
  };
}

let catalogCache: Catalog | null = null;

export function loadDrillCatalog(catalogPath?: string): Catalog {
  if (catalogCache && !catalogPath) return catalogCache;
  const base =
    catalogPath ||
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../../packages/content/drill-operations.json",
    );
  // monorepo content roots
  const candidates = [
    base,
    path.join(process.cwd(), "packages/content/drill-operations.json"),
    path.join(process.cwd(), "content/drill-operations.json"),
    path.join(process.cwd(), "server/content/drill-operations.json"),
  ];
  let raw: string | null = null;
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      raw = fs.readFileSync(p, "utf8");
      break;
    }
  }
  if (!raw) {
    throw new AppError("CATALOG_MISSING", "找不到运算清单 drill-operations.json", 500);
  }
  const catalog = JSON.parse(raw) as Catalog;
  if (!catalogPath) catalogCache = catalog;
  return catalog;
}

export function listOperations(grade?: number): OperationMeta[] {
  const cat = loadDrillCatalog();
  return cat.operations.filter((op) => {
    if (!op.enabled) return false;
    if (grade != null && !op.grades.includes(grade)) return false;
    return true;
  });
}

export function generateDrillQuestions(spec: GenerateSpec): {
  operation: OperationMeta;
  questions: QuestionSnapshot[];
  seed: number;
} {
  const count = Math.floor(spec.count);
  if (!Number.isFinite(count) || count < 1 || count > 50) {
    throw new AppError("INVALID_COUNT", "题量需在 1–50");
  }
  const difficulty: Difficulty = spec.difficulty || "normal";
  if (!["basic", "normal", "challenge"].includes(difficulty)) {
    throw new AppError("INVALID_DIFFICULTY", "难度无效");
  }

  const cat = loadDrillCatalog();
  const op = cat.operations.find((o) => o.id === spec.operationId && o.enabled);
  if (!op) {
    throw new AppError("INVALID_OPERATION", "未知或未启用的运算类型");
  }

  const seed = spec.seed ?? (Date.now() % 1_000_000_000);
  const rng = mulberry32(seed >>> 0);
  const questions: QuestionSnapshot[] = [];
  const seen = new Set<string>();

  let guard = 0;
  while (questions.length < count && guard < count * 40) {
    guard += 1;
    const q = generateOne(op, difficulty, rng);
    if (!q) continue;
    const key = `${q.stem}|${q.answer}`;
    if (seen.has(key)) continue;
    seen.add(key);
    questions.push(q);
  }

  if (questions.length < count) {
    throw new AppError(
      "GENERATE_FAILED",
      `仅生成 ${questions.length}/${count} 题，请换难度或减少题量`,
    );
  }

  return { operation: op, questions, seed };
}

function generateOne(
  op: OperationMeta,
  difficulty: Difficulty,
  rng: () => number,
): QuestionSnapshot | null {
  const gen = op.generator as {
    kind: string;
    op?: string;
    byDifficulty?: Record<string, Record<string, unknown>>;
  };
  const diff = { ...(gen.byDifficulty?.[difficulty] || {}) };

  try {
    switch (gen.kind) {
      case "binary_op":
        return genBinary(op, gen as BinaryGen, diff, rng);
      case "div_exact":
        return genDivExact(op, gen as DivExactGen, diff, rng);
      case "div_remainder":
        return genDivRemainder(op, gen as DivRemGen, diff, rng);
      case "decimal_binary":
        return genDecimalBinary(op, gen as DecimalGen, diff, rng);
      case "decimal_mul":
        return genDecimalMul(op, gen as DecimalMulGen, diff, rng);
      case "decimal_div_exact":
        return genDecimalDiv(op, gen as DecimalDivGen, diff, rng);
      case "fraction_same_den":
        return genFracSame(op, gen as FracSameGen, diff, rng);
      case "fraction_diff_den":
        return genFracDiff(op, gen as FracDiffGen, diff, rng);
      case "mixed_two_step":
        return genMixed(op, gen as MixedGen, diff, rng);
      case "unit_convert":
        return genUnit(op, gen as UnitGen, diff, rng);
      default:
        throw new AppError(
          "UNSUPPORTED_KIND",
          `暂不支持生成器 kind=${gen.kind}`,
        );
    }
  } catch (e) {
    if (e instanceof AppError) throw e;
    return null;
  }
}

// —— RNG ——
function mulberry32(a: number): () => number {
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randInt(rng: () => number, min: number, max: number): number {
  const lo = Math.ceil(min);
  const hi = Math.floor(max);
  if (hi < lo) return lo;
  return lo + Math.floor(rng() * (hi - lo + 1));
}

function pick<T>(rng: () => number, arr: T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

// —— generators ——

interface BinaryGen {
  kind: "binary_op";
  op: "add" | "sub" | "mul";
  operands: Array<{ name: string; min: number; max: number }>;
  constraints?: Array<{ type: string; value?: number }>;
}

function genBinary(
  opMeta: OperationMeta,
  gen: BinaryGen,
  diff: Record<string, unknown>,
  rng: () => number,
): QuestionSnapshot | null {
  const aSpec = mergeRange(gen.operands[0], diff.a as { min?: number; max?: number } | undefined);
  const bSpec = mergeRange(gen.operands[1], diff.b as { min?: number; max?: number } | undefined);

  for (let i = 0; i < 30; i++) {
    let a = randInt(rng, aSpec.min, aSpec.max);
    let b = randInt(rng, bSpec.min, bSpec.max);

    if (gen.op === "sub" && hasConstraint(gen, "a_gte_b") && a < b) {
      [a, b] = [b, a];
    }

    if (diff.noCarry && gen.op === "add" && hasCarry(a, b)) continue;
    if (diff.preferCarry && gen.op === "add" && !hasCarry(a, b) && i < 20) continue;
    if (diff.noBorrow && gen.op === "sub" && hasBorrow(a, b)) continue;
    if (diff.preferBorrow && gen.op === "sub" && !hasBorrow(a, b) && i < 20) {
      continue;
    }

    let ans: number;
    if (gen.op === "add") ans = a + b;
    else if (gen.op === "sub") ans = a - b;
    else ans = a * b;

    const sumMax = gen.constraints?.find((c) => c.type === "sum_max");
    if (sumMax && gen.op === "add" && ans > (sumMax.value || 0)) continue;
    if (ans < 0) continue;

    const stem = (opMeta.stemTemplate || "{a} ? {b} =")
      .replace("{a}", String(a))
      .replace("{b}", String(b));

    return fillQ(stem, String(ans), opMeta);
  }
  return null;
}

interface DivExactGen {
  kind: "div_exact";
  divisor?: { min: number; max: number };
  quotient?: { min: number; max: number };
}

function genDivExact(
  opMeta: OperationMeta,
  gen: DivExactGen,
  diff: Record<string, unknown>,
  rng: () => number,
): QuestionSnapshot | null {
  const divR = mergeRange(
    gen.divisor || { min: 2, max: 9 },
    diff.divisor as { min?: number; max?: number } | undefined,
  );
  const qR = mergeRange(
    gen.quotient || { min: 1, max: 99 },
    diff.quotient as { min?: number; max?: number } | undefined,
  );
  // table style: operands 1-9
  if ((gen as { operands?: unknown }).operands) {
    // table mul style handled elsewhere
  }
  const divisor = randInt(rng, Math.max(1, divR.min), divR.max);
  const quotient = randInt(rng, Math.max(1, qR.min), qR.max);
  const dividend = divisor * quotient;
  const stem = (opMeta.stemTemplate || "{a} ÷ {b} =")
    .replace("{a}", String(dividend))
    .replace("{b}", String(divisor));
  return fillQ(stem, String(quotient), opMeta);
}

interface DivRemGen {
  kind: "div_remainder";
  divisor: { min: number; max: number };
  quotient: { min: number; max: number };
}

function genDivRemainder(
  opMeta: OperationMeta,
  gen: DivRemGen,
  diff: Record<string, unknown>,
  rng: () => number,
): QuestionSnapshot | null {
  const divR = mergeRange(gen.divisor, diff.divisor as { min?: number; max?: number });
  const qR = mergeRange(gen.quotient, diff.quotient as { min?: number; max?: number });
  const divisor = randInt(rng, Math.max(2, divR.min), divR.max);
  const quotient = randInt(rng, Math.max(1, qR.min), qR.max);
  const remainder = randInt(rng, 1, divisor - 1);
  const dividend = divisor * quotient + remainder;
  const stem = (opMeta.stemTemplate || "{a} ÷ {b} =")
    .replace("{a}", String(dividend))
    .replace("{b}", String(divisor));
  // standard answer format q...r
  return fillQ(stem, `${quotient}...${remainder}`, opMeta);
}

interface DecimalGen {
  kind: "decimal_binary";
  op: "add" | "sub";
  decimalPlaces?: { min: number; max: number };
  intPart?: { min: number; max: number };
}

function genDecimalBinary(
  opMeta: OperationMeta,
  gen: DecimalGen,
  diff: Record<string, unknown>,
  rng: () => number,
): QuestionSnapshot | null {
  const placesSpec = (diff.decimalPlaces || gen.decimalPlaces || {
    min: 1,
    max: 2,
  }) as { min: number; max: number } | number;
  const places =
    typeof placesSpec === "number"
      ? placesSpec
      : randInt(rng, placesSpec.min, placesSpec.max);
  const intR = mergeRange(
    gen.intPart || { min: 0, max: 99 },
    diff.intPart as { min?: number; max?: number },
  );
  const mk = () => {
    const ip = randInt(rng, intR.min, intR.max);
    const frac = randInt(rng, 0, Math.pow(10, places) - 1);
    return Number(`${ip}.${String(frac).padStart(places, "0")}`);
  };
  let a = mk();
  let b = mk();
  if (gen.op === "sub" && a < b) [a, b] = [b, a];
  const ans = gen.op === "add" ? a + b : a - b;
  const ansStr = stripTrailingZeros(ans.toFixed(places + 1));
  const stem = (opMeta.stemTemplate || "{a} ? {b} =")
    .replace("{a}", formatDec(a, places))
    .replace("{b}", formatDec(b, places));
  return fillQ(stem, ansStr, opMeta);
}

interface DecimalMulGen {
  kind: "decimal_mul";
  decimalOperand?: { places?: { min: number; max: number }; intPart?: { min: number; max: number } };
  intOperand?: { min: number; max: number };
}

function genDecimalMul(
  opMeta: OperationMeta,
  gen: DecimalMulGen,
  diff: Record<string, unknown>,
  rng: () => number,
): QuestionSnapshot | null {
  const places =
    typeof diff.places === "number"
      ? diff.places
      : randInt(
          rng,
          gen.decimalOperand?.places?.min || 1,
          gen.decimalOperand?.places?.max || 2,
        );
  const intR = mergeRange(
    gen.decimalOperand?.intPart || { min: 0, max: 99 },
    undefined,
  );
  const mulR = mergeRange(
    gen.intOperand || { min: 2, max: 9 },
    diff.intOperand as { min?: number; max?: number },
  );
  const ip = randInt(rng, intR.min, intR.max);
  const frac = randInt(rng, 1, Math.pow(10, places) - 1);
  const a = Number(`${ip}.${String(frac).padStart(places, "0")}`);
  const b = randInt(rng, mulR.min, mulR.max);
  const ans = a * b;
  const stem = (opMeta.stemTemplate || "{a} × {b} =")
    .replace("{a}", formatDec(a, places))
    .replace("{b}", String(b));
  return fillQ(stem, stripTrailingZeros(String(Number(ans.toFixed(places + 2)))), opMeta);
}

interface DecimalDivGen {
  kind: "decimal_div_exact";
  divisor?: { min: number; max: number };
  quotientPlaces?: number | { min: number; max: number };
}

function genDecimalDiv(
  opMeta: OperationMeta,
  gen: DecimalDivGen,
  diff: Record<string, unknown>,
  rng: () => number,
): QuestionSnapshot | null {
  const placesSpec = diff.quotientPlaces ?? gen.quotientPlaces ?? 1;
  const places =
    typeof placesSpec === "number"
      ? placesSpec
      : randInt(
          rng,
          (placesSpec as { min: number; max: number }).min,
          (placesSpec as { min: number; max: number }).max,
        );
  const divR = mergeRange(
    gen.divisor || { min: 2, max: 9 },
    diff.divisor as { min?: number; max?: number },
  );
  const divisor = randInt(rng, divR.min, divR.max);
  const qInt = randInt(rng, 1, 20);
  const qFrac = randInt(rng, 0, Math.pow(10, places) - 1);
  const quotient = Number(`${qInt}.${String(qFrac).padStart(places, "0")}`);
  const dividend = Number((quotient * divisor).toFixed(places + 1));
  const stem = (opMeta.stemTemplate || "{a} ÷ {b} =")
    .replace("{a}", stripTrailingZeros(String(dividend)))
    .replace("{b}", String(divisor));
  return fillQ(
    stem,
    stripTrailingZeros(quotient.toFixed(places)),
    opMeta,
  );
}

interface FracSameGen {
  kind: "fraction_same_den";
  op: "add" | "sub";
  denominator: { min: number; max: number };
}

function genFracSame(
  opMeta: OperationMeta,
  gen: FracSameGen,
  diff: Record<string, unknown>,
  rng: () => number,
): QuestionSnapshot | null {
  const dR = mergeRange(
    gen.denominator,
    diff.denominator as { min?: number; max?: number },
  );
  const d = randInt(rng, dR.min, dR.max);
  let a = randInt(rng, 1, d - 1);
  let b = randInt(rng, 1, d - 1);
  if (gen.op === "sub" && a < b) [a, b] = [b, a];
  if (gen.op === "add" && diff.resultProper && a + b >= d) {
    a = randInt(rng, 1, Math.max(1, Math.floor(d / 2) - 1));
    b = randInt(rng, 1, Math.max(1, d - a - 1));
  }
  const num = gen.op === "add" ? a + b : a - b;
  const simplified = simplifyFrac(num, d);
  const stem = (opMeta.stemTemplate || "{a}/{d} ? {b}/{d} =")
    .replace(/\{a\}/g, String(a))
    .replace(/\{b\}/g, String(b))
    .replace(/\{d\}/g, String(d));
  return fillQ(stem, `${simplified.n}/${simplified.d}`, opMeta);
}

interface FracDiffGen {
  kind: "fraction_diff_den";
  op: "add" | "sub";
  denominators: { min: number; max: number };
}

function genFracDiff(
  opMeta: OperationMeta,
  gen: FracDiffGen,
  diff: Record<string, unknown>,
  rng: () => number,
): QuestionSnapshot | null {
  const dR = mergeRange(
    gen.denominators,
    diff.denominators as { min?: number; max?: number },
  );
  let d1 = randInt(rng, dR.min, dR.max);
  let d2 = randInt(rng, dR.min, dR.max);
  if (diff.preferRelatedDenoms) {
    d2 = pick(rng, [d1, d1 * 2, Math.max(2, Math.floor(d1 / 2))].filter(
      (x) => x >= dR.min && x <= dR.max,
    ));
  }
  const a = randInt(rng, 1, d1 - 1);
  let b = randInt(rng, 1, d2 - 1);
  const l = lcm(d1, d2);
  let n1 = a * (l / d1);
  let n2 = b * (l / d2);
  if (gen.op === "sub" && n1 < n2) {
    // swap fractions
    [d1, d2] = [d2, d1];
    [n1, n2] = [n2, n1];
    b = a; // only for stem we'll use swapped values carefully
  }
  // regenerate cleanly
  const den1 = d1;
  const den2 = d2;
  const num1 = randInt(rng, 1, den1 - 1);
  let num2 = randInt(rng, 1, den2 - 1);
  const L = lcm(den1, den2);
  let N1 = num1 * (L / den1);
  let N2 = num2 * (L / den2);
  if (gen.op === "sub" && N1 < N2) {
    num2 = Math.max(1, Math.min(den2 - 1, Math.floor((N1 * den2) / L) - 1));
    N2 = num2 * (L / den2);
    if (N1 < N2) return null;
  }
  const resN = gen.op === "add" ? N1 + N2 : N1 - N2;
  const simp = simplifyFrac(resN, L);
  const stem = (opMeta.stemTemplate || "{a}/{d1} ? {b}/{d2} =")
    .replace("{a}", String(num1))
    .replace("{d1}", String(den1))
    .replace("{b}", String(num2))
    .replace("{d2}", String(den2));
  return fillQ(stem, `${simp.n}/${simp.d}`, opMeta);
}

interface MixedGen {
  kind: "mixed_two_step";
  patterns: string[];
  operandRange: { min: number; max: number };
}

function genMixed(
  opMeta: OperationMeta,
  gen: MixedGen,
  diff: Record<string, unknown>,
  rng: () => number,
): QuestionSnapshot | null {
  const patterns = (diff.patterns as string[]) || gen.patterns;
  const range = mergeRange(
    gen.operandRange,
    diff.operandRange as { min?: number; max?: number },
  );
  const pattern = pick(rng, patterns);

  for (let attempt = 0; attempt < 40; attempt++) {
    const a = randInt(rng, range.min, range.max);
    const b = randInt(rng, range.min, range.max);
    const c = randInt(rng, range.min, range.max);
    let ans: number | null = null;
    let stem = pattern;

    try {
      switch (pattern) {
        case "a + b × c":
          ans = a + b * c;
          stem = `${a} + ${b} × ${c} =`;
          break;
        case "a × b + c":
          ans = a * b + c;
          stem = `${a} × ${b} + ${c} =`;
          break;
        case "a − b × c":
          ans = a - b * c;
          if (ans < 0) continue;
          stem = `${a} − ${b} × ${c} =`;
          break;
        case "a × b − c":
          ans = a * b - c;
          if (ans < 0) continue;
          stem = `${a} × ${b} − ${c} =`;
          break;
        case "(a + b) × c":
          ans = (a + b) * c;
          stem = `(${a} + ${b}) × ${c} =`;
          break;
        case "a × (b + c)":
          ans = a * (b + c);
          stem = `${a} × (${b} + ${c}) =`;
          break;
        case "a + b − c":
          ans = a + b - c;
          if (ans < 0) continue;
          stem = `${a} + ${b} − ${c} =`;
          break;
        case "a × b ÷ c": {
          // ensure divisible
          const prod = a * b;
          if (c === 0 || prod % c !== 0) continue;
          ans = prod / c;
          stem = `${a} × ${b} ÷ ${c} =`;
          break;
        }
        default:
          continue;
      }
    } catch {
      continue;
    }
    if (ans == null || !Number.isInteger(ans) || ans < 0) continue;
    return fillQ(stem, String(ans), opMeta);
  }
  return null;
}

interface UnitGen {
  kind: "unit_convert";
  dimension: string;
  units: string[];
  factorsToMm?: Record<string, number>;
  factorsToSec?: Record<string, number>;
  factorsToCm2?: Record<string, number>;
  valueRange?: { min: number; max: number };
  byDifficulty?: Record<string, unknown>;
}

function genUnit(
  opMeta: OperationMeta,
  gen: UnitGen,
  diff: Record<string, unknown>,
  rng: () => number,
): QuestionSnapshot | null {
  const pairs =
    (diff.pairs as [string, string][]) ||
    combinations(gen.units).map((p) => p as [string, string]);
  const [from, to] = pick(rng, pairs);
  const vR = mergeRange(
    gen.valueRange || { min: 1, max: 20 },
    diff.valueRange as { min?: number; max?: number },
  );
  const n = randInt(rng, vR.min, vR.max);
  let factors: Record<string, number> = {};
  if (gen.factorsToMm) factors = gen.factorsToMm;
  else if (gen.factorsToSec) factors = gen.factorsToSec;
  else if (gen.factorsToCm2) factors = gen.factorsToCm2;
  else return null;

  const base = n * factors[from];
  const result = base / factors[to];
  if (!Number.isFinite(result)) return null;
  // prefer integer results when possible
  if (!Number.isInteger(result) && rng() > 0.3) {
    // try another value
  }
  const labels: Record<string, string> = {
    mm: "mm",
    cm: "cm",
    m: "m",
    h: "时",
    min: "分",
    s: "秒",
    cm2: "cm²",
    m2: "m²",
  };
  const stem = `${n} ${labels[from] || from} = ____ ${labels[to] || to}`;
  const ans = stripTrailingZeros(String(result));
  return fillQ(stem, ans, opMeta);
}

// —— utils ——

function fillQ(
  stem: string,
  answer: string,
  opMeta: OperationMeta,
): QuestionSnapshot {
  return {
    type: "fill_blank",
    stem,
    options: null,
    answer,
    explanation: null,
    knowledgeNodeId: opMeta.relatedKnowledgeIds?.[0] || null,
    source: "generated",
  };
}

function mergeRange(
  base: { min: number; max: number },
  over?: { min?: number; max?: number },
): { min: number; max: number } {
  return {
    min: over?.min ?? base.min,
    max: over?.max ?? base.max,
  };
}

function hasConstraint(
  gen: { constraints?: Array<{ type: string }> },
  type: string,
): boolean {
  return !!gen.constraints?.some((c) => c.type === type);
}

function hasCarry(a: number, b: number): boolean {
  let x = a;
  let y = b;
  while (x > 0 || y > 0) {
    if ((x % 10) + (y % 10) >= 10) return true;
    x = Math.floor(x / 10);
    y = Math.floor(y / 10);
  }
  return false;
}

function hasBorrow(a: number, b: number): boolean {
  let x = a;
  let y = b;
  while (x > 0 || y > 0) {
    if (x % 10 < y % 10) return true;
    x = Math.floor(x / 10);
    y = Math.floor(y / 10);
  }
  return false;
}

function gcd(a: number, b: number): number {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b) {
    const t = b;
    b = a % b;
    a = t;
  }
  return a || 1;
}

function lcm(a: number, b: number): number {
  return Math.abs(a * b) / gcd(a, b);
}

function simplifyFrac(n: number, d: number): { n: number; d: number } {
  if (n === 0) return { n: 0, d: 1 };
  const g = gcd(n, d);
  return { n: n / g, d: d / g };
}

function stripTrailingZeros(s: string): string {
  if (!s.includes(".")) return s;
  return s.replace(/\.?0+$/, "");
}

function formatDec(n: number, places: number): string {
  return stripTrailingZeros(n.toFixed(places));
}

function combinations(units: string[]): string[][] {
  const out: string[][] = [];
  for (const a of units) {
    for (const b of units) {
      if (a !== b) out.push([a, b]);
    }
  }
  return out;
}

// Export for table mul/div special case using binary when operands are 1-9
// Fix table operations - they use binary_op with mul and 1-9 which is fine.

// div_table uses div_exact with quotient and divisor 1-9 - good.
