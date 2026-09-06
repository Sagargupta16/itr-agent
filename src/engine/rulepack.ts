import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface Slab {
  upTo: number | null;
  rate: number;
}

export interface Rebate87A {
  incomeThreshold: number;
  maxRebate: number;
  marginalRelief: boolean;
  /** The 5L (old) threshold tests TOTAL income; the 12L (new) tests normal only. */
  thresholdBasis?: "totalIncome" | "normalIncome";
  /** Old regime: 87A can offset 111A STCG tax (s.112A(6) bars 112A in both). */
  allowAgainst111A?: boolean;
  /** s.112A(6) bars the rebate against 112A tax in both regimes; kept explicit
   * because the engine reads it rather than hardcoding the bar. */
  allowAgainst112A?: boolean;
}

export interface Interest234CConfig {
  installments: {
    due: string;
    cumulativePct: number;
    safeHarborPct: number | null;
    months: number;
  }[];
  presumptive: { due: string; pct: number; months: number };
  minLiability: number;
}

export interface InterestConfig {
  ratePerMonth: number;
  /** Rule 119A: any part of a month counts as a full month. */
  partMonthIsFullMonth: boolean;
  s234A: { ratePerMonth: number; fromDate: string };
  s234B: { trigger: string; fromDate: string };
  s234C: Interest234CConfig;
}

export interface HraConfig {
  metroCities: string[];
  metroPct: number;
  nonMetroPct: number;
  rentExcessOfSalaryPct: number;
  regimes: string[];
  warnings: {
    landlordPanRentPerYear: number;
    receiptWaiverHraPerMonth: number;
  };
}

export interface Deduction80GGConfig {
  capPerYear: number;
  /** The statutory limb is Rs 5,000 PER MONTH, so a part year caps lower. */
  capPerMonth: number;
  pctOfATI: number;
  rentExcessOfATIPct: number;
  regimes: string[];
}

export interface ReconcileConfig {
  toleranceRupees: { pass: number; warn: number; high: number };
}

export interface RulePack {
  fy: string;
  ay: string;
  rulePackVersion: string;
  sources: string[];
  newRegime: {
    slabs: Slab[];
    standardDeduction: number;
    rebate87A: Rebate87A;
    surchargeCapRate: number;
  };
  oldRegime: {
    slabs: Slab[];
    /** Senior (60-79): the higher basic exemption WIDENS the nil band. */
    slabsSenior: Slab[];
    /** Super senior (80+): the nil band widens again. */
    slabsSuperSenior: Slab[];
    standardDeduction: number;
    rebate87A: Rebate87A;
    deductionCaps: Record<string, number>;
    hraMetros: string[];
  };
  capitalGains: {
    stcg111A: number;
    ltcg112A: number;
    ltcg112AExemption: number;
    grandfatheringDate: string;
    rateChangeBoundary: string;
    debtSlabAcquisitionBoundary: string;
    /** s.111A / s.112A(2) provisos: unexhausted basic exemption reduces gains. */
    basicExemptionSetOff: { against111A: boolean; against112A: boolean };
  };
  surcharge: {
    slabs: { above: number; rate: number }[];
    capitalGainsAndDividendCap: number;
    marginalRelief: boolean;
    /** First Schedule: the 25%/37% bands exclude 111A/112/112A/dividend income. */
    enhancedBandsExcludeSpecialRateIncome: boolean;
    /** Rates at or above this are the "enhanced" bands subject to that exclusion. */
    enhancedBandRateFloor: number;
  };
  cess: number;
  advanceTax: {
    threshold: number;
    installments: { dueDate: string; cumulativePct: number }[];
    interest234C_ratePerMonth: number;
    interest234B_ratePerMonth: number;
    section234B_paidThresholdPct: number;
  };
  deadlines: Record<string, string>;
  lateFee234F: { default: number; incomeUpTo5L: number };
  /** ITR-1/ITR-4 eligibility ceilings (statutory, so they live here not in code). */
  itrEligibility: {
    simpleFormIncomeCap: number;
    ltcg112ASimpleFormCap: number;
    agriIncomeCap: number;
  };
  rounding: {
    /** s.288A: total income rounded to the nearest multiple of this. */
    income288A: number;
    /** s.288B: tax payable/refund rounded to the nearest multiple of this. */
    taxPayable288B: number;
    /** Rule 119A: interest principal floored to a multiple of this. */
    interestBase119A: number;
  };
  // Required, not optional: an optional config forces a hardcoded fallback at
  // every read site, and "every tax constant lives in the rule pack" then stops
  // being true. A pack missing any of these is a broken pack, and validatePack
  // says so at load time instead of silently substituting last year's rate.
  interest: InterestConfig;
  hra: HraConfig;
  deduction80GG: Deduction80GGConfig;
  reconcile: ReconcileConfig;
  tdsSectionToHead: Record<string, string>;
}

