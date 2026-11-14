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
  /** Both regimes test TOTAL income (s.87A main body and first proviso
   * clauses (a)/(b) all say "total income"). `normalIncome` is kept as a
   * value so a pack can encode the contrary reading explicitly; pack 1.3.0
   * shipped the new regime on it, which over-rebated anyone whose gains pushed
   * total income past the threshold. */
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
  /** Rule 119A(b): any part of a month counts as a full month. Read by the
   * date-to-months conversion in dates.ts. */
  partMonthIsFullMonth: boolean;
  /** 234A runs from the day after the s.139(1) due date (`dueDatePlus1`). */
  s234A: { ratePerMonth: number; fromDate: "dueDatePlus1" };
  /** 234B runs from 1 April of the assessment year (`AY-04-01`). */
  s234B: { trigger: string; fromDate: "AY-04-01" };
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

/** A fee with a lower figure for small incomes (s.234F, s.234-I). */
export interface LowIncomeFee {
  default: number;
  incomeUpTo5L: number;
  /** Total income at or below this pays `incomeUpTo5L`. */
  incomeThreshold: number;
}

export interface ReconcileConfig {
  toleranceRupees: { pass: number; warn: number; high: number };
}

/** The statute a pack encodes. The engine's notes cite Income-tax Act 1961
 * section numbers; a pack under the Income-tax Act 2025 (tax year 2026-27 on)
 * maps those labels to its own, names the renumbered forms, and carries a note
 * the server adds to every result computed with it. */
export interface StatuteConfig {
  act: string;
  /** 1961 Act label -> this Act's label, for the sections the engine cites.
   * Empty for a 1961 Act pack. */
  sectionMap: Record<string, string>;
  /** Added to the disclaimers of every result computed with this pack; null
   * when the engine's citations already match the statute. */
  note: string | null;
  forms: {
    /** TDS certificate for salary: Form 16, Form No. 130 under the 2025 Rules. */
    salaryCertificate: string;
    /** Employee's claim declaration (landlord PAN for HRA): Form 12BB. */
    claimDeclaration: string;
    /** The 80GG rent declaration: Form 10BA. */
    rentDeclaration80GG: string;
  };
}

