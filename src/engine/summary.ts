import {
  computeTax,
  roundToNearest,
  type TaxBreakdown,
  type TaxInput,
} from "./compute.js";
import { interestMonths, parseIsoDate, start234A, start234B } from "./dates.js";
import {
  type Interest234AResult,
  type Interest234BResult,
  type Interest234CResult,
  interest234A,
  interest234B,
  interest234C,
  type SelfAssessmentPayment,
} from "./interest.js";
import type { RulePack } from "./rulepack.js";

/** One "what do I owe" computation: tax, 234A/234B/234C interest and the 234F
 * fee chained from dates, so the caller never subtracts TDS or counts months. */

export interface DatedPayment {
  /** YYYY-MM-DD. */
  date: string;
  amount: number;
}

export interface TaxSummaryInput {
  tax: TaxInput;
  /** Creditable TDS (Form 26AS booking status F). */
  tdsCredit: number;
  tcsCredit: number;
  advanceTaxPayments: DatedPayment[];
  /** Tax paid under s.140A before filing. */
  selfAssessmentPayments?: DatedPayment[];
  /** Date the return is (or will be) furnished, YYYY-MM-DD. */
  filingDate: string;
  /** s.139(1) due date for the ITR form in use, YYYY-MM-DD. */
  dueDate: string;
  /** 44AD/44ADA: single advance tax instalment. */
  presumptive?: boolean;
  /** s.207(2): a resident senior citizen with no income from business or
   * profession pays no advance tax, so s.234B and s.234C do not apply. */
  advanceTaxExempt?: boolean;
}

export interface InterestPeriod {
  from: string;
  to: string;
  months: number;
}

export interface TaxSummary {
  tax: TaxBreakdown;
  totalTax: number;
  tdsCredit: number;
  tcsCredit: number;
  advanceTaxPaid: number;
  selfAssessmentPaid: number;
  /** Tax after TDS and TCS: the base for 234B and 234C. */
  assessedTax: number;
  filedLate: boolean;
  s234A: Interest234AResult;
  s234B: Interest234BResult;
  s234C: Interest234CResult;
  /** s.234F late fee, 0 when the return is on time. */
  fee234F: number;
  interestTotal: number;
  /** Months and date ranges each section used. */
  periods: {
    s234A: InterestPeriod | null;
    s234B: InterestPeriod;
    selfAssessmentMonthsFromApril: { date: string; monthsFromApril: number }[];
    /** Advance tax paid on or before each 234C due date, cumulative. */
    s234CCumulativePaid: { due: string; paid: number }[];
  };
  /** totalTax + interest + fee - TDS - TCS - advance - self-assessment, before s.288B. */
  netBeforeRounding: number;
  /** After s.288B rounding; negative is a refund. */
  net: number;
  payable: number;
  refund: number;
  notes: string[];
  warnings: string[];
  disclaimers: string[];
}

function requireIso(value: string, label: string): void {
  if (!parseIsoDate(value)) {
    throw new Error(
      `${label} must be a real date as YYYY-MM-DD, got "${value}"`,
    );
  }
}

