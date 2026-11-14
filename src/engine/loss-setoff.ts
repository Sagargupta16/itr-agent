import type { Regime } from "./compute.js";
import type { RulePack } from "./rulepack.js";

/** Set-off and carry forward of losses under Chapter VI of the 1961 Act, for
 * the FY of the rule pack:
 * - s.70: within a head. A short-term capital loss goes against any capital
 *   gain, a long-term one against long-term gains only; a business loss may
 *   absorb speculative profit, never the reverse (s.73(1)).
 * - s.71: across heads. House property up to the s.71(3A) limit, and not at
 *   all under the new regime (s.115BAC(2)(ii)(b)); business against anything
 *   but salary (s.71(2A)); capital and speculative losses never (s.71(3),
 *   s.73(1)).
 * - ss.71B, 72, 73 and 74: brought-forward losses, oldest first, each kind
 *   only against the income its section names, within the pack's periods.
 * - s.80: a return furnished after the s.139(1) due date carries none of this
 *   year's business, speculative or capital losses forward (s.71B excepted).
 * Pure function over the rule pack: every period and limit is read from
 * `pack`, and the model never adds anything up. */

export type LossKind =
  | "houseProperty"
  | "business"
  | "speculative"
  | "shortTermCapital"
  | "longTermCapital";

/** What a loss can be set off against. Capital gains are split by the rate
 * they bear, because which gains a loss absorbs is the assessee's choice and
 * changes the tax. */
export type IncomeBucket =
  | "salary"
  | "houseProperty"
  | "business"
  | "speculative"
  | "otherSources"
  | "stcg111A"
  | "stcgOther"
  | "ltcg112A"
  | "ltcgOther";

export type LossTotals = Record<LossKind, number>;

export interface BroughtForwardLoss {
  kind: LossKind;
  /** FY the loss arose in, "YYYY-YY". A FY 2021-22 loss is the AY 2022-23 row
   * of Schedule CFL. Must be earlier than the pack's FY. */
  originFy: string;
  /** What is still unabsorbed at the start of this FY, as a positive number. */
  amount: number;
}

/** Gains and losses of the year, kept apart. Enter them gross: each gain
 * bucket is the sum of gains on assets of that kind, and every loss goes in
 * `shortTermLoss` / `longTermLoss`. Netting a loss into one bucket yourself
 * fixes the order of set-off before this engine sees it. */
export interface CapitalGainsInput {
  /** s.111A STCG (listed equity and equity funds, STT paid). */
  stcg111A?: number;
  /** STCG taxed at slab rates (s.50AA debt funds, unlisted shares, property
   * held short term). */
  stcgOther?: number;
  /** s.112A LTCG BEFORE the exemption (compute_tax applies it). */
  ltcg112A?: number;
  /** LTCG under s.112 (property, unlisted shares, other long-term assets). */
  ltcgOther?: number;
  /** Short-term capital losses of the year, as a positive number. */
  shortTermLoss?: number;
  /** Long-term capital losses of the year, as a positive number. */
  longTermLoss?: number;
}

export interface LossSetoffInput {
  regime: Regime;
  /** s.80 with s.139(3): the return for THIS FY is furnished by the s.139(1)
   * due date. If not, this year's business, speculative and capital losses are
   * still set off this year but are not carried forward. */
  filedByDueDate: boolean;
  /** Gross salary before the standard deduction, as compute_tax takes it. */
  salaryIncome?: number;
  /** Income under the head house property, all properties together (s.70(1)
   * within the head): positive income, or a NEGATIVE loss. */
  houseProperty?: number;
  /** Which kind of property a house-property LOSS comes from, as compute_tax
   * takes it. A self-occupied loss is its s.24(b) interest, deductible up to
   * the second-proviso cap in the old regime and not at all in the new one
   * (s.115BAC(2)(i)); the rest is no loss. Defaults to `letOut` with a
   * warning. */
  housePropertyType?: "selfOccupied" | "letOut";
  /** Business or profession other than speculation (F&O included), net for
   * the year: profit, or a NEGATIVE loss. */
  business?: number;
  /** Speculative business (intraday equity), net for the year: profit, or a
   * NEGATIVE loss. */
  speculative?: number;
  /** Income from other sources at normal rates (interest, dividend, ...). */
  otherSources?: number;
  capitalGains?: CapitalGainsInput;
  broughtForward?: BroughtForwardLoss[];
}

export type SetoffStage = "intraHead" | "interHead" | "broughtForward";

export interface SetoffStep {
  step: number;
  /** intraHead = s.70 (and s.73(1)), interHead = s.71, broughtForward =
   * ss.71B/72/73/74. The stages run in that order. */
  stage: SetoffStage;
  section: string;
  loss: LossKind;
  /** FY the loss arose in: the pack's FY for this year's losses. */
  originFy: string;
  against: IncomeBucket;
  amount: number;
}

