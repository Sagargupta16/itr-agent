import type { RulePack } from "./rulepack.js";

/** Sections 234A/234B/234C interest. Rounding hierarchy (verified):
 * - Rule 119A(c): interest PRINCIPAL truncates DOWN to the lower Rs 100
 *   multiple (the "fraction ignored" clause makes "nearest" a floor).
 * - Rule 119A(b): part month = FULL month.
 * - Simple interest, never compounded. */

/** Floor to the Rule 119A(c) principal multiple from the rule pack (Rs 100).
 * The pack is required: defaulting the step to 100 in code would put a statutory
 * figure outside data/*.json, where every constant is supposed to live. */
export function floor100(n: number, pack: RulePack): number {
  const step = pack.rounding.interestBase119A;
  if (step <= 0) return Math.floor(n);
  return Math.floor(n / step) * step;
}

/** A self-assessment payment under s.140A: how many months after 1 April of the
 * AY it was made (part month = full month) and how much. */
export interface SelfAssessmentPayment {
  /** Months from 1 April of the AY to the payment date, part month = full.
   * A payment on 20 July is Apr/May/Jun/Jul = 4. */
  monthsFromApril: number;
  amount: number;
}

export interface Interest234BInput {
  /** Assessed tax = tax on total income minus TDS/TCS and reliefs.
   * Advance tax is NOT deducted for the 90% test denominator. */
  assessedTax: number;
  advanceTaxPaid: number;
  /** Months from 1 April of the AY to payment/assessment, part = full.
   * Example: paid 31 Aug -> Apr..Aug = 5. */
  months: number;
  /** s.234B(2): tax paid under s.140A before the assessment stops interest on
   * the amount paid from the month of payment onward. Ordered or unordered. */
  selfAssessmentPayments?: SelfAssessmentPayment[];
}

export interface Interest234BSegment {
  fromMonth: number;
  toMonth: number;
  months: number;
  base: number;
  interest: number;
}

export interface Interest234BResult {
  applies: boolean;
  base: number;
  months: number;
  interest: number;
  /** Per-period breakdown when s.140A payments split the interest period. */
  segments: Interest234BSegment[];
  note: string;
}

export function interest234B(
  input: Interest234BInput,
  pack: RulePack,
): Interest234BResult {
  const threshold = pack.advanceTax.section234B_paidThresholdPct;
  const rate = pack.interest.ratePerMonth;
  const applies =
    input.assessedTax >= pack.advanceTax.threshold &&
    input.advanceTaxPaid < input.assessedTax * threshold;
  if (!applies) {
    return {
      applies: false,
      base: 0,
      months: 0,
      interest: 0,
      segments: [],
      note: `advance tax paid covers >= ${threshold * 100}% of assessed tax (or liability below threshold) -- no 234B`,
    };
  }

  const shortfall = Math.max(0, input.assessedTax - input.advanceTaxPaid);
  const base = floor100(shortfall, pack);

  // s.234B(2): each s.140A payment reduces the principal from its own month on.
  const payments = [...(input.selfAssessmentPayments ?? [])]
    .filter((p) => p.amount > 0 && p.monthsFromApril > 0)
    .sort((a, b) => a.monthsFromApril - b.monthsFromApril);

  const segments: Interest234BSegment[] = [];
  let outstanding = shortfall;
  let cursor = 0;
  for (const p of payments) {
    const to = Math.min(p.monthsFromApril, input.months);
    const months = Math.max(0, to - cursor);
    if (months > 0) {
      const segBase = floor100(Math.max(0, outstanding), pack);
      segments.push({
        fromMonth: cursor + 1,
        toMonth: to,
        months,
        base: segBase,
        interest: Math.round(segBase * rate * months),
      });
      cursor = to;
    }
    outstanding = Math.max(0, outstanding - p.amount);
    if (cursor >= input.months) break;
  }
  const tailMonths = Math.max(0, input.months - cursor);
  if (tailMonths > 0) {
    const segBase = floor100(Math.max(0, outstanding), pack);
    segments.push({
      fromMonth: cursor + 1,
      toMonth: input.months,
      months: tailMonths,
      base: segBase,
      interest: Math.round(segBase * rate * tailMonths),
    });
  }

  const interest = segments.reduce((s, seg) => s + seg.interest, 0);
  const note = payments.length
    ? `1%/month from 1 April of the AY, principal reduced by ${payments.length} self-assessment payment(s) under s.140A (s.234B(2)); part month = full month`
    : `1%/month on ${base} for ${input.months} month(s) from 1 April of the AY (part month = full month)`;

  return {
    applies: true,
    base,
    months: input.months,
    interest,
    segments,
    note,
  };
}

