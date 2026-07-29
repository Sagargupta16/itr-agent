import { describe, expect, it } from "vitest";
import { scheduleAdvanceTax } from "../src/engine/advance-tax.js";
import { computeTax, slabTax } from "../src/engine/compute.js";
import { loadRulePack } from "../src/engine/rulepack.js";

const pack = loadRulePack("2025-26");

const base = {
  regime: "new" as const,
  salaryIncome: 0,
  otherIncome: 0,
  stcg111A: 0,
  ltcg112A: 0,
  deductions: 0,
  ageBand: "below60" as const,
};

describe("new regime slab tax (FY 2025-26)", () => {
  // Cumulative checkpoints published on incometax.gov.in
  it.each([
    [1200000, 60000],
    [1600000, 120000],
    [2000000, 200000],
    [2400000, 300000],
  ])("slab tax on %i is %i", (income, expected) => {
    expect(slabTax(income, pack.newRegime.slabs)).toBe(expected);
  });
});

describe("computeTax new regime", () => {
  it("12L salary pays zero (87A rebate, after 75K standard deduction)", () => {
    const r = computeTax({ ...base, salaryIncome: 1200000 }, pack);
    expect(r.taxableNormalIncome).toBe(1125000);
    expect(r.totalTax).toBe(0);
  });

  it("12.75L salary pays zero (standard deduction brings it to 12L)", () => {
    const r = computeTax({ ...base, salaryIncome: 1275000 }, pack);
    expect(r.taxableNormalIncome).toBe(1200000);
    expect(r.rebate87A).toBe(60000);
    expect(r.totalTax).toBe(0);
  });

  it("12,10,000 taxable income pays 10,000 + cess via marginal relief", () => {
    // Golden case from published worked examples: slab tax 61,500 but
    // marginal relief caps payable at income - 12L = 10,000 (plus 4% cess).
    const r = computeTax({ ...base, otherIncome: 1210000 }, pack);
    expect(r.taxableNormalIncome).toBe(1210000);
    expect(r.slabTax).toBe(61500);
    expect(r.taxBeforeSurcharge).toBe(10000);
    expect(r.totalTax).toBe(10400);
  });

  it("marginal relief exhausts at 12,70,588 (exact crossover, both sides pinned)", () => {
    // Relief binds while slab tax exceeds the income above 12L:
    //   60,000 + 0.15x = x  ->  x = 70,588.24, i.e. income 12,70,588.24.
    // s.288A rounds income to a multiple of ten, so the last binding income is
    // 12,70,580 and the first non-binding one is 12,70,590.
    const binding = computeTax({ ...base, otherIncome: 1270580 }, pack);
    expect(binding.taxableNormalIncome).toBe(1270580);
    expect(binding.slabTax).toBe(70587); // 60,000 + 15% of 70,580
    expect(binding.rebate87A).toBe(7); // relief shaves it to the excess
    expect(binding.taxBeforeSurcharge).toBe(70580);

    const past = computeTax({ ...base, otherIncome: 1270590 }, pack);
    expect(past.slabTax).toBe(70589); // 70,588.50 rounded for display
    expect(past.rebate87A).toBe(0);
    expect(past.taxBeforeSurcharge).toBe(70589);
    // s.288B: 70,588.50 + 4% cess = 73,412.04, rounded to the nearest ten.
    expect(past.totalTax).toBe(73410);
  });

  it("s.288A/288B round income and tax payable to the nearest ten", () => {
    // 15,00,007 of income rounds to 15,00,010 before the slabs are applied.
    const r = computeTax({ ...base, otherIncome: 1500007 }, pack);
    expect(r.taxableNormalIncome).toBe(1500010);
    // 60,000 + 15% of 3,00,010 = 1,05,001.50; +4% cess = 1,09,201.56.
    expect(r.slabTax).toBe(105002);
    expect(r.totalTax).toBe(109200);
    expect(r.totalTax % 10).toBe(0);
  });

  it("87A rebate never offsets capital gains tax", () => {
    // 8L normal income (within rebate) + LTCG: normal tax rebated, CG tax stays.
    const r = computeTax(
      { ...base, otherIncome: 800000, ltcg112A: 500000 },
      pack,
    );
    expect(r.rebate87A).toBeGreaterThan(0);
    // LTCG: (5,00,000 - 1,25,000) * 12.5% = 46,875
    expect(r.ltcgTax).toBe(46875);
    expect(r.taxBeforeSurcharge).toBe(46875);
  });

  it("applies 111A at 20% and 112A at 12.5% above the 1.25L exemption", () => {
    const r = computeTax(
      { ...base, otherIncome: 2000000, stcg111A: 100000, ltcg112A: 225000 },
      pack,
    );
    expect(r.stcgTax).toBe(20000);
    expect(r.taxableLtcg112A).toBe(100000);
    expect(r.ltcgTax).toBe(12500);
  });
});