export interface IncomeByHead extends Record<IncomeBucket, number> {
  /** Every bucket added up: gross total income before Chapter VI-A. */
  grossTotalIncome: number;
}

export interface CarryForwardLot {
  kind: LossKind;
  originFy: string;
  originAy: string;
  amount: number;
  /** The last FY whose income this loss may still be set off against. */
  lastUsableFy: string;
  lastUsableAy: string;
  section: string;
}

export interface ExpiredLot extends CarryForwardLot {
  /** beforeThisYear: its period ended before this FY, so none of it was used.
   * endOfThisYear: this FY was its last, and what this year's income did not
   * absorb lapses. */
  when: "beforeThisYear" | "endOfThisYear";
}

export interface ForfeitedLoss {
  kind: LossKind;
  amount: number;
  section: string;
}

export interface CylaRow {
  head: IncomeBucket;
  /** Income of the year after s.70 set-off within the head. */
  income: number;
  housePropertyLossSetOff: number;
  businessLossSetOff: number;
  /** Income left after this year's losses. */
  remaining: number;
}

export interface BflaRow extends LossTotals {
  head: IncomeBucket;
  /** Income left after Schedule CYLA. */
  income: number;
  /** Income left after brought-forward losses. */
  remaining: number;
}

export interface CflRow extends LossTotals {
  fy: string;
  ay: string;
}

export interface LossSchedules {
  cyla: {
    rows: CylaRow[];
    totalSetOff: { houseProperty: number; business: number };
    /** This year's losses left once CYLA is done, before s.80. */
    lossRemaining: LossTotals;
  };
  bfla: { rows: BflaRow[]; totalSetOff: LossTotals };
  cfl: {
    /** Unexpired brought-forward losses at the start of the year, by origin. */
    broughtForward: CflRow[];
    totalBroughtForward: LossTotals;
    adjustedInBfla: LossTotals;
    /** Brought-forward losses whose last year this was and that are left. */
    lapsedAtYearEnd: LossTotals;
    /** This year's losses carried forward (after s.80). */
    currentYear: CflRow;
    /** totalBroughtForward - adjustedInBfla - lapsedAtYearEnd + currentYear. */
    carriedToFuture: LossTotals;
  };
}

/** Post-set-off figures in compute_tax's own fields, for the same regime. */
export interface ForComputeTax {
  regime: Regime;
  /** Gross, untouched: compute_tax applies the standard deduction, and its
   * s.80CCD(2) cap reads this figure. */
  salaryIncome: number;
  /** Other sources, house-property income, business and speculative profit
   * and slab-rate STCG, all after set-off. */
  otherIncome: number;
  stcg111A: number;
  /** Still before the 112A exemption: compute_tax applies it. */
  ltcg112A: number;
  /** The house-property loss set off against slab-rate income, already inside
   * the s.24(b) and s.71(3A) limits. */
  housePropertyLoss?: number;
  housePropertyType?: "selfOccupied" | "letOut";
}

export interface LossSetoffResult {
  fy: string;
  ay: string;
  regime: Regime;
  rulePackVersion: string;
  filedByDueDate: boolean;
  incomeBeforeSetoff: IncomeByHead;
  /** This year's losses as entered, the house-property one after s.24(b). */
  currentYearLosses: LossTotals;
  /** Self-occupied interest that is no loss at all (above the s.24(b) cap, or
   * all of it under the new regime). Never set off or carried forward. */
  housePropertyLossDisallowed: number;
  steps: SetoffStep[];
  incomeAfterSetoff: IncomeByHead;
  carryForward: CarryForwardLot[];
  carryForwardTotals: LossTotals;
  expired: ExpiredLot[];
  /** s.80: this year's losses a late return does not carry forward. */
  forfeited: ForfeitedLoss[];
  schedules: LossSchedules;
  forComputeTax: ForComputeTax;
  /** Income left after set-off that compute_tax has no field for. */
  outsideComputeTax: { ltcgOther: number };
  notes: string[];
  warnings: string[];
  disclaimers: string[];
}

const DISCLAIMERS = [
  "Not tax advice. Check Schedules CYLA, BFLA and CFL against the official utility before filing.",
  "Assumes a resident individual. Not modelled: unabsorbed depreciation (s.32(2)), specified-business losses (s.73A), racehorse losses (s.74A) and losses under the head other sources.",
];

const LOSS_KINDS: LossKind[] = [
  "houseProperty",
  "business",
  "speculative",
  "shortTermCapital",
  "longTermCapital",
];

/** Row order of Schedules CYLA and BFLA. */
const SCHEDULE_ORDER: IncomeBucket[] = [
  "salary",
  "houseProperty",
  "business",
  "speculative",
  "stcg111A",
  "stcgOther",
  "ltcg112A",
  "ltcgOther",
  "otherSources",
];

