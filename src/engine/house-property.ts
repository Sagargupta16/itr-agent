import type { Regime } from "./compute.js";
import type { RulePack } from "./rulepack.js";

/** Income from house property under the 1961 Act, ss.22 to 24, FY 2025-26, for
 * one owner. The filer gives rent, municipal tax and interest per house; the
 * head itself (annual value, the s.24(a) standard deduction, s.24(b) interest
 * with its self-occupied caps, pre-construction instalments and the s.23(2)
 * limit on self-occupied houses) is worked out here so the model never does
 * the arithmetic. Every figure comes from `pack.houseProperty` and
 * `pack.oldRegime.deductionCaps`.
 *
 * Inter-head set-off is NOT done here. compute.ts owns the s.71(3A) limit and
 * the s.115BAC(2)(ii)(b) bar, and `forComputeTax` hands it the head figure in
 * the shape it already accepts. Amounts are whole rupees; paise are rounded
 * at entry so every output adds up exactly. */

export type HouseUse = "selfOccupied" | "letOut";

export interface HouseInput {
  /** Echoed back so results can be matched to houses. Defaults to "house N". */
  label?: string | undefined;
  /** `selfOccupied`: the owner lives in it, or cannot because work keeps them
   * elsewhere (s.23(2)). `letOut`: let for the whole or any part of the year,
   * which takes a house out of s.23(2) even if lived in for the rest (s.23(3)). */
  use: HouseUse;
  /** s.23(1) gross annual value for the year: rent received or receivable, or
   * the rent it might reasonably fetch where that is higher (s.23(1)(a)/(b)),
   * or the lower actual rent where a vacancy caused it (s.23(1)(c)). Ignored
   * for a self-occupied house unless s.23(4) deems it let out, when it must be
   * the expected rent. The owner's share where the house is co-owned (s.26). */
  grossAnnualValue?: number | undefined;
  /** Municipal taxes the OWNER actually paid in this FY, whichever year they
   * were levied for (s.23(1) proviso). Taxes the tenant bears do not count. */
  municipalTaxesPaid?: number | undefined;
  /** Interest payable for this FY on capital borrowed to buy, build, repair,
   * renew or rebuild the house. s.24(b) allows interest payable, not only paid;
   * principal repayment is s.80C, not this. */
  interestPayable?: number | undefined;
  /** Total interest for the period before the FY of completion, net of any
   * part already allowed under another provision (Explanation to s.24(b)).
   * This FY's instalment is worked out from `constructionCompletedFy`. */
  preConstructionInterest?: number | undefined;
  /** FY in which acquisition or construction was completed, like "2023-24". */
  constructionCompletedFy?: string | undefined;
  /** Self-occupied only: the loan was taken on or after 1 April 1999 to buy or
   * build the house and the work finished within five years of the end of the
   * FY of borrowing, so the higher cap applies (s.24(b) second proviso). False
   * for an older loan, a repair or renovation loan, or a late completion, which
   * stay on the first-proviso cap. Default true. */
  loanQualifiesForHigherCap?: boolean | undefined;
}

/** `deemedLetOut`: declared self-occupied but past the s.23(4) limit, so
 * valued as if let. */
export type HouseTreatment = "selfOccupied" | "letOut" | "deemedLetOut";

export interface HouseResult {
  label: string;
  use: HouseUse;
  treatedAs: HouseTreatment;
  /** The s.23(1) value used; nil for a self-occupied house (s.23(2)). */
  grossAnnualValue: number;
  /** Municipal taxes deducted (s.23(1) proviso); nil for a self-occupied house. */
  municipalTaxes: number;
  netAnnualValue: number;
  /** s.24(a): the pack's share of a positive net annual value. */
  standardDeduction: number;
  interestPayable: number;
  /** This FY's equal instalment of pre-construction interest. */
  preConstructionInstalment: number;
  /** Which instalment that is (1-based); null when none falls in this FY. */
  preConstructionInstalmentNumber: number | null;
  /** interestPayable + preConstructionInstalment. */
  interestClaimed: number;
  interestAllowed: number;
  /** What the s.24(b) caps, s.115BAC(2)(i) or an unfinished house remove. Not
   * a loss: it is neither set off nor carried forward. */
  interestDisallowed: number;
  /** Income from this house; negative is a loss. */
  income: number;
}

