import type { RulePack } from "./rulepack.js";

/** Presumptive business income under the 1961 Act, FY 2025-26: s.44AD (small
 * business), s.44ADA (specified professions) and s.44AE (goods carriages).
 * The schemes tax a DEEMED profit, or a higher one the filer declares. Every
 * rate and ceiling comes from `pack.itrEligibility.presumptive`; the engine
 * never does the model's arithmetic for it. */

export interface Presumptive44ADInput {
  scheme: "44AD";
  /** Turnover received by account payee cheque/draft, ECS or other prescribed
   * electronic modes (s.44AD(1) proviso: taxed at the lower digital rate). */
  digitalTurnover: number;
  /** The rest of turnover: cash and every other mode. */
  otherTurnover: number;
  /** Cash receipts are at most 5% of total turnover. When omitted it is derived
   * from the two turnover figures and the notes say so. */
  cashReceiptsWithin5Pct?: boolean;
  /** A higher profit the filer declares; the scheme taxes the deemed figure or more. */
  declaredProfit?: number;
}

export interface Presumptive44ADAInput {
  scheme: "44ADA";
  grossReceipts: number;
  /** Cash receipts are at most 5% of gross receipts (s.44ADA proviso). */
  cashReceiptsWithin5Pct: boolean;
  declaredProfit?: number;
}

export interface GoodsCarriage {
  /** "heavy" is a heavy goods vehicle (s.44AE(2)(a)), priced per ton; "other"
   * is any other goods carriage (s.44AE(2)(b)), priced per vehicle. A "heavy"
   * carriage at or under the pack's weight line is priced as "other", with a
   * warning (s.44AE Explanation). */
  type: "heavy" | "other";
  /** Gross vehicle weight in tons. Required for a heavy vehicle. */
  grossWeightTons?: number;
  /** Whole months owned in the year; a part month counts as a full one. */
  monthsOwned: number;
}

export interface Presumptive44AEInput {
  scheme: "44AE";
  carriages: GoodsCarriage[];
  /** The most carriages owned at any time in the year (the s.44AE(1) test).
   * Defaults to the length of `carriages`. */
  maxCarriagesAtAnyTime?: number;
  declaredProfit?: number;
}

export type PresumptiveInput =
  | Presumptive44ADInput
  | Presumptive44ADAInput
  | Presumptive44AEInput;

export interface PresumptiveBasisLine {
  label: string;
  amount: number;
  working: string;
}

export interface PresumptiveResult {
  scheme: "44AD" | "44ADA" | "44AE";
  /** False when the figures exceed the scheme's ceiling; the scheme is then
   * unavailable and `deemedIncome` is 0. */
  eligible: boolean;
  ceiling: {
    /** The limit applied (rupees, or a carriage count for 44AE). */
    applied: number;
    /** The figure measured against it. */
    measured: number;
    basis: string;
  };
  deemedIncome: number;
  /** One line per component of the deemed figure. */
  basis: PresumptiveBasisLine[];
  declaredProfit: number | null;
  /** The higher of the deemed and declared profit. */
  incomeToReport: number;
  /** Presumptive business income is normal-rate income. */
  forComputeTax: { otherIncome: number };
  warnings: string[];
  notes: string[];
  disclaimers: string[];
}

const DISCLAIMERS = [
  "Computed from the figures supplied; not tax or legal advice. Confirm with a qualified practitioner before filing.",
  "Presumptive income stands in for all business deductions, including depreciation; nothing further is claimed against it under s.28 to s.43C.",
];

function nonNegative(name: string, v: number): void {
  if (!Number.isFinite(v) || v < 0) {
    throw new Error(`${name} must be a non-negative number (got ${v})`);
  }
}

function rupees(n: number): number {
  return Math.round(n);
}

function inr(n: number): string {
  return n.toLocaleString("en-IN");
}

function pct(rate: number): string {
  return `${Math.round(rate * 10000) / 100}%`;
}

/** Shared tail: the reported figure is the higher of deemed and declared, with
 * the books and audit warning when the filer declares less. */