// Among gains the assessee chooses (s.70, s.71(2), s.74). Slab-rate and s.111A
// gains go first and s.112A last, so the 112A gains keep their exemption for
// as long as the losses allow.
const STCG: IncomeBucket[] = ["stcgOther", "stcg111A"];
const LTCG: IncomeBucket[] = ["ltcgOther", "ltcg112A"];
const GAINS = new Set<IncomeBucket>([...STCG, ...LTCG]);

/** Taxed at slab rates: what compute_tax's salary and otherIncome carry. */
const SLAB_RATE = new Set<IncomeBucket>([
  "salary",
  "houseProperty",
  "business",
  "speculative",
  "otherSources",
  "stcgOther",
]);

// Salary first because a business loss never can use it (s.71(2A)); other
// sources before business income, which brought-forward business losses need.
const HOUSE_PROPERTY_LOSS_ORDER: IncomeBucket[] = [
  "salary",
  "otherSources",
  "business",
  "speculative",
  ...STCG,
  ...LTCG,
];
const BUSINESS_LOSS_ORDER: IncomeBucket[] = [
  "otherSources",
  "houseProperty",
  ...STCG,
  ...LTCG,
];

const INTRA_HEAD_SECTION: Record<LossKind, string> = {
  houseProperty: "s.70(1)",
  business: "s.70(1)",
  speculative: "s.73(1)",
  shortTermCapital: "s.70(2)",
  longTermCapital: "s.70(3)",
};

const BROUGHT_FORWARD_SECTION: Record<LossKind, string> = {
  houseProperty: "s.71B",
  business: "s.72(1)",
  speculative: "s.73(2)",
  shortTermCapital: "s.74(1)(a)",
  longTermCapital: "s.74(1)(b)",
};

/** Where each kind's carry-forward period is set. */
const CARRY_SECTION: Record<LossKind, string> = {
  houseProperty: "s.71B",
  business: "s.72(3)",
  speculative: "s.73(4)",
  shortTermCapital: "s.74(1)(d)",
  longTermCapital: "s.74(1)(d)",
};

const KIND_LABEL: Record<LossKind, string> = {
  houseProperty: "house-property",
  business: "business",
  speculative: "speculative",
  shortTermCapital: "short-term capital",
  longTermCapital: "long-term capital",
};

interface Lot {
  kind: LossKind;
  originFy: string;
  originStart: number;
  /** Start year of the last FY the loss may be used in. */
  lastUsableStart: number;
  opening: number;
  remaining: number;
}

interface Ledger {
  income: Record<IncomeBucket, number>;
  steps: SetoffStep[];
}

function rs(n: number): string {
  return `Rs ${Math.round(n).toLocaleString("en-IN")}`;
}

/** Start year of a "YYYY-YY" FY, or undefined when the label is malformed. */
function fyStart(fy: string): number | undefined {
  const m = /^(\d{4})-(\d{2})$/.exec(fy);
  if (!m) return undefined;
  const start = Number(m[1]);
  return (start + 1) % 100 === Number(m[2]) ? start : undefined;
}