export interface Interest234AInput {
  /** Tax on total income minus TDS/TCS, advance tax, and reliefs. */
  taxOnTotalIncomeNetOfPrepaid: number;
  /** Months from the day after the due date to the date of furnishing the
   * return (or, if not furnished, to the completion of assessment). Part month
   * = full month. */
  months: number;
}

export interface Interest234AResult {
  applies: boolean;
  base: number;
  months: number;
  interest: number;
  note: string;
}

/** s.234A: 1%/month for filing the return after the due date, on the tax
 * outstanding after TDS/TCS, advance tax, and reliefs. Nil when the return is
 * on time OR when nothing is outstanding, which is why a late nil-due return
 * carries only the s.234F fee. */
export function interest234A(
  input: Interest234AInput,
  pack: RulePack,
): Interest234AResult {
  const rate = pack.interest.s234A.ratePerMonth;
  const outstanding = Math.max(0, input.taxOnTotalIncomeNetOfPrepaid);
  const months = Math.max(0, input.months);
  if (months === 0 || outstanding === 0) {
    return {
      applies: false,
      base: 0,
      months,
      interest: 0,
      note:
        months === 0
          ? "return filed on or before the due date -- no 234A"
          : "nothing outstanding after TDS/TCS/advance tax -- no 234A (the s.234F late fee can still apply)",
    };
  }
  const base = floor100(outstanding, pack);
  return {
    applies: true,
    base,
    months,
    interest: Math.round(base * rate * months),
    note: `1%/month on ${base} for ${months} month(s) from the day after the due date to the date of filing (part month = full month)`,
  };
}

export interface Interest234CInput {
  /** Tax due on RETURNED income minus TDS/TCS/reliefs. */
  taxDueOnReturnedIncome: number;
  /** Cumulative advance tax paid by each due date (Jun/Sep/Dec/Mar). */
  cumulativePaid: [number, number, number, number];
  /** Presumptive (44AD/44ADA): single installment, 100% by Mar 15. */
  presumptive?: boolean;
}

export interface Installment234C {
  due: string;
  requiredPct: number;
  required: number;
  paid: number;
  shortfall: number;
  safeHarborApplied: boolean;
  months: number;
  interest: number;
}

export interface Interest234CResult {
  applies: boolean;
  installments: Installment234C[];
  totalInterest: number;
  notes: string[];
}

export function interest234C(
  input: Interest234CInput,
  pack: RulePack,
): Interest234CResult {
  const cfg = pack.interest.s234C;
  const rate = pack.interest.ratePerMonth;
  const base = input.taxDueOnReturnedIncome;

  if (base < cfg.minLiability) {
    return {
      applies: false,
      installments: [],
      totalInterest: 0,
      notes: [
        `net liability ${base} below Rs ${cfg.minLiability} -- 234C not applicable`,
      ],
    };
  }

  const notes: string[] = [];

  if (input.presumptive) {
    const paid = input.cumulativePaid[3];
    const shortfall = Math.max(0, base - paid);
    const interest = Math.round(
      floor100(shortfall, pack) * rate * cfg.presumptive.months,
    );
    return {
      // 234C "applies" describes whether interest is chargeable, so a shortfall
      // too small to survive Rule 119A flooring is still not a charge.
      applies: interest > 0,
      installments: [
        {
          due: cfg.presumptive.due,
          requiredPct: cfg.presumptive.pct,
          required: base,
          paid,
          shortfall,
          safeHarborApplied: false,
          months: cfg.presumptive.months,
          interest,
        },
      ],
      totalInterest: interest,
      notes: ["presumptive (44AD/44ADA): single 100% installment by 15 Mar"],
    };
  }

  const installments: Installment234C[] = cfg.installments.map((inst, i) => {
    const required = Math.round(base * inst.cumulativePct);
    const paid = input.cumulativePaid[i] ?? 0;

    // Statutory safe harbors: >=12% by Jun 15 / >=36% by Sep 15 zero that
    // installment. When breached, shortfall measures from 15%/45%.
    let safeHarborApplied = false;
    if (inst.safeHarborPct !== null && paid >= base * inst.safeHarborPct) {
      safeHarborApplied = true;
    }

    const shortfall = safeHarborApplied ? 0 : Math.max(0, required - paid);
    const interest = Math.round(floor100(shortfall, pack) * rate * inst.months);
    return {
      due: inst.due,
      requiredPct: inst.cumulativePct,
      required,
      paid,
      shortfall,
      safeHarborApplied,
      months: inst.months,
      interest,
    };
  });

  notes.push(
    "capital gains / winnings / first-time business income / dividend shortfalls are excused when paid in remaining installments (first proviso) -- not modeled; exclude such income from the base for earlier installments manually",
  );

  const totalInterest = installments.reduce((s, i) => s + i.interest, 0);
  return { applies: totalInterest > 0, installments, totalInterest, notes };
}