describe("computeTax old regime", () => {
  it("uses old slabs, 50K standard deduction, and deductions", () => {
    const r = computeTax(
      { ...base, regime: "old", salaryIncome: 1000000, deductions: 150000 },
      pack,
    );
    // taxable = 10,00,000 - 50,000 - 1,50,000 = 8,00,000
    expect(r.taxableNormalIncome).toBe(800000);
    // old slabs: 2.5L nil + 2.5L@5% (12,500) + 3L@20% (60,000) = 72,500
    expect(r.slabTax).toBe(72500);
    expect(r.totalTax).toBe(Math.round(72500 * 1.04));
  });

  it("87A under old regime: 5L total income pays zero", () => {
    const r = computeTax({ ...base, regime: "old", otherIncome: 500000 }, pack);
    expect(r.rebate87A).toBe(12500);
    expect(r.totalTax).toBe(0);
  });

  it("old regime has no marginal relief on 87A", () => {
    const r = computeTax({ ...base, regime: "old", otherIncome: 510000 }, pack);
    expect(r.rebate87A).toBe(0);
    expect(r.slabTax).toBe(14500);
  });
});

describe("old regime age bands", () => {
  const old = { ...base, regime: "old" as const, otherIncome: 600000 };

  // The higher basic exemption for seniors is a WIDER NIL SLAB, not a deduction
  // from income. Pinning taxableNormalIncome catches a regression to the old
  // behaviour (which subtracted the exemption and so under-taxed by a slab).
  it.each([
    ["below60" as const, 32500, 33800], // 2.5L nil + 2.5L@5% + 1L@20%
    ["senior" as const, 30000, 31200], // 3L nil + 2L@5% + 1L@20%
    ["superSenior" as const, 20000, 20800], // 5L nil + 1L@20%
  ])(
    "%s pays %i slab tax on 6L without shrinking income",
    (ageBand, slab, total) => {
      const r = computeTax({ ...old, ageBand }, pack);
      expect(r.taxableNormalIncome).toBe(600000);
      expect(r.slabTax).toBe(slab);
      expect(r.totalTax).toBe(total);
    },
  );

  it("115BAC has one slab set for every age", () => {
    const young = computeTax({ ...base, otherIncome: 1600000 }, pack);
    const superSenior = computeTax(
      { ...base, otherIncome: 1600000, ageBand: "superSenior" },
      pack,
    );
    expect(young.slabTax).toBe(120000);
    expect(superSenior.totalTax).toBe(young.totalTax);
  });
});