function fyLabel(start: number): string {
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

function carryYears(kind: LossKind, pack: RulePack): number {
  const cf = pack.lossCarryForward;
  if (kind === "houseProperty") return cf.housePropertyYears;
  if (kind === "business") return cf.businessYears;
  if (kind === "speculative") return cf.speculativeYears;
  return cf.capitalYears;
}

function rupees(field: string, value: number | undefined): number {
  const v = value ?? 0;
  if (!Number.isFinite(v)) {
    throw new Error(`${field} must be a finite amount in rupees.`);
  }
  return v;
}

function nonNegative(
  field: string,
  value: number | undefined,
  fix: string,
): number {
  const v = rupees(field, value);
  if (v < 0) throw new Error(`${field} cannot be negative: ${fix}`);
  return v;
}

function zeroTotals(): LossTotals {
  return {
    houseProperty: 0,
    business: 0,
    speculative: 0,
    shortTermCapital: 0,
    longTermCapital: 0,
  };
}

function withTotal(income: Record<IncomeBucket, number>): IncomeByHead {
  const grossTotalIncome = SCHEDULE_ORDER.reduce((s, b) => s + income[b], 0);
  return { ...income, grossTotalIncome };
}

function lotView(lot: Lot, amount: number): CarryForwardLot {
  return {
    kind: lot.kind,
    originFy: lot.originFy,
    originAy: fyLabel(lot.originStart + 1),
    amount,
    lastUsableFy: fyLabel(lot.lastUsableStart),
    lastUsableAy: fyLabel(lot.lastUsableStart + 1),
    section: CARRY_SECTION[lot.kind],
  };
}

/** Set `lots` off against `buckets`, each lot through every bucket before the
 * next lot starts (so oldest first, when the lots are sorted that way). `cap`
 * is a shared ceiling on the total set off, used for s.71(3A). */
function setOff(
  ledger: Ledger,
  lots: Lot[],
  buckets: IncomeBucket[],
  stage: SetoffStage,
  sectionOf: (lot: Lot, bucket: IncomeBucket) => string,
  cap?: { left: number },
): void {
  for (const lot of lots) {
    for (const bucket of buckets) {
      const limit = cap ? cap.left : Number.POSITIVE_INFINITY;
      const amount = Math.min(lot.remaining, ledger.income[bucket], limit);
      if (!(amount > 0)) continue;
      lot.remaining -= amount;
      ledger.income[bucket] -= amount;
      if (cap) cap.left -= amount;
      ledger.steps.push({
        step: ledger.steps.length + 1,
        stage,
        section: sectionOf(lot, bucket),
        loss: lot.kind,
        originFy: lot.originFy,
        against: bucket,
        amount,
      });
    }
  }
}

/** Lots competing for the same income: the one whose period ends first goes
 * first, ties to the kind listed first in `tieOrder` (the kind with fewer
 * uses), then the older origin. */
function byExpiry(tieOrder: LossKind[]): (a: Lot, b: Lot) => number {
  return (a, b) =>
    a.lastUsableStart - b.lastUsableStart ||
    tieOrder.indexOf(a.kind) - tieOrder.indexOf(b.kind) ||
    a.originStart - b.originStart;
}

function interHeadSection(bucket: IncomeBucket): string {
  return GAINS.has(bucket) ? "s.71(2)" : "s.71(1)";
}

function readBroughtForward(
  rows: BroughtForwardLoss[],
  pack: RulePack,
  packStart: number,
): Lot[] {
  const lots: Lot[] = [];
  for (const [i, row] of rows.entries()) {
    const field = `broughtForward[${i}]`;
    if (!LOSS_KINDS.includes(row.kind)) {
      throw new Error(
        `${field}.kind "${String(row.kind)}" is not one of ${LOSS_KINDS.join(", ")}.`,
      );
    }
    const originStart = fyStart(row.originFy);
    if (originStart === undefined) {
      throw new Error(
        `${field}.originFy "${row.originFy}" is not a financial year like "2021-22".`,
      );
    }
    if (originStart >= packStart) {
      throw new Error(
        `${field}.originFy ${row.originFy} is not before FY ${pack.fy}: a loss of this year goes in the current-year fields, not broughtForward.`,
      );
    }
    const amount = nonNegative(
      `${field}.amount`,
      row.amount,
      "enter the unabsorbed loss as a positive number.",
    );
    if (amount === 0) continue;
    lots.push({
      kind: row.kind,
      originFy: row.originFy,
      originStart,
      lastUsableStart: originStart + carryYears(row.kind, pack),
      opening: amount,
      remaining: amount,
    });
  }
  return lots.sort((a, b) => a.originStart - b.originStart);
}

/** Loss set-off engine for one FY: this year's losses within and across
 * heads, then brought-forward losses, then what carries forward, what expired
 * and what s.80 forfeits, in Schedule CYLA/BFLA/CFL shape plus the figures
 * compute_tax takes. */
export function computeLossSetoff(
  input: LossSetoffInput,
  pack: RulePack,
): LossSetoffResult {
  const packStart = fyStart(pack.fy);
  if (packStart === undefined) {
    throw new Error(`rule pack FY "${pack.fy}" is not in YYYY-YY form.`);
  }
  const notes: string[] = [];
  const warnings: string[] = [];
  const negativeFix =
    "enter a loss as a positive number in shortTermLoss / longTermLoss.";

  const salaryGross = nonNegative(
    "salaryIncome",
    input.salaryIncome,
    "the salary head has no loss.",
  );
  const houseProperty = rupees("houseProperty", input.houseProperty);
  const business = rupees("business", input.business);
  const speculative = rupees("speculative", input.speculative);
  let otherSources = rupees("otherSources", input.otherSources);
  if (otherSources < 0) {
    warnings.push(
      `otherSources was negative (${rs(otherSources)}). A loss under other sources is not modelled (it may be set off under s.71 but never carries forward), so it was treated as 0.`,
    );
    otherSources = 0;
  }
  const cg: CapitalGainsInput = input.capitalGains ?? {};
  const stcg111A = nonNegative(
    "capitalGains.stcg111A",
    cg.stcg111A,
    negativeFix,
  );
  const stcgOther = nonNegative(
    "capitalGains.stcgOther",
    cg.stcgOther,
    negativeFix,
  );
  const ltcg112A = nonNegative(
    "capitalGains.ltcg112A",
    cg.ltcg112A,
    negativeFix,
  );
  const ltcgOther = nonNegative(
    "capitalGains.ltcgOther",
    cg.ltcgOther,
    negativeFix,
  );
  const shortTermLoss = nonNegative(
    "capitalGains.shortTermLoss",
    cg.shortTermLoss,
    "enter the loss as a positive number.",
  );
  const longTermLoss = nonNegative(
    "capitalGains.longTermLoss",
    cg.longTermLoss,
    "enter the loss as a positive number.",
  );

  // s.16(ia): salary is chargeable net of the standard deduction, and that net
  // figure is what a house-property loss can reach.
  const regimeRules = input.regime === "new" ? pack.newRegime : pack.oldRegime;
  const salary =
    salaryGross - Math.min(regimeRules.standardDeduction, salaryGross);

  // s.24(b) on a self-occupied house, exactly as compute_tax applies it: the
  // loss IS the interest, capped by the second proviso in the old regime and
  // nil under s.115BAC(2)(i). What the cap removes is no loss at all.
  const sopCapOld = pack.oldRegime.deductionCaps["24b_selfOccupied"] ?? 0;
  const hpClaimed = Math.max(0, -houseProperty);
  if (hpClaimed > 0 && input.housePropertyType === undefined) {
    warnings.push(
      `housePropertyType was not given, so the ${rs(hpClaimed)} house-property loss is treated as let-out (no s.24(b) cap). A self-occupied house's loss is its s.24(b) interest: at most ${rs(sopCapOld)} in the old regime and nil in the new one.`,
    );
  }
  const selfOccupied = input.housePropertyType === "selfOccupied";
  const sopCap = input.regime === "old" ? sopCapOld : 0;
  const hpLoss = selfOccupied ? Math.min(hpClaimed, sopCap) : hpClaimed;
  const housePropertyLossDisallowed = hpClaimed - hpLoss;
  if (housePropertyLossDisallowed > 0) {
    notes.push(
      input.regime === "new"
        ? `s.115BAC(2)(i): interest on a self-occupied house is not deductible under the new regime, so the ${rs(housePropertyLossDisallowed)} claimed is no loss and nothing is set off or carried forward.`
        : `s.24(b) second proviso: interest on a self-occupied house is deductible up to ${rs(sopCap)}; the ${rs(housePropertyLossDisallowed)} above that is no loss and is not carried forward.`,
    );
  }

  const income: Record<IncomeBucket, number> = {
    salary,
    houseProperty: Math.max(0, houseProperty),
    business: Math.max(0, business),
    speculative: Math.max(0, speculative),
    otherSources,
    stcg111A,
    stcgOther,
    ltcg112A,
    ltcgOther,
  };
  const incomeBeforeSetoff = withTotal({ ...income });
  const ledger: Ledger = { income, steps: [] };

  const currentLot = (kind: LossKind, amount: number): Lot => ({
    kind,
    originFy: pack.fy,
    originStart: packStart,
    lastUsableStart: packStart + carryYears(kind, pack),
    opening: amount,
    remaining: amount,
  });
  const current: Record<LossKind, Lot> = {
    houseProperty: currentLot("houseProperty", hpLoss),
    business: currentLot("business", Math.max(0, -business)),
    speculative: currentLot("speculative", Math.max(0, -speculative)),
    shortTermCapital: currentLot("shortTermCapital", shortTermLoss),
    longTermCapital: currentLot("longTermCapital", longTermLoss),
  };
  const currentYearLosses = zeroTotals();
  for (const kind of LOSS_KINDS)
    currentYearLosses[kind] = current[kind].opening;
  const intraHead = (lot: Lot) => INTRA_HEAD_SECTION[lot.kind];

  // Stage 1, s.70 within each head. Short-term gains first take the
  // short-term loss, which is the only loss that can reach them; long-term
  // gains then go to the long-term loss before what is left of the short-term
  // one, so the more usable loss is the one carried.
  setOff(ledger, [current.shortTermCapital], STCG, "intraHead", intraHead);
  setOff(
    ledger,
    [current.longTermCapital, current.shortTermCapital],
    LTCG,
    "intraHead",
    intraHead,
  );
  // s.70(1): a business loss may absorb speculative profit; s.73(1) bars the
  // reverse, so a speculative loss has no step here at all.
  setOff(ledger, [current.business], ["speculative"], "intraHead", intraHead);
  const afterIntraHead = { ...income };

  // Stage 2, s.71 across heads. Capital and speculative losses never cross
  // (s.71(3), s.73(1)); a business loss never reaches salary (s.71(2A)).
  const hpCap = pack.oldRegime.deductionCaps.housePropertyLossSetOff ?? 0;
  if (current.houseProperty.opening > 0) {
    if (input.regime === "new") {
      notes.push(
        `s.115BAC(2)(ii)(b): under the new regime a house-property loss is not set off against any other head, so the ${rs(current.houseProperty.opening)} carries forward under s.71B against house-property income only.`,
      );
    } else {
      setOff(
        ledger,
        [current.houseProperty],
        HOUSE_PROPERTY_LOSS_ORDER,
        "interHead",
        (_lot, bucket) => `${interHeadSection(bucket)}, s.71(3A)`,
        { left: hpCap },
      );
      notes.push(
        `s.71(3A): a house-property loss is set off against other heads up to ${rs(hpCap)}, salary first (a business loss never can be, s.71(2A)), then other sources, business income and gains. ${rs(current.houseProperty.opening - current.houseProperty.remaining)} was set off.`,
      );
    }
  }
  setOff(
    ledger,
    [current.business],
    BUSINESS_LOSS_ORDER,
    "interHead",
    (_lot, bucket) => interHeadSection(bucket),
  );
  const afterCyla = { ...income };

  // Stage 3, brought-forward losses, oldest first within a kind.
  const broughtForward = readBroughtForward(
    input.broughtForward ?? [],
    pack,
    packStart,
  );
  const usable = broughtForward.filter((l) => l.lastUsableStart >= packStart);
  const ofKind = (kind: LossKind) => usable.filter((l) => l.kind === kind);
  const bfSection = (lot: Lot) => BROUGHT_FORWARD_SECTION[lot.kind];
  // s.71B: house property against house-property income only.
  setOff(
    ledger,
    ofKind("houseProperty"),
    ["houseProperty"],
    "broughtForward",
    bfSection,
  );
  // s.72(1): business against business income, which includes speculative
  // profit; s.73(2): speculative against speculative profit only. Business
  // income goes to business losses alone, then speculative profit is shared,
  // the loss whose period ends first going first.
  setOff(ledger, ofKind("business"), ["business"], "broughtForward", bfSection);
  setOff(
    ledger,
    [...ofKind("speculative"), ...ofKind("business")].sort(
      byExpiry(["speculative", "business"]),
    ),
    ["speculative"],
    "broughtForward",
    bfSection,
  );
  // s.74(1)(a): short-term against any gain; s.74(1)(b): long-term against
  // long-term gains only. Same split as stage 1.
  setOff(ledger, ofKind("shortTermCapital"), STCG, "broughtForward", bfSection);
  setOff(
    ledger,
    [...ofKind("longTermCapital"), ...ofKind("shortTermCapital")].sort(
      byExpiry(["longTermCapital", "shortTermCapital"]),
    ),
    LTCG,
    "broughtForward",
    bfSection,
  );

  // What is left: carried, expired, or forfeited under s.80.
  const carryForward: CarryForwardLot[] = [];
  const expired: ExpiredLot[] = broughtForward
    .filter((l) => l.lastUsableStart < packStart)
    .map(
      (l): ExpiredLot => ({
        ...lotView(l, l.remaining),
        when: "beforeThisYear",
      }),
    );
  const forfeited: ForfeitedLoss[] = [];
  for (const lot of usable) {
    if (lot.remaining <= 0) continue;
    if (lot.lastUsableStart <= packStart) {
      expired.push({ ...lotView(lot, lot.remaining), when: "endOfThisYear" });
    } else {
      carryForward.push(lotView(lot, lot.remaining));
    }
  }
  for (const kind of LOSS_KINDS) {
    const lot = current[kind];
    if (lot.remaining <= 0) continue;
    // s.80 names ss.72(1), 73(2), 74(1) and 74(3), not s.71B: a house-property
    // loss carries forward from a belated return too.
    if (kind !== "houseProperty" && !input.filedByDueDate) {
      forfeited.push({ kind, amount: lot.remaining, section: "s.80" });
    } else if (lot.lastUsableStart <= packStart) {
      expired.push({ ...lotView(lot, lot.remaining), when: "endOfThisYear" });
    } else {
      carryForward.push(lotView(lot, lot.remaining));
    }
  }
  carryForward.sort(
    (a, b) =>
      a.originFy.localeCompare(b.originFy) ||
      LOSS_KINDS.indexOf(a.kind) - LOSS_KINDS.indexOf(b.kind),
  );
  const carryForwardTotals = zeroTotals();
  for (const lot of carryForward) carryForwardTotals[lot.kind] += lot.amount;

  const steps = ledger.steps;
  const setOffBy = (stage: SetoffStage, kind: LossKind, head: IncomeBucket) =>
    steps
      .filter((s) => s.stage === stage && s.loss === kind && s.against === head)
      .reduce((sum, s) => sum + s.amount, 0);

  // Schedules, in the utility's shape.
  const cylaLossRemaining = zeroTotals();
  for (const kind of LOSS_KINDS)
    cylaLossRemaining[kind] = current[kind].remaining;
  const cylaRows: CylaRow[] = SCHEDULE_ORDER.map((head) => ({
    head,
    income: afterIntraHead[head],
    housePropertyLossSetOff: setOffBy("interHead", "houseProperty", head),
    businessLossSetOff: setOffBy("interHead", "business", head),
    remaining: afterCyla[head],
  }));
  const bflaTotals = zeroTotals();
  const bflaRows: BflaRow[] = SCHEDULE_ORDER.map((head) => {
    const row: BflaRow = {
      head,
      income: afterCyla[head],
      ...zeroTotals(),
      remaining: income[head],
    };
    for (const kind of LOSS_KINDS) {
      row[kind] = setOffBy("broughtForward", kind, head);
      bflaTotals[kind] += row[kind];
    }
    return row;
  });
  const cflByOrigin = new Map<number, CflRow>();
  const totalBroughtForward = zeroTotals();
  for (const lot of usable) {
    const row = cflByOrigin.get(lot.originStart) ?? {
      fy: lot.originFy,
      ay: fyLabel(lot.originStart + 1),
      ...zeroTotals(),
    };
    row[lot.kind] += lot.opening;
    totalBroughtForward[lot.kind] += lot.opening;
    cflByOrigin.set(lot.originStart, row);
  }
  const lapsedAtYearEnd = zeroTotals();
  for (const lot of expired) {
    if (lot.when === "endOfThisYear" && lot.originFy !== pack.fy) {
      lapsedAtYearEnd[lot.kind] += lot.amount;
    }
  }
  const cflCurrent: CflRow = {
    fy: pack.fy,
    ay: pack.ay,
    ...zeroTotals(),
  };
  for (const lot of carryForward) {
    if (lot.originFy === pack.fy) cflCurrent[lot.kind] += lot.amount;
  }

  // compute_tax's fields. The house-property loss set off against slab-rate
  // income travels as housePropertyLoss so compute_tax reports it; it is
  // already inside both of compute_tax's caps (s.24(b) and s.71(3A)), and
  // min() of a figure under its cap is the figure, so nothing is capped twice.
  // The part set off against gains is already out of stcg111A / ltcg112A.
  const hpAgainstSlab = steps
    .filter(
      (s) =>
        s.stage === "interHead" &&
        s.loss === "houseProperty" &&
        SLAB_RATE.has(s.against),
    )
    .reduce((sum, s) => sum + s.amount, 0);
  const hpAgainstSalary = setOffBy("interHead", "houseProperty", "salary");
  const otherSlabRate = SCHEDULE_ORDER.filter(
    (b) => b !== "salary" && SLAB_RATE.has(b),
  ).reduce((sum, b) => sum + income[b], 0);
  const forComputeTax: ForComputeTax = {
    regime: input.regime,
    salaryIncome: salaryGross,
    // compute_tax takes salary - standard deduction + otherIncome -
    // housePropertyLoss, so the part of the loss set off against salary is
    // left out of otherIncome and the rest added back.
    otherIncome: otherSlabRate + hpAgainstSlab - hpAgainstSalary,
    stcg111A: income.stcg111A,
    ltcg112A: income.ltcg112A,
  };
  if (hpAgainstSlab > 0) {
    forComputeTax.housePropertyLoss = hpAgainstSlab;
    forComputeTax.housePropertyType = input.housePropertyType ?? "letOut";
  }

  // Notes on what the engine chose and why.
  if (steps.length > 0) {
    notes.push(
      "Order: this year's losses first, within a head (s.70) and then across heads (s.71), then brought-forward losses (ss.71B, 72, 73, 74), the order of Schedules CYLA and BFLA.",
    );
  }
  if (steps.some((s) => GAINS.has(s.against))) {
    notes.push(
      "Among gains the assessee chooses which a loss absorbs. This engine takes slab-rate STCG, then s.111A STCG, then s.112 LTCG, and s.112A LTCG last, so the 112A gains keep their exemption longest. Fill the same rows in the utility or its totals will differ.",
    );
  }
  if (steps.some((s) => s.against === "ltcg112A")) {
    notes.push(
      `Set-off comes before the s.112A threshold: compute_tax applies the ${rs(pack.capitalGains.ltcg112AExemption)} exemption to the 112A gains left (forComputeTax.ltcg112A), so a loss absorbed by 112A gains below that line saves no tax this year. Brought-forward set-off under s.74 is not optional where gains exist.`,
    );
  }
  if (salary > 0 && current.business.remaining > 0) {
    notes.push(
      `s.71(2A): a business loss is never set off against salary, so ${rs(current.business.remaining)} of this year's business loss is left with ${rs(income.salary)} of salary untouched by it.`,
    );
  }
  if (current.speculative.remaining > 0) {
    notes.push(
      `s.73(1): a speculative loss is set off only against speculative profit, so ${rs(current.speculative.remaining)} is left; s.73(4) carries it for ${pack.lossCarryForward.speculativeYears} years against speculative profit only.`,
    );
  }
  const capitalLeft =
    current.shortTermCapital.remaining + current.longTermCapital.remaining;
  if (capitalLeft > 0) {
    notes.push(
      `s.71(3): a capital loss is never set off against another head, so ${rs(capitalLeft)} is left; s.74 carries it for ${pack.lossCarryForward.capitalYears} years, short-term against any gain and long-term against long-term gains only.`,
    );
  }
  if (broughtForward.length > 0) {
    notes.push(
      `Brought-forward amounts are taken as unabsorbed at the start of FY ${pack.fy} and as determined in returns filed by their s.139(1) due dates (s.80). They are used oldest first; where two kinds compete for the same income (business and speculative losses for speculative profit, short- and long-term losses for long-term gains) the one whose period ends first goes first.`,
    );
    if (input.regime === "new") {
      notes.push(
        "s.115BAC(2)(ii)(a): under the new regime a brought-forward loss attributable to a deduction the regime denies (s.24(b) interest on a self-occupied house, s.35AD and the like) cannot be set off. This engine cannot see what a loss is made of: leave such a loss out of broughtForward.",
      );
    }
  }
  const expiredBefore = expired
    .filter((l) => l.when === "beforeThisYear")
    .reduce((sum, l) => sum + l.amount, 0);
  const lapsing = expired
    .filter((l) => l.when === "endOfThisYear")
    .reduce((sum, l) => sum + l.amount, 0);
  if (expiredBefore > 0) {
    notes.push(
      `${rs(expiredBefore)} of brought-forward loss had run out its carry-forward period before FY ${pack.fy} and was not used (see expired).`,
    );
  }
  if (lapsing > 0) {
    notes.push(
      `${rs(lapsing)} of loss reached the last year of its period in FY ${pack.fy} and lapses unabsorbed at the year's end (see expired).`,
    );
  }
  const forfeitedTotal = forfeited.reduce((sum, f) => sum + f.amount, 0);
  if (forfeitedTotal > 0) {
    notes.push(
      `s.80: the return is not furnished by the s.139(1) due date, so ${rs(forfeitedTotal)} of this year's ${forfeited.map((f) => KIND_LABEL[f.kind]).join(", ")} loss left after this year's set-off is not carried forward. It was still set off this year, brought-forward losses were still used, and a house-property loss still carries forward (s.80 does not name s.71B).`,
    );
  } else if (
    input.filedByDueDate &&
    carryForward.some(
      (l) => l.originFy === pack.fy && l.kind !== "houseProperty",
    )
  ) {
    notes.push(
      "s.80: this year's business, speculative and capital losses carry forward only on a return furnished by the s.139(1) due date; a belated return forfeits them (a house-property loss excepted).",
    );
  }
  notes.push(
    `forComputeTax is the income after every set-off in compute_tax's own fields for the ${input.regime} regime: add ageBand and deductions and pass it as is. Its otherIncome is other sources, house-property income, business and speculative profit and slab-rate STCG after set-off. A house-property loss set off against slab-rate income travels as housePropertyLoss, already inside the s.24(b) and s.71(3A) limits, so compute_tax's caps change nothing; the carry-forward is the one reported here, not compute_tax's housePropertyLossCarriedForward.`,
  );
  if (current.houseProperty.opening > 0) {
    notes.push(
      "The house-property set-off differs by regime: run this once per regime before comparing them, not once for compare_regimes.",
    );
  }
  if (income.ltcgOther > 0) {
    warnings.push(
      `${rs(income.ltcgOther)} of s.112 long-term gains (outside 112A) is left after set-off and has no compute_tax field (outsideComputeTax.ltcgOther). compute_tax's total income, s.87A test and surcharge band leave it out, and its s.112 tax must be computed separately.`,
    );
  }

  return {
    fy: pack.fy,
    ay: pack.ay,
    regime: input.regime,
    rulePackVersion: pack.rulePackVersion,
    filedByDueDate: input.filedByDueDate,
    incomeBeforeSetoff,
    currentYearLosses,
    housePropertyLossDisallowed,
    steps,
    incomeAfterSetoff: withTotal(income),
    carryForward,
    carryForwardTotals,
    expired,
    forfeited,
    schedules: {
      cyla: {
        rows: cylaRows,
        totalSetOff: {
          houseProperty: cylaRows.reduce(
            (s, r) => s + r.housePropertyLossSetOff,
            0,
          ),
          business: cylaRows.reduce((s, r) => s + r.businessLossSetOff, 0),
        },
        lossRemaining: cylaLossRemaining,
      },
      bfla: { rows: bflaRows, totalSetOff: bflaTotals },
      cfl: {
        broughtForward: [...cflByOrigin.entries()]
          .sort(([a], [b]) => a - b)
          .map(([, row]) => row),
        totalBroughtForward,
        adjustedInBfla: { ...bflaTotals },
        lapsedAtYearEnd,
        currentYear: cflCurrent,
        carriedToFuture: { ...carryForwardTotals },
      },
    },
    forComputeTax,
    outsideComputeTax: { ltcgOther: income.ltcgOther },
    notes,
    warnings,
    disclaimers: DISCLAIMERS,
  };
}
