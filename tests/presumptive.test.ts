import { describe, expect, it } from "vitest";
import { computePresumptiveIncome } from "../src/engine/presumptive.js";
import { loadRulePack } from "../src/engine/rulepack.js";

const pack = loadRulePack("2025-26");

// Every case below is hand-worked from the section named; the rates and
// ceilings are the pack's (8% / 6% / 50%, Rs 1,000 per ton, Rs 7,500).

describe("s.44AD", () => {
  it("mixed digital and cash turnover, flag derived (hand-worked from s.44AD(1))", () => {
    // turnover 1,00,00,000 + 50,00,000 = 1,50,00,000, under the 2 crore ceiling
    // (cash share 33%, so the 3 crore ceiling is not in play)
    // digital 1,00,00,000 x 6% = 6,00,000; other 50,00,000 x 8% = 4,00,000
    const r = computePresumptiveIncome(
      { scheme: "44AD", digitalTurnover: 10000000, otherTurnover: 5000000 },
      pack,
    );
    expect(r.eligible).toBe(true);
    expect(r.ceiling.applied).toBe(20000000);
    expect(r.basis.map((b) => b.amount)).toEqual([600000, 400000]);
    expect(r.deemedIncome).toBe(1000000);
    expect(r.incomeToReport).toBe(1000000);
    expect(r.forComputeTax).toEqual({ otherIncome: 1000000 });
    expect(r.notes.join(" ")).toContain("derived");
    expect(r.notes.join(" ")).toContain("s.44AD(4)");
  });

  it("just over 2 crore with cash above 5%: scheme unavailable (hand-worked from s.44AD(1))", () => {
    // 1,50,00,000 + 55,00,000 = 2,05,00,000 > 2,00,00,000; cash share 26.8%
    const r = computePresumptiveIncome(
      { scheme: "44AD", digitalTurnover: 15000000, otherTurnover: 5500000 },
      pack,
    );
    expect(r.eligible).toBe(false);
    expect(r.ceiling.applied).toBe(20000000);
    expect(r.deemedIncome).toBe(0);
    expect(r.incomeToReport).toBe(0);
    expect(r.warnings.join(" ")).toContain("ITR-3");
  });

  it("just over 2 crore with cash within 5%: 3 crore ceiling applies (hand-worked from s.44AD(1) proviso)", () => {
    // 1,95,00,000 + 10,00,000 = 2,05,00,000; cash 10/205 = 4.88%, within 5%
    // 1,95,00,000 x 6% = 11,70,000; 10,00,000 x 8% = 80,000; total 12,50,000
    const r = computePresumptiveIncome(
      { scheme: "44AD", digitalTurnover: 19500000, otherTurnover: 1000000 },
      pack,
    );
    expect(r.eligible).toBe(true);
    expect(r.ceiling.applied).toBe(30000000);
    expect(r.deemedIncome).toBe(1250000);
  });

  it("an explicit flag wins, and a flag the figures contradict warns", () => {
    // 1,00,00,000 + 50,00,000 with the flag forced true: 3 crore ceiling
    const r = computePresumptiveIncome(
      {
        scheme: "44AD",
        digitalTurnover: 10000000,
        otherTurnover: 5000000,
        cashReceiptsWithin5Pct: true,
      },
      pack,
    );
    expect(r.ceiling.applied).toBe(30000000);
    expect(r.warnings.join(" ")).toContain("check the flag");
    expect(r.notes.join(" ")).not.toContain("derived");
  });
});

describe("s.44ADA", () => {
  it("50% of gross receipts (hand-worked from s.44ADA(1))", () => {
    // 40,00,000 x 50% = 20,00,000, under the 50 lakh ceiling
    const r = computePresumptiveIncome(
      {
        scheme: "44ADA",
        grossReceipts: 4000000,
        cashReceiptsWithin5Pct: false,
      },
      pack,
    );
    expect(r.eligible).toBe(true);
    expect(r.ceiling.applied).toBe(5000000);
    expect(r.deemedIncome).toBe(2000000);
    expect(r.forComputeTax).toEqual({ otherIncome: 2000000 });
  });

  it("60 lakh needs the 5% cash condition (hand-worked from s.44ADA proviso)", () => {
    // with the condition: 75 lakh ceiling, 60,00,000 x 50% = 30,00,000
    const ok = computePresumptiveIncome(
      { scheme: "44ADA", grossReceipts: 6000000, cashReceiptsWithin5Pct: true },
      pack,
    );
    expect(ok.eligible).toBe(true);
    expect(ok.deemedIncome).toBe(3000000);
    // without it: over the 50 lakh ceiling
    const no = computePresumptiveIncome(
      {
        scheme: "44ADA",
        grossReceipts: 6000000,
        cashReceiptsWithin5Pct: false,
      },
      pack,
    );
    expect(no.eligible).toBe(false);
    expect(no.deemedIncome).toBe(0);
  });
});