export interface HousePropertyTotals {
  grossAnnualValue: number;
  municipalTaxes: number;
  netAnnualValue: number;
  standardDeduction: number;
  interestClaimed: number;
  interestAllowed: number;
  interestDisallowed: number;
  /** Income under the head after intra-head netting; negative is a loss. */
  income: number;
}

/** Fields to pass straight into compute_tax. A loss goes in as `letOut`
 * because the s.24(b) caps are already applied here: `selfOccupied` would make
 * compute_tax cap the interest a second time. */
export interface HousePropertyForComputeTax {
  /** Positive head income, to ADD to compute_tax's otherIncome. */
  otherIncome: number;
  /** Head loss as a positive number, for compute_tax's housePropertyLoss. */
  housePropertyLoss: number;
  housePropertyType: "letOut";
}

export interface HousePropertyResult {
  fy: string;
  regime: Regime;
  rulePackVersion: string;
  houses: HouseResult[];
  totals: HousePropertyTotals;
  /** The aggregate s.24(b) ceiling on self-occupied interest that applied: the
   * higher cap if any self-occupied loan qualifies, else the older one, nil
   * under the new regime, null with no self-occupied house. */
  selfOccupiedInterestCap: number | null;
  forComputeTax: HousePropertyForComputeTax;
  warnings: string[];
  notes: string[];
  disclaimers: string[];
}

const DISCLAIMERS = [
  "Not tax advice. Verify against the official income tax utility before filing.",
  "Figures are the owner's share where a house is co-owned (s.26). Arrears of rent and recovered unrealised rent (s.25A) are not modelled.",
];

const FY_RE = /^(\d{4})-(\d{2})$/;

/** Start year of a "YYYY-YY" financial year, rejecting "2023-25" and the like. */
function fyStartYear(fy: string, label: string): number {
  const match = FY_RE.exec(fy);
  const start = Number(match?.[1]);
  if (!match || (start + 1) % 100 !== Number(match[2])) {
    throw new Error(
      `${label} must be a financial year like "2023-24", got "${fy}"`,
    );
  }
  return start;
}

