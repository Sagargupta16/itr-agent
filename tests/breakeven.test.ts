import { describe, expect, it } from "vitest";
import { regimeBreakeven } from "../src/engine/breakeven.js";
import { computeTax } from "../src/engine/compute.js";
import { loadRulePack } from "../src/engine/rulepack.js";

const pack = loadRulePack("2025-26");

const base = {
  salaryIncome: 0,
  otherIncome: 0,
  stcg111A: 0,
  ltcg112A: 0,
  deductions: 0,
  ageBand: "below60" as const,
};

/** The contract, proved with computeTax itself: old tax at the breakeven is at
 * most the new-regime tax, and one rupee less is strictly more. */
function expectContract(input: typeof base) {
  const r = regimeBreakeven(input, pack);
  const { regime: _r, ...rest } = { ...input, regime: "old" as const };
  const oldAt = (deductions: number) =>
    computeTax({ ...rest, regime: "old", deductions }, pack).totalTax;
  const newTax = computeTax({ ...input, regime: "new" }, pack).totalTax;
  expect(r.newRegimeTax).toBe(newTax);
  expect(r.breakEvenDeductions).not.toBeNull();
  const be = r.breakEvenDeductions as number;
  expect(oldAt(be)).toBeLessThanOrEqual(newTax);
  expect(be).toBeGreaterThan(0);
  expect(oldAt(be - 1)).toBeGreaterThan(newTax);
  return r;
}

describe("regimeBreakeven contract", () => {
  it("12.75 lakh salary: new regime tax is nil, old needs taxable income of 5 lakh", () => {
    const r = expectContract({ ...base, salaryIncome: 1275000 });
    expect(r.newRegimeTax).toBe(0);
    expect(r.recommendedAtGiven).toBe("new");
    expect(r.additionalDeductionsNeeded).toBe(r.breakEvenDeductions);
  });

  it("18 lakh salary with 3.75 lakh given", () => {
    const r = expectContract({
      ...base,
      salaryIncome: 1800000,
      deductions: 375000,
    });
    expect(r.oldRegimeTaxAtGiven).toBeGreaterThan(r.newRegimeTax);
    expect(r.additionalDeductionsNeeded).toBe(
      (r.breakEvenDeductions as number) - 375000,
    );
  });

  it("50 lakh salary", () => {
    expectContract({ ...base, salaryIncome: 5000000 });
  });
});

describe("regimeBreakeven edge cases", () => {
  it("needs nothing more when the old regime already wins", () => {
    // Rs 20 lakh salary with Rs 10 lakh of deductions drops old taxable income
    // to Rs 9.5 lakh, well under the new regime's tax on Rs 19.25 lakh.
    const r = regimeBreakeven(
      { ...base, salaryIncome: 2000000, deductions: 1000000 },
      pack,
    );
    expect(r.recommendedAtGiven).toBe("old");
    expect(r.additionalDeductionsNeeded).toBe(0);
    expect(r.breakEvenDeductions).toBeLessThan(1000000);
  });

  it("returns null when no deduction can win", () => {
    // Pack mutated so the old regime has no nil band at all: Rs 3 lakh of 111A
    // gains are fully covered by the new regime's basic-exemption set-off (nil
    // tax) but fully taxed under the old one, whatever is deducted.
    const hostile = {
      ...pack,
      oldRegime: { ...pack.oldRegime, slabs: [{ upTo: null, rate: 0.3 }] },
    };
    const r = regimeBreakeven({ ...base, stcg111A: 300000 }, hostile);
    expect(r.newRegimeTax).toBe(0);
    expect(r.breakEvenDeductions).toBeNull();
    expect(r.additionalDeductionsNeeded).toBeNull();
    expect(r.notes.join(" ")).toContain("No amount of deductions");
  });

  it("lists the pack's deduction caps in the notes", () => {
    const r = regimeBreakeven({ ...base, salaryIncome: 1500000 }, pack);
    for (const name of Object.keys(pack.oldRegime.deductionCaps)) {
      expect(r.notes.join(" ")).toContain(name);
    }
  });
});

describe("regimeBreakeven hand-worked figure", () => {
  it("Rs 15 lakh salary breaks even near Rs 5,43,750 of deductions", () => {
    // New regime (s.115BAC slabs): taxable = 15,00,000 - 75,000 = 14,25,000.
    //   4-8L at 5%   = 20,000
    //   8-12L at 10% = 40,000
    //   12-14.25L at 15% = 2,25,000 x 15% = 33,750
    //   tax 93,750; x 1.04 cess = 97,500. Above 12L, so no s.87A rebate.
    // Old regime: taxable T = 15,00,000 - 50,000 - D = 14,50,000 - D.
    //   0-2.5L nil; 2.5-5L at 5% = 12,500; 5-10L at 20%; above 10L at 30%.
    //   Over 10L the tax is at least 1,12,500, more than 93,750, so T <= 10L:
    //   12,500 + 20% x (T - 5,00,000) <= 93,750 gives T <= 9,06,250,
    //   i.e. D >= 5,43,750; at T = 9,06,250 tax 93,750 x 1.04 = 97,500 = new.
    // Two roundings move the whole-rupee answer: s.288A rounds total income to
    //   the nearest ten and s.288B rounds the tax to the nearest ten. At
    //   T = 9,06,270: 12,500 + 20% x 4,06,270 = 93,754; x 1.04 = 97,504.2 ->
    //   97,500, a tie. At T = 9,06,280 the tax is 97,506.3 -> 97,510, a loss.
    //   D = 5,43,726 gives T = 9,06,274 -> 9,06,270, the smallest whole-rupee D.
    const r = regimeBreakeven({ ...base, salaryIncome: 1500000 }, pack);
    expect(r.newRegimeTax).toBe(97500);
    expect(r.breakEvenDeductions).toBe(543726);
    const old = computeTax(
      { ...base, regime: "old", salaryIncome: 1500000, deductions: 543750 },
      pack,
    );
    expect(old.totalTax).toBe(97500);
  });
});