function finish(
  scheme: PresumptiveResult["scheme"],
  eligible: boolean,
  ceiling: PresumptiveResult["ceiling"],
  deemedIncome: number,
  basis: PresumptiveBasisLine[],
  declared: number | undefined,
  warnings: string[],
  notes: string[],
): PresumptiveResult {
  const declaredProfit = declared === undefined ? null : rupees(declared);
  const incomeToReport = Math.max(deemedIncome, declaredProfit ?? 0);
  if (eligible && declaredProfit !== null) {
    if (declaredProfit < deemedIncome) {
      warnings.push(
        `declared profit ${inr(declaredProfit)} is below the deemed ${inr(deemedIncome)}: the scheme taxes the deemed figure or more, and declaring less needs books of account (s.44AA) and a s.44AB audit when total income exceeds the basic exemption limit; the figure to report here stays ${inr(incomeToReport)}`,
      );
    } else {
      notes.push(
        `declared profit ${inr(declaredProfit)} is at or above the deemed ${inr(deemedIncome)}, so it is the income to report`,
      );
    }
  }
  if (!eligible) {
    warnings.push(
      "the scheme is unavailable: income is computed on books of account (s.28 to s.43C), a s.44AB audit applies where its limits are crossed, and the return is ITR-3; any declared profit here is only echoed back",
    );
  }
  return {
    scheme,
    eligible,
    ceiling,
    deemedIncome,
    basis,
    declaredProfit,
    incomeToReport,
    forComputeTax: { otherIncome: incomeToReport },
    warnings,
    notes,
    disclaimers: DISCLAIMERS,
  };
}

function compute44AD(
  input: Presumptive44ADInput,
  p: RulePack["itrEligibility"]["presumptive"],
): PresumptiveResult {
  nonNegative("digitalTurnover", input.digitalTurnover);
  nonNegative("otherTurnover", input.otherTurnover);
  if (input.declaredProfit !== undefined) {
    nonNegative("declaredProfit", input.declaredProfit);
  }
  const warnings: string[] = [];
  const notes: string[] = [];
  const turnover = input.digitalTurnover + input.otherTurnover;
  const share = turnover > 0 ? input.otherTurnover / turnover : 0;
  const derived = share <= p.cashShareLimit;
  let within5: boolean;
  if (input.cashReceiptsWithin5Pct === undefined) {
    within5 = derived;
    notes.push(
      `cashReceiptsWithin5Pct was not given; derived from the turnover split: non-digital receipts are ${Math.round(share * 10000) / 100}% of ${inr(turnover)}, so the ${pct(p.cashShareLimit)} condition is ${derived ? "met" : "not met"}`,
    );
  } else {
    within5 = input.cashReceiptsWithin5Pct;
    if (within5 && !derived) {
      warnings.push(
        `cashReceiptsWithin5Pct is true but non-digital receipts are ${Math.round(share * 10000) / 100}% of turnover, above ${pct(p.cashShareLimit)}; check the flag`,
      );
    }
  }
  const limit = within5 ? p.turnoverCap44ADDigital : p.turnoverCap44AD;
  const eligible = turnover <= limit;
  const ceiling = {
    applied: limit,
    measured: turnover,
    basis: within5
      ? `s.44AD(1) proviso: higher ceiling, cash receipts at most ${pct(p.cashShareLimit)} of turnover`
      : `s.44AD(1): ceiling where cash receipts exceed ${pct(p.cashShareLimit)} of turnover`,
  };
  if (!eligible) {
    warnings.push(
      `turnover ${inr(turnover)} exceeds the ${inr(limit)} ceiling${within5 ? "" : `; the ${inr(p.turnoverCap44ADDigital)} ceiling needs cash receipts of at most ${pct(p.cashShareLimit)} of turnover`}`,
    );
    return finish(
      "44AD",
      false,
      ceiling,
      0,
      [],
      input.declaredProfit,
      warnings,
      notes,
    );
  }
  const digital = rupees(input.digitalTurnover * p.deemedProfit44ADDigital);
  const other = rupees(input.otherTurnover * p.deemedProfit44AD);
  const basis: PresumptiveBasisLine[] = [
    {
      label: "turnover received digitally",
      amount: digital,
      working: `${inr(input.digitalTurnover)} x ${pct(p.deemedProfit44ADDigital)}`,
    },
    {
      label: "other turnover",
      amount: other,
      working: `${inr(input.otherTurnover)} x ${pct(p.deemedProfit44AD)}`,
    },
  ];
  notes.push(
    "s.44AD(4): a filer who opts out of the scheme after using it (declares less than the deemed profit) cannot use it for the next five assessment years, and gets books and audit in those years if total income exceeds the basic exemption limit",
  );
  return finish(
    "44AD",
    true,
    ceiling,
    digital + other,
    basis,
    input.declaredProfit,
    warnings,
    notes,
  );
}