function fyLabel(start: number): string {
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

function amount(label: string, name: string, v: number | undefined): number {
  if (v === undefined) return 0;
  if (!Number.isFinite(v) || v < 0) {
    throw new Error(
      `${label}: ${name} must be a non-negative number (got ${v})`,
    );
  }
  return Math.round(v);
}

function inr(n: number): string {
  return n.toLocaleString("en-IN");
}

interface Instalment {
  amount: number;
  number: number | null;
}

const NO_INSTALMENT: Instalment = { amount: 0, number: null };

/** Explanation to s.24(b): pre-construction interest is deducted in equal
 * instalments for the FY of completion and the years after it, as many as the
 * pack says. The engine works out which one (if any) falls in this FY so the
 * caller never counts years. */
function preConstructionInstalment(
  label: string,
  total: number,
  completed: number | undefined,
  thisFy: number,
  pack: RulePack,
  warnings: string[],
): Instalment {
  if (total === 0) return NO_INSTALMENT;
  if (completed === undefined) {
    warnings.push(
      `${label}: pre-construction interest of Rs ${inr(total)} needs constructionCompletedFy (the FY acquisition or construction was completed, like "2023-24"). The instalments run from that year (Explanation to s.24(b)), so none was allowed.`,
    );
    return NO_INSTALMENT;
  }
  const n = pack.houseProperty.preConstructionInstallments;
  const index = thisFy - completed;
  // A completion after this FY is warned about where the current interest is
  // disallowed; no instalment can fall before the year of completion.
  if (index < 0) return NO_INSTALMENT;
  if (index >= n) {
    warnings.push(
      `${label}: the ${n} pre-construction instalments ran FY ${fyLabel(completed)} to FY ${fyLabel(completed + n - 1)}, so none falls in FY ${pack.fy} (Explanation to s.24(b)). Drop preConstructionInterest for this year.`,
    );
    return NO_INSTALMENT;
  }
  // Cumulative rounding: instalment k is round(k/n of total) minus round of
  // the k-1 before it, so the n instalments add up to the total exactly.
  const upTo = (k: number) => Math.round((total * k) / n);
  return { amount: upTo(index + 1) - upTo(index), number: index + 1 };
}

interface Draft {
  label: string;
  use: HouseUse;
  treatedAs: HouseTreatment;
  grossAnnualValue: number;
  municipalTaxes: number;
  interestPayable: number;
  instalment: Instalment;
  /** Interest the caps may allow: an unfinished house's current interest is
   * pre-construction interest, so it is left out. */
  eligibleInterest: number;
  qualifiesForHigherCap: boolean;
}

/** Income from house property for FY `pack.fy` under `regime`, per house and
 * for the head. Tolerant: statutory edge cases (too many self-occupied houses,
 * a missing rent, an instalment window that has ended) come back as warnings;
 * only impossible input (a negative amount, a malformed FY, an unknown use)
 * throws. */
export function computeHouseProperty(
  houses: HouseInput[],
  pack: RulePack,
  regime: Regime,
): HousePropertyResult {
  const hp = pack.houseProperty;
  const thisFy = fyStartYear(pack.fy, `rule pack fy${pack.fy}.json fy`);
  const warnings: string[] = [];
  const notes: string[] = [];

  // s.23(4): with more self-occupied houses than s.23(2) admits, the owner
  // picks which keep nil annual value (clause (a)) and the rest are valued as
  // if let (clause (b)). Input order stands in for that choice.
  let selfOccupiedKept = 0;
  const deemed: string[] = [];

  const drafts: Draft[] = houses.map((h, i) => {
    const label = h.label?.trim() || `house ${i + 1}`;
    if (h.use !== "selfOccupied" && h.use !== "letOut") {
      throw new Error(
        `${label}: use must be "selfOccupied" or "letOut" (got ${String(h.use)})`,
      );
    }
    const gavIn = amount(label, "grossAnnualValue", h.grossAnnualValue);
    const municipalIn = amount(
      label,
      "municipalTaxesPaid",
      h.municipalTaxesPaid,
    );
    const interestPayable = amount(label, "interestPayable", h.interestPayable);
    const preTotal = amount(
      label,
      "preConstructionInterest",
      h.preConstructionInterest,
    );
    const completed =
      h.constructionCompletedFy === undefined
        ? undefined
        : fyStartYear(
            h.constructionCompletedFy,
            `${label}: constructionCompletedFy`,
          );

    let treatedAs: HouseTreatment = "letOut";
    if (h.use === "selfOccupied") {
      if (selfOccupiedKept < hp.maxSelfOccupied) {
        selfOccupiedKept += 1;
        treatedAs = "selfOccupied";
      } else {
        treatedAs = "deemedLetOut";
        deemed.push(label);
      }
    }

    // s.23(2): a self-occupied house has nil annual value, so neither rent nor
    // municipal taxes enter it.
    const valued = treatedAs !== "selfOccupied";
    if (!valued && municipalIn > 0) {
      notes.push(
        `${label}: s.23(2) puts a self-occupied house at nil annual value, so the Rs ${inr(municipalIn)} of municipal taxes is not deducted.`,
      );
    }
    if (treatedAs === "deemedLetOut" && gavIn === 0) {
      warnings.push(
        `${label} is deemed let out but has no grossAnnualValue, so its annual value was taken as nil, which understates income. Pass the rent it might reasonably fetch for the year (s.23(1)(a)).`,
      );
    }
    if (treatedAs === "letOut" && h.grossAnnualValue === undefined) {
      warnings.push(
        `${label} is let out but has no grossAnnualValue, so its annual value was taken as nil. That is right only if it stood vacant all year (s.23(1)(c)); otherwise pass the rent received or receivable.`,
      );
    }
    if (valued && municipalIn > gavIn) {
      warnings.push(
        `${label}: municipal taxes of Rs ${inr(municipalIn)} exceed the gross annual value of Rs ${inr(gavIn)}, leaving a negative net annual value. Check the figure: only taxes the owner actually paid in FY ${pack.fy} count (s.23(1) proviso).`,
      );
    }

    // Explanation to s.24(b): interest up to the year of completion is
    // pre-construction interest, deductible only in instalments from then on.
    let eligibleCurrent = interestPayable;
    if (completed !== undefined && completed > thisFy) {
      eligibleCurrent = 0;
      warnings.push(
        `${label}: construction completes in FY ${fyLabel(completed)}, after FY ${pack.fy}. Interest up to then is pre-construction interest (Explanation to s.24(b)), so none is deductible this year: add this year's Rs ${inr(interestPayable)} to the pre-construction total and claim it in instalments from FY ${fyLabel(completed)}.`,
      );
    }
    const instalment = preConstructionInstalment(
      label,
      preTotal,
      completed,
      thisFy,
      pack,
      warnings,
    );
    if (instalment.number !== null) {
      notes.push(
        `${label}: pre-construction interest instalment ${instalment.number} of ${hp.preConstructionInstallments} (Rs ${inr(instalment.amount)} of Rs ${inr(preTotal)}), Explanation to s.24(b).`,
      );
    }

    return {
      label,
      use: h.use,
      treatedAs,
      grossAnnualValue: valued ? gavIn : 0,
      municipalTaxes: valued ? municipalIn : 0,
      interestPayable,
      instalment,
      eligibleInterest: eligibleCurrent + instalment.amount,
      qualifiesForHigherCap: h.loanQualifiesForHigherCap ?? true,
    };
  });

  if (deemed.length > 0) {
    warnings.push(
      `s.23(4): only ${hp.maxSelfOccupied} houses may be self-occupied at nil annual value, so ${deemed.join(", ")} ${deemed.length === 1 ? "is" : "are"} deemed let out and valued on expected rent. The owner picks which ${hp.maxSelfOccupied} to keep (s.23(4)(a)); list those first.`,
    );
  }

  // s.24(b) first and second provisos and the aggregate proviso: interest on
  // the self-occupied houses, pre-construction instalments included (they are
  // deducted "under this clause"), is capped in aggregate at the higher figure,
  // and the part on loans that do not qualify for it at the older figure. A
  // shared cap is allocated in input order; the total does not depend on it.
  // s.115BAC(2)(i) allows none of it under the new regime. Let-out and deemed
  // let-out interest has no cap in either regime.
  const capHigher = pack.oldRegime.deductionCaps["24b_selfOccupied"] ?? 0;
  const capOlder = hp.selfOccupiedInterestCapOlder;
  let usedAll = 0;
  let usedOlder = 0;
  // What the caps or s.115BAC(2)(i) removed from self-occupied interest, and
  // whether any of it rode on the higher cap (the third proviso then applies).
  let selfOccupiedCount = 0;
  let selfOccupiedDisallowed = 0;
  let higherCapUsed = false;
  let anyQualifies = false;

  const results: HouseResult[] = drafts.map((d) => {
    let interestAllowed = d.eligibleInterest;
    if (d.treatedAs === "selfOccupied") {
      selfOccupiedCount += 1;
      if (d.qualifiesForHigherCap) anyQualifies = true;
      if (regime === "new") {
        interestAllowed = 0;
      } else {
        let room = capHigher - usedAll;
        if (!d.qualifiesForHigherCap) {
          room = Math.min(room, capOlder - usedOlder);
        }
        interestAllowed = Math.min(d.eligibleInterest, Math.max(0, room));
        usedAll += interestAllowed;
        if (!d.qualifiesForHigherCap) usedOlder += interestAllowed;
        if (d.qualifiesForHigherCap && interestAllowed > 0) {
          higherCapUsed = true;
        }
      }
      selfOccupiedDisallowed += d.eligibleInterest - interestAllowed;
    }
    const netAnnualValue = d.grossAnnualValue - d.municipalTaxes;
    // s.24(a): a share of the net annual value; nothing on a nil or negative one.
    const standardDeduction =
      netAnnualValue > 0
        ? Math.round(netAnnualValue * hp.standardDeductionPct)
        : 0;
    const interestClaimed = d.interestPayable + d.instalment.amount;
    return {
      label: d.label,
      use: d.use,
      treatedAs: d.treatedAs,
      grossAnnualValue: d.grossAnnualValue,
      municipalTaxes: d.municipalTaxes,
      netAnnualValue,
      standardDeduction,
      interestPayable: d.interestPayable,
      preConstructionInstalment: d.instalment.amount,
      preConstructionInstalmentNumber: d.instalment.number,
      interestClaimed,
      interestAllowed,
      interestDisallowed: interestClaimed - interestAllowed,
      income: netAnnualValue - standardDeduction - interestAllowed,
    };
  });

  const sum = (pick: (r: HouseResult) => number): number =>
    results.reduce((s, r) => s + pick(r), 0);
  const totals: HousePropertyTotals = {
    grossAnnualValue: sum((r) => r.grossAnnualValue),
    municipalTaxes: sum((r) => r.municipalTaxes),
    netAnnualValue: sum((r) => r.netAnnualValue),
    standardDeduction: sum((r) => r.standardDeduction),
    interestClaimed: sum((r) => r.interestClaimed),
    interestAllowed: sum((r) => r.interestAllowed),
    interestDisallowed: sum((r) => r.interestDisallowed),
    income: sum((r) => r.income),
  };

  let selfOccupiedInterestCap: number | null = null;
  if (selfOccupiedCount > 0) {
    if (regime === "new") selfOccupiedInterestCap = 0;
    else selfOccupiedInterestCap = anyQualifies ? capHigher : capOlder;
  }

  if (selfOccupiedDisallowed > 0) {
    if (regime === "new") {
      notes.push(
        `s.115BAC(2)(i): interest on a self-occupied house is not deductible under the new regime, so the Rs ${inr(selfOccupiedDisallowed)} claimed is disallowed. It is not a loss, so nothing is set off or carried forward. Interest on a let-out or deemed let-out house is still allowed in full.`,
      );
    } else {
      notes.push(
        `s.24(b) provisos: interest on self-occupied houses, pre-construction instalments included, is deductible up to Rs ${inr(capHigher)} in aggregate (Rs ${inr(capOlder)} on a loan that does not qualify for the higher cap); the Rs ${inr(selfOccupiedDisallowed)} above that is not a loss and is not carried forward.${selfOccupiedCount > 1 ? " The cap is shared across the self-occupied houses and allocated in the order given." : ""}`,
      );
    }
  }
  if (higherCapUsed) {
    notes.push(
      "s.24(b) third proviso: the higher self-occupied cap needs the lender's certificate of the interest payable for the purchase or construction.",
    );
  }

  const headIncome = Math.max(0, totals.income);
  const headLoss = Math.max(0, -totals.income);
  if (headIncome > 0) {
    notes.push(
      `Head income of Rs ${inr(headIncome)} goes to compute_tax as forComputeTax.otherIncome, added to any other normal-rate income.`,
    );
  } else if (headLoss > 0) {
    notes.push(
      `Head loss of Rs ${inr(headLoss)} goes to compute_tax as housePropertyLoss with housePropertyType "letOut": the s.24(b) caps are already applied here, and "letOut" stops compute_tax capping a second time. compute_tax applies ${regime === "new" ? "the s.115BAC(2)(ii)(b) bar on inter-head set-off" : "the s.71(3A) set-off limit"} and carries the rest forward under s.71B.`,
    );
  }
  if (houses.length === 0) notes.push("No houses given: the head is nil.");

  return {
    fy: pack.fy,
    regime,
    rulePackVersion: pack.rulePackVersion,
    houses: results,
    totals,
    selfOccupiedInterestCap,
    forComputeTax: {
      otherIncome: headIncome,
      housePropertyLoss: headLoss,
      housePropertyType: "letOut",
    },
    warnings,
    notes,
    disclaimers: DISCLAIMERS,
  };
}
