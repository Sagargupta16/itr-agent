import { describe, expect, it } from "vitest";
import { computeTax, slabTax } from "../src/engine/compute.js";
import { start234A, start234B } from "../src/engine/dates.js";
import { filingStatus } from "../src/engine/deadlines.js";
import { isMetroCity } from "../src/engine/hra.js";
import { availableYears, loadRulePack } from "../src/engine/rulepack.js";

// Tax year 2026-27: the first tax year under the Income-tax Act, 2025 (30 of
// 2025) as amended by the Finance Act 2026. Each figure below is read from that
// Act or the Income-tax Rules 2026; the section is cited beside it.
const pack = loadRulePack("2026-27");

const base = {
  regime: "new" as const,
  salaryIncome: 0,
  otherIncome: 0,
  stcg111A: 0,
  ltcg112A: 0,
  deductions: 0,
  ageBand: "below60" as const,
};

describe("tax year 2026-27 pack", () => {
  it("is listed and names its statute", () => {
    expect(availableYears()).toContain("2026-27");
    expect(pack.statute.act).toBe("Income-tax Act, 2025");
    expect(pack.statute.sectionMap["s.87A"]).toBe("s.156");
    expect(pack.statute.forms.salaryCertificate).toBe("Form No. 130");
    expect(pack.statute.note).toContain("Income-tax Act, 2025");
  });

  // s.202(1): nil to 4L, then 5/10/15/20/25/30% at 8, 12, 16, 20 and 24 lakh.
  it.each([
    [1200000, 60000],
    [1600000, 120000],
    [2400000, 300000],
  ])("s.202(1) slab tax on %i is %i", (income, expected) => {
    expect(slabTax(income, pack.newRegime.slabs)).toBe(expected);
  });

  it("12.75L salary pays nil: s.19 standard deduction 75,000, s.156(2)(a) rebate", () => {
    const r = computeTax({ ...base, salaryIncome: 1275000 }, pack);
    expect(r.taxableNormalIncome).toBe(1200000);
    expect(r.totalTax).toBe(0);
  });

  it("13L salary: s.156(2)(b) marginal relief limits tax to the excess over 12L", () => {
    // Total income 13,00,000 - 75,000 = 12,25,000. Slab tax 60,000 + 15% of
    // 25,000 = 63,750; relief caps it at the 25,000 above 12 lakh; cess 4% =
    // 1,000; total 26,000.
    const r = computeTax({ ...base, salaryIncome: 1300000 }, pack);
    expect(r.taxableNormalIncome).toBe(1225000);
    expect(r.totalTax).toBe(26000);
  });

  it("old regime 10L salary: Finance Act 2026 Part I-B slabs and s.19 50,000", () => {
    // 10,00,000 - 50,000 = 9,50,000. 5% of 2,50,000 = 12,500 plus 20% of
    // 4,50,000 = 90,000: 1,02,500; cess 4,100; total 1,06,600.
    const r = computeTax(
      { ...base, regime: "old", salaryIncome: 1000000 },
      pack,
    );
    expect(r.taxableNormalIncome).toBe(950000);
    expect(r.totalTax).toBe(106600);
  });

  it("interest dates follow the tax year: s.424 from 1 April 2027, s.423 from the day after the due date", () => {
    expect(start234B(pack)).toBe("2027-04-01");
    expect(start234A(pack.deadlines.itr1_2 ?? "", pack)).toBe("2027-08-01");
    expect(pack.interest.s234C.installments.map((i) => i.due)).toEqual([
      "2026-06-15",
      "2026-09-15",
      "2026-12-15",
      "2027-03-15",
    ]);
  });

  it("s.263(1)(c) due dates fall in the financial year after the tax year", () => {
    expect(pack.deadlines).toMatchObject({
      itr1_2: "2027-07-31",
      itr3_4_nonAudit: "2027-08-31",
      audit: "2027-10-31",
      belated: "2027-12-31",
      revised: "2028-03-31",
    });
  });

  it("Rule 279(1)(c): eight HRA metros, Bangalore matching Bengaluru", () => {
    expect(pack.hra.metroCities).toHaveLength(8);
    expect(isMetroCity("Pune", pack)).toBe(true);
    expect(isMetroCity("Bangalore", pack)).toBe(true);
    expect(isMetroCity("Pune", loadRulePack("2025-26"))).toBe(false);
  });

  it("covers the current year's advance tax in the filing status", () => {
    // 2026-11-14 sits in financial year 2026-27; its next s.408 instalment is
    // 15 December 2026, 31 days away.
    const s = filingStatus("2026-11-14", loadRulePack("2025-26"), pack);
    expect(s.advanceTax.covered).toBe(true);
    expect(s.advanceTax.next?.dueDate).toBe("2026-12-15");
    expect(s.advanceTax.next?.daysLeft).toBe(31);
  });
});
