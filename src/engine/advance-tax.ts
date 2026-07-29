import type { RulePack } from "./rulepack.js";

export interface AdvanceTaxInput {
  /** Estimated total tax liability for the FY (after TDS is NOT deducted here). */
  estimatedTax: number;
  /** TDS/TCS expected to be deducted during the year. */
  tdsExpected: number;
  /** Advance tax already paid, PER installment (index 0-3), NOT cumulative:
   * [15000, 10000] means Rs 15,000 by Jun 15 and a further Rs 10,000 by Sep 15,
   * i.e. Rs 25,000 cumulative. Note the deliberate contrast with
   * `interest234C`, whose `cumulativePaid` is running totals -- 234C is defined
   * statutorily on cumulative percentages, this plan on what to pay next. */
  paidSoFar?: number[];
}

export interface Installment {
  dueDate: string;
  cumulativePct: number;
  cumulativeDue: number;
  installmentAmount: number;
  /** Running total of `paidSoFar` up to and including this installment. */
  paidCumulative: number;
  shortfall: number;
}

export interface AdvanceTaxPlan {
  fy: string;
  netLiability: number;
  advanceTaxApplicable: boolean;
  installments: Installment[];
  disclaimers: string[];
}

/** Build the June/Sep/Dec/Mar installment plan for the net advance-tax
 * liability (estimated tax minus expected TDS). */
export function scheduleAdvanceTax(
  input: AdvanceTaxInput,
  pack: RulePack,
): AdvanceTaxPlan {
  const netLiability = Math.max(
    0,
    Math.round(input.estimatedTax - input.tdsExpected),
  );
  const applicable = netLiability >= pack.advanceTax.threshold;
  const paid = input.paidSoFar ?? [];

  // FY start year, e.g. "2025-26" -> 2025; last installment lands in start+1.
  const startYear = Number.parseInt(pack.fy.slice(0, 4), 10);

  let prevCumulative = 0;
  let paidCumulative = 0;
  const installments: Installment[] = pack.advanceTax.installments.map(
    (inst, i) => {
      const cumulativeDue = Math.round(netLiability * inst.cumulativePct);
      const installmentAmount = cumulativeDue - prevCumulative;
      prevCumulative = cumulativeDue;
      paidCumulative += paid[i] ?? 0;
      const [month, day] = inst.dueDate.split("-");
      const year = inst.dueDate.startsWith("03") ? startYear + 1 : startYear;
      return {
        dueDate: `${year}-${month}-${day}`,
        cumulativePct: inst.cumulativePct,
        cumulativeDue,
        installmentAmount,
        paidCumulative,
        shortfall: Math.max(0, cumulativeDue - paidCumulative),
      };
    },
  );

  return {
    fy: pack.fy,
    netLiability,
    advanceTaxApplicable: applicable,
    installments: applicable ? installments : [],
    disclaimers: [
      "Not tax advice. 234C safe harbors (12% by Jun 15, 36% by Sep 15) and the capital-gains catch-up rule are not modeled here.",
      "Resident seniors (60+) with no business income are exempt from advance tax (s207).",
    ],
  };
}
