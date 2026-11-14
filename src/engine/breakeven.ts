import { computeTax, type Regime, type TaxInput } from "./compute.js";
import type { RulePack } from "./rulepack.js";

/** How many old-regime deductions it takes for the old regime to beat the new
 * one. Every figure comes from `computeTax`, so slabs, rebate, surcharge and
 * rounding stay in the rule pack. */

export interface RegimeBreakeven {
  newRegimeTax: number;
  oldRegimeTaxAtGiven: number;
  recommendedAtGiven: Regime;
  /** Absolute tax difference between the regimes at the given deductions. */
  savings: number;
  /** Smallest whole-rupee deductions at which old tax is at most new tax, or
   * null when no deduction amount can get there. */
  breakEvenDeductions: number | null;
  /** max(0, breakEvenDeductions - given), or null alongside a null breakeven. */
  additionalDeductionsNeeded: number | null;
  notes: string[];
}

/** `newInput` defaults to `input`. Pass it when an income figure itself
 * differs by regime: house-property income worked out per house is one, since
 * self-occupied interest is nil under s.115BAC(2)(i) and capped in the old
 * regime. Only the old-regime deductions are searched. */
export function regimeBreakeven(
  input: Omit<TaxInput, "regime">,
  pack: RulePack,
  newInput: Omit<TaxInput, "regime"> = input,
): RegimeBreakeven {
  const given = Math.max(0, Math.round(input.deductions));
  const oldTaxAt = (deductions: number): number =>
    computeTax({ ...input, regime: "old", deductions }, pack).totalTax;

  const newRegimeTax = computeTax(
    { ...newInput, regime: "new" },
    pack,
  ).totalTax;
  const oldRegimeTaxAtGiven = oldTaxAt(given);

  // Deductions only reduce normal-rate income, so nothing above the old-regime
  // normal income before deductions can lower the tax further.
  const base = computeTax({ ...input, regime: "old", deductions: 0 }, pack);
  const ceiling = Math.ceil(base.taxableNormalIncome) + 10;

  const notes: string[] = [
    "Deductions here means everything the old regime subtracts from normal income: Chapter VI-A deductions plus exemptions such as HRA. The new regime allows none of them.",
  ];
  const caps = Object.entries(pack.oldRegime.deductionCaps);
  if (caps.length > 0) {
    notes.push(
      `Old-regime caps in the rule pack (Rs): ${caps
        .map(([name, cap]) => `${name} ${cap.toLocaleString("en-IN")}`)
        .join(", ")}.`,
    );
  }

  let breakEvenDeductions: number | null = null;
  if (oldTaxAt(ceiling) <= newRegimeTax) {
    let lo = 0;
    let hi = ceiling;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (oldTaxAt(mid) <= newRegimeTax) hi = mid;
      else lo = mid + 1;
    }
    breakEvenDeductions = lo;
  } else {
    notes.push(
      "No amount of deductions makes the old regime cheaper here: even with all normal income deducted the old regime costs more, because of its lower standard deduction, its slabs, or the new-regime rebate and slab advantage. Gains taxed at special rates (111A/112A) are not reduced by deductions.",
    );
  }

  return {
    newRegimeTax,
    oldRegimeTaxAtGiven,
    recommendedAtGiven: newRegimeTax <= oldRegimeTaxAtGiven ? "new" : "old",
    savings: Math.abs(newRegimeTax - oldRegimeTaxAtGiven),
    breakEvenDeductions,
    additionalDeductionsNeeded:
      breakEvenDeductions === null
        ? null
        : Math.max(0, breakEvenDeductions - given),
    notes,
  };
}