export interface RulePack {
  fy: string;
  ay: string;
  rulePackVersion: string;
  sources: string[];
  statute: StatuteConfig;
  newRegime: {
    slabs: Slab[];
    standardDeduction: number;
    rebate87A: Rebate87A;
    /** s.80CCD(2): the one Chapter VI-A deduction 115BAC(2) keeps. 14% of
     * salary for every employer where income is chargeable under 115BAC(1A). */
    employerNps80CCD2: {
      pctOfSalary: number;
    };
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
    /** Chapter VI-A caps plus the two house-property limits the engine reads:
     * `24b_selfOccupied` (s.24(b) second proviso) and `housePropertyLossSetOff`
     * (s.71(3A)). validatePack requires both. */
    deductionCaps: Record<string, number>;
    employerNps80CCD2: {
      pctOfSalaryPrivate: number;
      pctOfSalaryGovernment: number;
    };
  };
  capitalGains: {
    stcg111A: number;
    ltcg112A: number;
    ltcg112AExemption: number;
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
    section234B_paidThresholdPct: number;
  };
  deadlines: Record<string, string>;
  /** Statutory basis for each `deadlines` key, so tools can say WHY a date is
   * what it is instead of asserting an uncited calendar date. */
  deadlineCitations: Record<string, string>;
  /** s.234F late fee; the lower figure applies where total income does not
   * exceed `incomeThreshold`. */
  lateFee234F: LowIncomeFee;
  /** s.234-I (Finance Act 2026): fee on a revised return filed after
   * `deadlines.revisedWithoutFee234I`, banded like s.234F. */
  fee234I: LowIncomeFee;
  /** ITR-1/ITR-4 eligibility ceilings (statutory, so they live here not in code). */
  itrEligibility: {
    simpleFormIncomeCap: number;
    ltcg112ASimpleFormCap: number;
    agriIncomeCap: number;
    /** ITR-1/ITR-4 admit up to this many house properties (2 from AY 2026-27). */
    maxHouseProperties: number;
    /** Schedule AL is mandatory in ITR-2/ITR-3 above this total income. */
    scheduleALIncomeThreshold: number;
    presumptive: {
      turnoverCap44AD: number;
      /** 44AD ceiling where cash receipts are at most 5% of turnover. */
      turnoverCap44ADDigital: number;
      receiptsCap44ADA: number;
      receiptsCap44ADADigital: number;
      maxVehicles44AE: number;
      /** s.44AD(1): deemed profit as a share of turnover (cash and other). */
      deemedProfit44AD: number;
      /** s.44AD(1) proviso: the lower rate on turnover received digitally. */
      deemedProfit44ADDigital: number;
      /** s.44ADA(1): deemed profit as a share of gross receipts. */
      deemedProfit44ADA: number;
      /** s.44AE(2)(a): rupees per ton of gross vehicle weight per month (or
       * part) for a heavy goods vehicle. */
      deemedProfit44AEHeavyPerTonPerMonth: number;
      /** s.44AE(2)(b): rupees per month (or part) for any other goods carriage. */
      deemedProfit44AEOtherPerVehiclePerMonth: number;
      /** s.44AD(1) / s.44ADA(1) provisos: the higher ceilings apply where cash
       * receipts are at most this share of the total. */
      cashShareLimit: number;
      /** s.44AE Explanation: a heavy goods vehicle is one whose gross vehicle
       * weight EXCEEDS this many tons (12,000 kg). */
      heavyVehicleAboveGrossWeightTons: number;
    };
  };
  /** Income from house property (1961 Act ss.23 and 24). The self-occupied
   * interest cap itself is `oldRegime.deductionCaps.24b_selfOccupied`. */
  houseProperty: {
    /** s.24(a): standard deduction as a share of net annual value. */
    standardDeductionPct: number;
    /** s.23(2): how many houses may be self-occupied at nil annual value. */
    maxSelfOccupied: number;
    /** s.24(b) first proviso: the self-occupied cap where the loan predates
     * 1-Apr-1999, was not for acquiring or building the house, or the house was
     * not finished within five years (the second proviso raises it to
     * `deductionCaps.24b_selfOccupied` otherwise). */
    selfOccupiedInterestCapOlder: number;
    /** Explanation to s.24(b): pre-construction interest is allowed in this
     * many equal yearly instalments from the year of completion. */
    preConstructionInstallments: number;
  };
  /** How many years after the year of loss each kind may be carried forward:
   * s.71B (house property), s.72(3) (business), s.73(4) (speculative) and
   * s.74(1) (capital). */
  lossCarryForward: {
    housePropertyYears: number;
    businessYears: number;
    speculativeYears: number;
    capitalYears: number;
  };
  /** How long a deductor can still file a TDS correction statement. */
  tdsCorrectionWindow: { description: string };
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

/** The package version, read from package.json next to data/. The server used
 * to hardcode it and drifted (0.3.0 while the package was 0.4.0). */
export function packageVersion(): string {
  try {
    const raw = readFileSync(join(DATA_DIR, "..", "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    if (typeof parsed.version === "string") return parsed.version;
  } catch {
    // fall through
  }
  return "0.0.0";
}

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
    "deadlineCitations",
    "lateFee234F",
    "itrEligibility",
    "tdsCorrectionWindow",
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

  // Pack 1.4.0 additions. Each one replaced a figure that was either hardcoded
  // in itr-form.ts or missing altogether, so an older pack must not load.
  if (
    !pack.newRegime.employerNps80CCD2 ||
    !pack.oldRegime.employerNps80CCD2 ||
    !pack.itrEligibility.presumptive ||
    typeof pack.itrEligibility.maxHouseProperties !== "number" ||
    typeof pack.itrEligibility.scheduleALIncomeThreshold !== "number"
  ) {
    throw new Error(
      `rule pack fy${fy}.json predates pack 1.4.0: needs employerNps80CCD2 on both regimes and itrEligibility.{maxHouseProperties, scheduleALIncomeThreshold, presumptive}.`,
    );
  }

  // Pack 1.5.0: the engine reads the s.24(b) self-occupied cap and the Rule 119A
  // part-month flag, and the checklist quotes the presumptive deemed-profit
  // rates. A pack without them would fall back to a figure written in code.
  const caps = pack.oldRegime.deductionCaps ?? {};
  const p = pack.itrEligibility.presumptive;
  if (
    typeof caps["24b_selfOccupied"] !== "number" ||
    typeof caps.housePropertyLossSetOff !== "number" ||
    typeof pack.interest.partMonthIsFullMonth !== "boolean" ||
    typeof p.deemedProfit44AD !== "number" ||
    typeof p.deemedProfit44ADDigital !== "number" ||
    typeof p.deemedProfit44ADA !== "number"
  ) {
    throw new Error(
      `rule pack fy${fy}.json predates pack 1.5.0: needs oldRegime.deductionCaps.{24b_selfOccupied, housePropertyLossSetOff}, interest.partMonthIsFullMonth and itrEligibility.presumptive.{deemedProfit44AD, deemedProfit44ADDigital, deemedProfit44ADA}.`,
    );
  }

  // Pack 1.6.0: house-property, 44AE and loss carry-forward figures for the
  // compute_house_property, compute_presumptive_income and compute_loss_setoff
  // tools.
  const hp = pack.houseProperty;
  const cf = pack.lossCarryForward;
  if (
    !hp ||
    !cf ||
    typeof p.deemedProfit44AEHeavyPerTonPerMonth !== "number" ||
    typeof p.deemedProfit44AEOtherPerVehiclePerMonth !== "number" ||
    typeof p.cashShareLimit !== "number" ||
    typeof p.heavyVehicleAboveGrossWeightTons !== "number" ||
    typeof pack.lateFee234F.incomeThreshold !== "number" ||
    !pack.fee234I ||
    typeof pack.statute?.act !== "string" ||
    !pack.statute.sectionMap ||
    !pack.statute.forms ||
    [
      hp.standardDeductionPct,
      hp.maxSelfOccupied,
      hp.selfOccupiedInterestCapOlder,
      hp.preConstructionInstallments,
      cf.housePropertyYears,
      cf.businessYears,
      cf.speculativeYears,
      cf.capitalYears,
      pack.fee234I?.default,
      pack.fee234I?.incomeUpTo5L,
      pack.fee234I?.incomeThreshold,
    ].some((v) => typeof v !== "number")
  ) {
    throw new Error(
      `rule pack fy${fy}.json predates pack 1.6.0: needs houseProperty.{standardDeductionPct, maxSelfOccupied, selfOccupiedInterestCapOlder, preConstructionInstallments}, lossCarryForward.{housePropertyYears, businessYears, speculativeYears, capitalYears}, lateFee234F.incomeThreshold, fee234I.{default, incomeUpTo5L, incomeThreshold}, statute.{act, sectionMap, note, forms} and itrEligibility.presumptive.{deemedProfit44AEHeavyPerTonPerMonth, deemedProfit44AEOtherPerVehiclePerMonth, cashShareLimit, heavyVehicleAboveGrossWeightTons}.`,
    );
  }
}

export function availableYears(): string[] {
  return ["2025-26", "2026-27"];
}

export const DEFAULT_FY = "2025-26";