function compute44ADA(
  input: Presumptive44ADAInput,
  p: RulePack["itrEligibility"]["presumptive"],
): PresumptiveResult {
  nonNegative("grossReceipts", input.grossReceipts);
  if (input.declaredProfit !== undefined) {
    nonNegative("declaredProfit", input.declaredProfit);
  }
  const warnings: string[] = [];
  const notes = [
    "s.44ADA covers only the professions it specifies (legal, medical, engineering, architecture, accountancy, technical consultancy, interior decoration and notified others) for a resident individual, HUF or partnership firm other than an LLP; this tool does not check that the filer qualifies",
  ];
  const within5 = input.cashReceiptsWithin5Pct;
  const limit = within5 ? p.receiptsCap44ADADigital : p.receiptsCap44ADA;
  const eligible = input.grossReceipts <= limit;
  const ceiling = {
    applied: limit,
    measured: input.grossReceipts,
    basis: within5
      ? `s.44ADA proviso: higher ceiling, cash receipts at most ${pct(p.cashShareLimit)} of gross receipts`
      : `s.44ADA(1): ceiling where cash receipts exceed ${pct(p.cashShareLimit)} of gross receipts`,
  };
  if (!eligible) {
    warnings.push(
      `gross receipts ${inr(input.grossReceipts)} exceed the ${inr(limit)} ceiling${within5 ? "" : `; the ${inr(p.receiptsCap44ADADigital)} ceiling needs cash receipts of at most ${pct(p.cashShareLimit)} of gross receipts`}`,
    );
    return finish(
      "44ADA",
      false,
      ceiling,
      0,
      [],
      input.declaredProfit,
      warnings,
      notes,
    );
  }
  const deemed = rupees(input.grossReceipts * p.deemedProfit44ADA);
  const basis: PresumptiveBasisLine[] = [
    {
      label: "gross receipts",
      amount: deemed,
      working: `${inr(input.grossReceipts)} x ${pct(p.deemedProfit44ADA)}`,
    },
  ];
  return finish(
    "44ADA",
    true,
    ceiling,
    deemed,
    basis,
    input.declaredProfit,
    warnings,
    notes,
  );
}