function requireAmount(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative number, got ${value}`);
  }
}

function sum(payments: DatedPayment[]): number {
  return payments.reduce((s, p) => s + p.amount, 0);
}

export function computeTaxSummary(
  input: TaxSummaryInput,
  pack: RulePack,
): TaxSummary {
  requireIso(input.filingDate, "filingDate");
  requireIso(input.dueDate, "dueDate");
  requireAmount(input.tdsCredit, "tdsCredit");
  requireAmount(input.tcsCredit, "tcsCredit");
  const saInput = input.selfAssessmentPayments ?? [];
  for (const p of [...input.advanceTaxPayments, ...saInput]) {
    requireIso(p.date, "payment date");
    requireAmount(p.amount, "payment amount");
  }

  const notes: string[] = [];
  const warnings: string[] = [];
  const partFull = pack.interest.partMonthIsFullMonth;
  const from234B = start234B(pack);

  const tax = computeTax(input.tax, pack);
  const totalTax = tax.totalTax;
  const assessedTax = Math.max(0, totalTax - input.tdsCredit - input.tcsCredit);

  // Advance tax is what is paid before the AY starts; a payment dated on or
  // after 1 April of the AY is a s.140A payment whatever it was called.
  const advance = input.advanceTaxPayments.filter((p) => p.date < from234B);
  const lateAdvance = input.advanceTaxPayments.filter(
    (p) => p.date >= from234B,
  );
  if (lateAdvance.length > 0) {
    warnings.push(
      `${lateAdvance.length} advance tax payment(s) are dated on or after ${from234B}; they are treated as self-assessment tax under s.140A, not advance tax`,
    );
  }
  const selfAssessment = [...saInput, ...lateAdvance];
  const advanceTaxPaid = sum(advance);
  const selfAssessmentPaid = sum(selfAssessment);

  // 234C: cumulative advance tax paid on or before each due date.
  const cfg = pack.interest.s234C;
  const paidBy = (due: string): number =>
    sum(advance.filter((p) => p.date <= due));
  const cumulativeRows = cfg.installments.map((i) => ({
    due: i.due,
    paid: paidBy(i.due),
  }));
  const cumulativePaid: [number, number, number, number] = [
    cumulativeRows[0]?.paid ?? 0,
    cumulativeRows[1]?.paid ?? 0,
    cumulativeRows[2]?.paid ?? 0,
    cumulativeRows[3]?.paid ?? 0,
  ];
  if (input.presumptive) cumulativePaid[3] = paidBy(cfg.presumptive.due);
  // s.207(2): no advance tax liability means nothing for 234B or 234C to
  // measure a shortfall against.
  const advanceBase = input.advanceTaxExempt ? 0 : assessedTax;
  if (input.advanceTaxExempt) {
    notes.push(
      "s.207(2): a resident senior citizen with no business or professional income is not liable to advance tax, so no s.234B or s.234C interest is charged.",
    );
  }
  const s234C = interest234C(
    {
      taxDueOnReturnedIncome: advanceBase,
      cumulativePaid,
      ...(input.presumptive ? { presumptive: true } : {}),
    },
    pack,
  );

  // 234B: months from 1 April of the AY to filing; each s.140A payment from
  // its own month.
  const months234B = interestMonths(from234B, input.filingDate, partFull);
  const saMonths: SelfAssessmentPayment[] = selfAssessment.map((p) => ({
    monthsFromApril: interestMonths(from234B, p.date, partFull),
    amount: p.amount,
  }));
  const s234B = interest234B(
    {
      assessedTax: advanceBase,
      advanceTaxPaid,
      months: months234B,
      ...(saMonths.length > 0 ? { selfAssessmentPayments: saMonths } : {}),
    },
    pack,
  );

  // 234A: only when filed after the due date, on tax after TDS/TCS and
  // advance tax. Self-assessment tax paid before the due date is not netted.
  const filedLate = input.filingDate > input.dueDate;
  let periodA: InterestPeriod | null = null;
  let s234A: Interest234AResult;
  if (filedLate) {
    const from234A = start234A(input.dueDate, pack);
    const months234A = interestMonths(from234A, input.filingDate, partFull);
    periodA = { from: from234A, to: input.filingDate, months: months234A };
    s234A = interest234A(
      {
        taxOnTotalIncomeNetOfPrepaid: Math.max(0, assessedTax - advanceTaxPaid),
        months: months234A,
      },
      pack,
    );
    if (selfAssessment.some((p) => p.date < input.filingDate)) {
      notes.push(
        "s.234A here is charged on tax after TDS, TCS and advance tax only, for every month to the filing date; self-assessment tax paid before filing is not netted. Where it was paid on or before the due date, the Supreme Court held that no interest runs on it (CIT v Prannoy Roy), and the portal may charge less for tax paid between the due date and filing too; check the portal figure.",
      );
    }
  } else {
    s234A = interest234A({ taxOnTotalIncomeNetOfPrepaid: 0, months: 0 }, pack);
  }

  // 234F: lower fee at or below the income threshold.
  let fee234F = 0;
  if (filedLate) {
    fee234F =
      tax.totalIncome <= pack.lateFee234F.incomeThreshold
        ? pack.lateFee234F.incomeUpTo5L
        : pack.lateFee234F.default;
    notes.push(`s.234F late fee ${fee234F} for filing after ${input.dueDate}`);
    const belated = pack.deadlines.belated;
    if (belated && input.filingDate > belated) {
      warnings.push(
        `filing date is after ${belated}, the last date for a belated return under s.139(4); only an updated return (s.139(8A)) remains`,
      );
    }
  }

  const interestTotal = s234A.interest + s234B.interest + s234C.totalInterest;
  const netBeforeRounding =
    totalTax +
    interestTotal +
    fee234F -
    input.tdsCredit -
    input.tcsCredit -
    advanceTaxPaid -
    selfAssessmentPaid;
  // s.288B rounds the amount payable OR refundable, fives going up: round
  // the magnitude, so a refund of 15 is 20 like a payable of 15.
  const net =
    Math.sign(netBeforeRounding) *
      roundToNearest(
        Math.abs(netBeforeRounding),
        pack.rounding.taxPayable288B,
      ) || 0;

  notes.push(s234A.note, s234B.note, ...s234C.notes);

  return {
    tax,
    totalTax,
    tdsCredit: input.tdsCredit,
    tcsCredit: input.tcsCredit,
    advanceTaxPaid,
    selfAssessmentPaid,
    assessedTax,
    filedLate,
    s234A,
    s234B,
    s234C,
    fee234F,
    interestTotal,
    periods: {
      s234A: periodA,
      s234B: { from: from234B, to: input.filingDate, months: months234B },
      selfAssessmentMonthsFromApril: selfAssessment.map((p, i) => ({
        date: p.date,
        monthsFromApril: saMonths[i]?.monthsFromApril ?? 0,
      })),
      s234CCumulativePaid: input.presumptive
        ? [{ due: cfg.presumptive.due, paid: cumulativePaid[3] }]
        : cumulativeRows,
    },
    netBeforeRounding,
    net,
    payable: Math.max(0, net),
    refund: Math.max(0, -net),
    notes,
    warnings,
    disclaimers: [
      ...tax.disclaimers,
      "Interest and fee are computed from the dates given; the portal's own figure at filing is the one that counts.",
    ],
  };
}