// Bundled (dist/index.js) sits one level below the repo root; source
// (src/engine/rulepack.ts) sits two levels below. Probe both.
function resolveDataDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    join(here, "..", "data"),
    join(here, "..", "..", "data"),
  ]) {
    if (existsSync(join(candidate, "fy2025-26.json"))) return candidate;
  }
  throw new Error("data/ directory with rule packs not found");
}

const DATA_DIR = resolveDataDir();

const cache = new Map<string, RulePack>();

/** Load a fiscal-year rule pack (e.g. "2025-26"). Packs live in data/ and are
 * the single source of truth for every number the engine uses.
 *
 * `fy` is matched against availableYears() before it ever reaches the
 * filesystem: it is caller-supplied on every tool, and interpolating it into a
 * path would otherwise let "x/../../package" read arbitrary JSON. */
export function loadRulePack(fy: string): RulePack {
  const cached = cache.get(fy);
  if (cached) return cached;
  if (!availableYears().includes(fy)) {
    throw new Error(
      `no rule pack for FY ${fy}. Available: ${availableYears().join(", ")}`,
    );
  }
  const path = join(DATA_DIR, `fy${fy}.json`);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error(
      `no rule pack for FY ${fy}. Available: ${availableYears().join(", ")}`,
    );
  }
  const pack = JSON.parse(raw) as RulePack;
  validatePack(fy, pack);
  cache.set(fy, pack);
  return pack;
}

/** Fail loudly on a pack that is missing a section the engine reads.
 * Without this the types claim the field exists, `pack.interest.ratePerMonth`
 * throws a bare TypeError deep in a tool call, and the user sees a stack trace
 * instead of "the FY 2026-27 pack is missing `hra`". */
function validatePack(fy: string, pack: RulePack): void {
  const required = [
    "newRegime",
    "oldRegime",
    "capitalGains",
    "surcharge",
    "advanceTax",
    "deadlines",
    "lateFee234F",
    "itrEligibility",
    "rounding",
    "interest",
    "hra",
    "deduction80GG",
    "reconcile",
    "tdsSectionToHead",
  ] as const;

  const missing = required.filter((key) => pack[key] == null);
  if (typeof pack.cess !== "number") missing.push("cess" as never);
  if (missing.length > 0) {
    throw new Error(
      `rule pack fy${fy}.json is missing required section(s): ${missing.join(", ")}. Every tax constant must live in the pack -- see data/fy2025-26.json for the full shape.`,
    );
  }

  // The senior slab sets were added in pack 1.2.0. An older pack silently
  // falling back to the below-60 slabs would under-tax every senior return.
  if (!pack.oldRegime.slabsSenior || !pack.oldRegime.slabsSuperSenior) {
    throw new Error(
      `rule pack fy${fy}.json lacks oldRegime.slabsSenior / slabsSuperSenior (added in pack 1.2.0). Senior basic exemption is a slab set, not an income deduction.`,
    );
  }
}

export function availableYears(): string[] {
  return ["2025-26"];
}

export const DEFAULT_FY = "2025-26";
