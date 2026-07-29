import type { RulePack } from "./rulepack.js";

/** HRA exemption calculator (Rule 2A). Old regime only -- under 115BAC the
 * HRA is fully taxable.
 *
 * exempt = least of:
 *   (a) actual HRA received for the period
 *   (b) rent paid minus 10% of salary
 *   (c) 50% of salary (metro) / 40% (elsewhere)
 *
 * "Salary" on due basis = basic + DA (only if forming part of retirement
 * benefits) + commission at a fixed percentage of turnover (Gestetner SC).
 * Computed period-wise: pass one entry per homogeneous stretch. */

export interface HraPeriod {
  months: number;
  /** Basic salary for the whole period. */
  basic: number;
  /** DA forming part of retirement benefits, for the period. */
  daRetirement?: number;
  /** Commission at a fixed % of turnover, for the period. */
  turnoverCommission?: number;
  /** HRA actually received for the period. */
  hraReceived: number;
  /** Rent actually paid for the period. */
  rentPaid: number;
  /** Metro = Delhi/Mumbai/Kolkata/Chennai for FY 2025-26 (rule pack). */
  isMetro: boolean;
}

export interface HraPeriodResult extends HraPeriod {
  salary: number;
  limbA: number;
  limbB: number;
  limbC: number;
  exempt: number;
}

export interface HraResult {
  fy: string;
  regime: "old" | "new";
  periods: HraPeriodResult[];
  totalExempt: number;
  totalTaxable: number;
  warnings: string[];
  notes: string[];
}

export function computeHra(
  periods: HraPeriod[],
  pack: RulePack,
  regime: "old" | "new" = "old",
): HraResult {
  const hra = pack.hra;

  if (regime === "new") {
    const received = periods.reduce((s, p) => s + p.hraReceived, 0);
    return {
      fy: pack.fy,
      regime,
      periods: [],
      totalExempt: 0,
      totalTaxable: received,
      warnings: [],
      notes: [
        "HRA is fully taxable under the new regime (115BAC); 80GG is also barred.",
      ],
    };
  }

  const results: HraPeriodResult[] = periods.map((p) => {
    const salary =
      p.basic + (p.daRetirement ?? 0) + (p.turnoverCommission ?? 0);
    const limbA = p.hraReceived;
    const limbB = Math.max(0, p.rentPaid - salary * hra.rentExcessOfSalaryPct);
    const limbC = salary * (p.isMetro ? hra.metroPct : hra.nonMetroPct);
    const exempt = Math.round(Math.min(limbA, limbB, limbC));
    return {
      ...p,
      salary,
      limbA,
      limbB: Math.round(limbB),
      limbC: Math.round(limbC),
      exempt,
    };
  });

  const totalExempt = results.reduce((s, r) => s + r.exempt, 0);
  const totalReceived = periods.reduce((s, p) => s + p.hraReceived, 0);

  const warnings: string[] = [];
  const annualRent = periods.reduce((s, p) => s + p.rentPaid, 0);
  if (annualRent > hra.warnings.landlordPanRentPerYear) {
    warnings.push(
      `annual rent ${annualRent} exceeds Rs ${hra.warnings.landlordPanRentPerYear} -- landlord PAN required on Form 12BB (Rule 26C)`,
    );
  }

  // months drives both checks below: amounts are PERIOD totals, so a wrong
  // month count silently mis-scales nothing in the arithmetic but does mean the
  // caller has mis-split the year.
  const totalMonths = periods.reduce((s, p) => s + p.months, 0);
  if (totalMonths !== 12) {
    warnings.push(
      `periods cover ${totalMonths} months, not 12 -- HRA is exempt only for months in which rent was actually paid, so check for a gap or an overlap`,
    );
  }
  const waiver = hra.warnings.receiptWaiverHraPerMonth;
  if (results.some((r) => r.months > 0 && r.hraReceived / r.months > waiver)) {
    warnings.push(
      `HRA above Rs ${waiver}/month in at least one period -- rent receipts are required (the no-receipt concession stops at Rs ${waiver}/month)`,
    );
  }

  return {
    fy: pack.fy,
    regime,
    periods: results,
    totalExempt,
    totalTaxable: Math.max(0, totalReceived - totalExempt),
    warnings,
    notes: [
      `metro list FY ${pack.fy}: ${hra.metroCities.join(", ")} only`,
      "salary = basic + DA (retirement-forming) + fixed-% turnover commission, on due basis",
      `${totalMonths} months covered across ${periods.length} period(s)`,
    ],
  };
}