function compute44AE(
  input: Presumptive44AEInput,
  p: RulePack["itrEligibility"]["presumptive"],
): PresumptiveResult {
  if (input.declaredProfit !== undefined) {
    nonNegative("declaredProfit", input.declaredProfit);
  }
  const warnings: string[] = [];
  const notes: string[] = [];
  const basis: PresumptiveBasisLine[] = [];
  let deemed = 0;
  input.carriages.forEach((c, i) => {
    const n = i + 1;
    nonNegative(`carriages[${i}].monthsOwned`, c.monthsOwned);
    // Part month = full month (s.44AE(2)).
    const months = Math.ceil(c.monthsOwned);
    if (months > 12) {
      throw new Error(
        `carriages[${i}].monthsOwned cannot exceed 12 (got ${c.monthsOwned})`,
      );
    }
    if (months !== c.monthsOwned) {
      notes.push(
        `carriage ${n}: ${c.monthsOwned} months counted as ${months} (a part month is a full month)`,
      );
    }
    let type = c.type;
    if (
      type === "heavy" &&
      c.grossWeightTons !== undefined &&
      c.grossWeightTons > 0 &&
      c.grossWeightTons <= p.heavyVehicleAboveGrossWeightTons
    ) {
      // s.44AE Explanation: only a carriage ABOVE the weight line is heavy.
      type = "other";
      warnings.push(
        `carriage ${n}: ${c.grossWeightTons} tons is not above the ${p.heavyVehicleAboveGrossWeightTons}-ton line for a heavy goods vehicle (s.44AE Explanation), so it is priced as an other goods carriage`,
      );
    }
    if (type === "heavy") {
      if (c.grossWeightTons === undefined) {
        throw new Error(`carriages[${i}] is heavy and needs grossWeightTons`);
      }
      if (!Number.isFinite(c.grossWeightTons) || c.grossWeightTons <= 0) {
        throw new Error(
          `carriages[${i}].grossWeightTons must be positive (got ${c.grossWeightTons})`,
        );
      }
      const amount = rupees(
        c.grossWeightTons * p.deemedProfit44AEHeavyPerTonPerMonth * months,
      );
      deemed += amount;
      basis.push({
        label: `carriage ${n} (heavy)`,
        amount,
        working: `${c.grossWeightTons} tons x ${inr(p.deemedProfit44AEHeavyPerTonPerMonth)} x ${months} month(s)`,
      });
    } else {
      const amount = rupees(p.deemedProfit44AEOtherPerVehiclePerMonth * months);
      deemed += amount;
      basis.push({
        label: `carriage ${n} (other)`,
        amount,
        working: `${inr(p.deemedProfit44AEOtherPerVehiclePerMonth)} x ${months} month(s)`,
      });
    }
  });
  const count = input.maxCarriagesAtAnyTime ?? input.carriages.length;
  if (!Number.isInteger(count) || count < 0) {
    throw new Error(
      `maxCarriagesAtAnyTime must be a non-negative whole number (got ${count})`,
    );
  }
  if (input.maxCarriagesAtAnyTime === undefined) {
    notes.push(
      `maxCarriagesAtAnyTime was not given; taken as the ${count} carriage(s) listed`,
    );
  } else if (count < input.carriages.length) {
    warnings.push(
      `maxCarriagesAtAnyTime ${count} is below the ${input.carriages.length} carriages listed; check the count`,
    );
  }
  const eligible = count <= p.maxVehicles44AE;
  const ceiling = {
    applied: p.maxVehicles44AE,
    measured: count,
    basis:
      "s.44AE(1): at most this many goods carriages owned at any time in the year",
  };
  if (!eligible) {
    warnings.push(
      `${count} goods carriages owned at one time exceeds the ${p.maxVehicles44AE} allowed`,
    );
    return finish(
      "44AE",
      false,
      ceiling,
      0,
      [],
      input.declaredProfit,
      warnings,
      notes,
    );
  }
  notes.push(
    "s.44AE(2) charges each month or part of a month in which the carriage is owned, whether or not it ran",
  );
  return finish(
    "44AE",
    true,
    ceiling,
    deemed,
    basis,
    input.declaredProfit,
    warnings,
    notes,
  );
}

/** Deemed (or higher declared) profit under s.44AD, s.44ADA or s.44AE. Over the
 * ceiling it returns eligible:false with warnings rather than throwing; only
 * impossible input (negative amounts, a heavy vehicle without a weight, more
 * than 12 months) throws. */
export function computePresumptiveIncome(
  input: PresumptiveInput,
  pack: RulePack,
): PresumptiveResult {
  const p = pack.itrEligibility.presumptive;
  switch (input.scheme) {
    case "44AD":
      return compute44AD(input, p);
    case "44ADA":
      return compute44ADA(input, p);
    case "44AE":
      return compute44AE(input, p);
  }
}