describe("s.44AE", () => {
  it("heavy and other carriages with a part month (hand-worked from s.44AE(2))", () => {
    // heavy 16 t, 12 months: 16 x 1,000 x 12 = 1,92,000
    // heavy 20 t, 4.5 months counts as 5: 20 x 1,000 x 5 = 1,00,000
    // other, 7 months: 7,500 x 7 = 52,500
    // total 3,44,500
    const r = computePresumptiveIncome(
      {
        scheme: "44AE",
        carriages: [
          { type: "heavy", grossWeightTons: 16, monthsOwned: 12 },
          { type: "heavy", grossWeightTons: 20, monthsOwned: 4.5 },
          { type: "other", monthsOwned: 7 },
        ],
      },
      pack,
    );
    expect(r.eligible).toBe(true);
    expect(r.basis.map((b) => b.amount)).toEqual([192000, 100000, 52500]);
    expect(r.deemedIncome).toBe(344500);
    expect(r.ceiling).toMatchObject({ applied: 10, measured: 3 });
    expect(r.notes.join(" ")).toContain("part month");
  });

  it("11 carriages is over the limit (s.44AE(1))", () => {
    const r = computePresumptiveIncome(
      {
        scheme: "44AE",
        carriages: Array.from({ length: 11 }, () => ({
          type: "other" as const,
          monthsOwned: 12,
        })),
      },
      pack,
    );
    expect(r.eligible).toBe(false);
    expect(r.ceiling).toMatchObject({ applied: 10, measured: 11 });
    expect(r.deemedIncome).toBe(0);
  });

  it("the most owned at any time can exceed the list (s.44AE(1))", () => {
    const r = computePresumptiveIncome(
      {
        scheme: "44AE",
        carriages: [{ type: "other", monthsOwned: 12 }],
        maxCarriagesAtAnyTime: 11,
      },
      pack,
    );
    expect(r.eligible).toBe(false);
  });

  it("a 12-ton carriage called heavy is priced as other (s.44AE Explanation)", () => {
    // Heavy means gross vehicle weight ABOVE 12,000 kg, so a 12-ton carriage
    // is an other goods carriage: 7,500 x 12 months = 90,000, not
    // 12 x 1,000 x 12 = 1,44,000.
    const r = computePresumptiveIncome(
      {
        scheme: "44AE",
        carriages: [{ type: "heavy", grossWeightTons: 12, monthsOwned: 12 }],
      },
      pack,
    );
    expect(r.deemedIncome).toBe(90000);
    expect(r.warnings.join(" ")).toContain("12-ton line");
  });
});

describe("declared profit", () => {
  it("a higher declared profit is the income to report (s.44ADA)", () => {
    // deemed 20,00,000 x 50% = 10,00,000; declared 12,00,000 is higher
    const r = computePresumptiveIncome(
      {
        scheme: "44ADA",
        grossReceipts: 2000000,
        cashReceiptsWithin5Pct: false,
        declaredProfit: 1200000,
      },
      pack,
    );
    expect(r.deemedIncome).toBe(1000000);
    expect(r.incomeToReport).toBe(1200000);
    expect(r.forComputeTax).toEqual({ otherIncome: 1200000 });
    expect(r.warnings).toEqual([]);
  });

  it("a lower declared profit warns about books and audit (s.44AD)", () => {
    // deemed 1,00,00,000 x 6% = 6,00,000; declared 4,00,000 is lower
    const r = computePresumptiveIncome(
      {
        scheme: "44AD",
        digitalTurnover: 10000000,
        otherTurnover: 0,
        declaredProfit: 400000,
      },
      pack,
    );
    expect(r.deemedIncome).toBe(600000);
    expect(r.incomeToReport).toBe(600000);
    expect(r.warnings.join(" ")).toContain("s.44AB");
  });
});

describe("impossible input", () => {
  it("throws on negative amounts and a heavy vehicle with no weight", () => {
    expect(() =>
      computePresumptiveIncome(
        { scheme: "44AD", digitalTurnover: -1, otherTurnover: 0 },
        pack,
      ),
    ).toThrow(/non-negative/);
    expect(() =>
      computePresumptiveIncome(
        {
          scheme: "44AE",
          carriages: [{ type: "heavy", monthsOwned: 12 }],
        },
        pack,
      ),
    ).toThrow(/grossWeightTons/);
    expect(() =>
      computePresumptiveIncome(
        {
          scheme: "44AE",
          carriages: [{ type: "other", monthsOwned: 13 }],
        },
        pack,
      ),
    ).toThrow(/12/);
  });
});