export interface Deduction80GGInput {
  rentPaid: number;
  adjustedTotalIncome: number;
  /** Months rent was paid. The statutory limb is Rs 5,000 PER MONTH, so a part
   * year caps below Rs 60,000. Defaults to the full year. */
  months?: number;
  /** True if ANY HRA was received at any time in the year: 80GG is then barred
   * outright (s.80GG proviso), regardless of amounts. */
  hraReceivedAnyMonth?: boolean;
}

export interface Deduction80GGResult {
  fy: string;
  regime: "old" | "new";
  eligible: boolean;
  deduction: number;
  limbs: { cap: number; pctOfATI: number; rentExcess: number };
  warnings: string[];
  notes: string[];
}

/** 80GG: rent deduction when NO HRA was received at any time in the year.
 * least of: Rs 5,000 per month, 25% of adjusted total income, rent - 10% of ATI.
 * Old regime only -- 115BAC(2) bars the whole of Chapter VI-A bar 80CCD(2)/80JJAA. */
export function compute80GG(
  input: Deduction80GGInput,
  pack: RulePack,
  regime: "old" | "new" = "old",
): Deduction80GGResult {
  const cfg = pack.deduction80GG;

  const warnings: string[] = [];
  const months = input.months ?? 12;
  let eligible = true;

  if (!cfg.regimes.includes(regime)) {
    eligible = false;
    warnings.push(
      "80GG is not available under the new regime (115BAC): the deduction is nil regardless of rent paid",
    );
  }
  if (input.hraReceivedAnyMonth) {
    eligible = false;
    warnings.push(
      "80GG is barred because HRA was received during the year -- claim the HRA exemption under Rule 2A instead (the two are mutually exclusive)",
    );
  }
  if (months < 1 || months > 12) {
    warnings.push(
      `months = ${months} is outside 1-12; the per-month cap was applied as given`,
    );
  }

  // Rs 5,000 per month of rent paid, not a flat annual figure.
  const cap = Math.min(
    cfg.capPerYear,
    Math.round(cfg.capPerMonth * Math.max(0, months)),
  );
  const limbs = {
    cap,
    pctOfATI: Math.max(0, Math.round(input.adjustedTotalIncome * cfg.pctOfATI)),
    rentExcess: Math.max(
      0,
      Math.round(
        input.rentPaid - input.adjustedTotalIncome * cfg.rentExcessOfATIPct,
      ),
    ),
  };
  const deduction = eligible
    ? Math.max(0, Math.min(limbs.cap, limbs.pctOfATI, limbs.rentExcess))
    : 0;
  if (eligible && limbs.rentExcess === 0) {
    warnings.push(
      "rent paid does not exceed 10% of adjusted total income, so the third limb is nil and no 80GG deduction arises",
    );
  }

  return {
    fy: pack.fy,
    regime,
    eligible,
    deduction,
    limbs,
    warnings,
    notes: [
      "80GG requires: old regime, no HRA received at any time in the year, Form 10BA filed (acknowledgement number goes in Schedule 80GG)",
      "ATI = total income before 80GG, excluding LTCG, 111A STCG, and other Chapter VI-A deductions",
      `cap limb = Rs ${cfg.capPerMonth.toLocaleString("en-IN")}/month x ${months} month(s), subject to Rs ${cfg.capPerYear.toLocaleString("en-IN")}/year`,
      "No self-owned residential house at the work location (or any house claimed as self-occupied elsewhere) may be held by the taxpayer, spouse, or minor child.",
    ],
  };
}