describe("surcharge", () => {
  it("10% band above 50L, relief not binding", () => {
    const r = computeTax({ ...base, otherIncome: 6000000 }, pack);
    expect(r.slabTax).toBe(1380000);
    expect(r.surchargeRatePct).toBe(10);
    expect(r.surcharge).toBe(138000);
    expect(r.totalTax).toBe(1578720);
  });

  it("marginal relief caps tax + surcharge at the threshold figure + excess", () => {
    // Rs 10,000 past the 50L threshold: the whole surcharge collapses to the
    // Rs 10,000 of extra income (10,80,000 at 50L -> 10,90,000 here).
    const r = computeTax({ ...base, otherIncome: 5010000 }, pack);
    expect(r.slabTax).toBe(1083000);
    expect(r.surcharge).toBe(7000);
    expect(r.taxBeforeSurcharge + r.surcharge).toBe(1090000);
    expect(r.totalTax).toBe(1133600);
  });

  it("relief compares tax AND surcharge at the threshold, not surcharge alone", () => {
    // Old regime, Rs 1,00,000 past the 5cr / 37% threshold. At 5cr the figure is
    // 1,48,12,500 tax + 37,03,125 surcharge (25% band) = 1,85,15,625, so the
    // ceiling here is that + 1,00,000. Comparing surcharge alone would leave the
    // full 54,91,725 standing.
    const r = computeTax(
      { ...base, regime: "old", otherIncome: 50100000 },
      pack,
    );
    expect(r.surchargeRatePct).toBe(37);
    expect(r.slabTax).toBe(14842500);
    expect(r.surcharge).toBe(3773125);
    expect(r.taxBeforeSurcharge + r.surcharge).toBe(18615625);
    expect(r.totalTax).toBe(19360250);
  });

  it("25%/37% bands ignore 111A/112A income (First Schedule Para A)", () => {
    // 60L normal + 5cr of 112A gains = 5.6cr total, but the enhanced bands test
    // only the 60L, so the residual 15% clause applies -- not 37%.
    const r = computeTax(
      { ...base, regime: "old", otherIncome: 6000000, ltcg112A: 50000000 },
      pack,
    );
    expect(r.surchargeRatePct).toBe(15);
    expect(r.surcharge).toBe(1177031);
  });

  it("37% does apply when normal income alone crosses 5cr", () => {
    const r = computeTax(
      { ...base, regime: "old", otherIncome: 60000000 },
      pack,
    );
    expect(r.surchargeRatePct).toBe(37);
    expect(r.surcharge).toBe(6590625);
  });

  it("gains carry a 15% surcharge cap while normal income pays 25%", () => {
    // 7,312,500 normal tax @25% + 109,375 of LTCG tax @15% (not 25%).
    const r = computeTax(
      { ...base, regime: "old", otherIncome: 25000000, ltcg112A: 1000000 },
      pack,
    );
    expect(r.surchargeRatePct).toBe(25);
    expect(r.ltcgTax).toBe(109375);
    expect(r.surcharge).toBe(1844531);
  });

  it("115BAC caps surcharge at 25%, so the 37% band never bites", () => {
    const r = computeTax({ ...base, otherIncome: 60000000 }, pack);
    expect(r.surchargeRatePct).toBe(25);
    expect(r.surcharge).toBe(4395000);
  });
});

describe("87A vs 111A under the new regime (mutation guard)", () => {
  it("flipping allowAgainst111A changes the answer", () => {
    // 5L normal + 5L of 111A STCG. Finance Act 2025 bars 87A from touching the
    // STCG, so only the Rs 5,000 of slab tax is rebated. If the rule pack ever
    // says otherwise, 55,000 of the STCG tax disappears and this test fails --
    // which is what makes the CLAUDE.md "tests pin this" claim true.
    const input = { ...base, otherIncome: 500000, stcg111A: 500000 };
    const real = computeTax(input, pack);
    expect(real.rebate87A).toBe(5000);
    expect(real.stcgTax).toBe(100000);
    expect(real.taxBeforeSurcharge).toBe(100000);

    const mutated = structuredClone(pack);
    mutated.newRegime.rebate87A.allowAgainst111A = true;
    const wrong = computeTax(input, mutated);
    expect(wrong.rebate87A).toBe(60000);
    expect(wrong.stcgTax).toBe(45000);
    expect(wrong.taxBeforeSurcharge).not.toBe(real.taxBeforeSurcharge);
  });
});

describe("scheduleAdvanceTax", () => {
  it("splits 1L net liability into 15/45/75/100 installments", () => {
    const plan = scheduleAdvanceTax(
      { estimatedTax: 100000, tdsExpected: 0 },
      pack,
    );
    expect(plan.advanceTaxApplicable).toBe(true);
    expect(plan.installments.map((i) => i.cumulativeDue)).toEqual([
      15000, 45000, 75000, 100000,
    ]);
    expect(plan.installments.map((i) => i.installmentAmount)).toEqual([
      15000, 30000, 30000, 25000,
    ]);
    expect(plan.installments[0]?.dueDate).toBe("2025-06-15");
    expect(plan.installments[3]?.dueDate).toBe("2026-03-15");
  });

  it("not applicable below the 10K threshold", () => {
    const plan = scheduleAdvanceTax(
      { estimatedTax: 50000, tdsExpected: 45000 },
      pack,
    );
    expect(plan.advanceTaxApplicable).toBe(false);
    expect(plan.installments).toEqual([]);
  });

  it("tracks shortfalls against payments", () => {
    const plan = scheduleAdvanceTax(
      { estimatedTax: 100000, tdsExpected: 0, paidSoFar: [15000, 10000] },
      pack,
    );
    expect(plan.installments[0]?.shortfall).toBe(0);
    expect(plan.installments[1]?.shortfall).toBe(20000);
  });
});
