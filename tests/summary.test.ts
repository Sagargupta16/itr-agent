import { describe, expect, it } from "vitest";
import { loadRulePack } from "../src/engine/rulepack.js";
import { computeTaxSummary } from "../src/engine/summary.js";

const pack = loadRulePack("2025-26");

// All cases are hand-worked from s.234A/234B/234C/234F, Rule 119A and s.288B;
// no published worked example was fetched.
//
// Salary 15,00,000, new regime: taxable 14,25,000 after the 75,000 standard
// deduction. Slabs: 4-8L 5% = 20,000; 8-12L 10% = 40,000; 12L-14.25L 15% =
// 33,750; 93,750 + 4% cess 3,750 = 97,500.
const salaried = {
  regime: "new" as const,
  salaryIncome: 1500000,
  otherIncome: 0,
  stcg111A: 0,
  ltcg112A: 0,
  deductions: 0,
  ageBand: "below60" as const,
};
const ITR2_DUE = "2026-07-31";

describe("computeTaxSummary", () => {
  it("on-time filing with TDS above the tax is a refund", () => {
    // totalTax 97,500 - TDS 1,10,000 = -12,500. Assessed tax 0, so no 234A/B/C
    // and no 234F.
    const r = computeTaxSummary(
      {
        tax: salaried,
        tdsCredit: 110000,
        tcsCredit: 0,
        advanceTaxPayments: [],
        filingDate: "2026-07-20",
        dueDate: ITR2_DUE,
      },
      pack,
    );
    expect(r.totalTax).toBe(97500);
    expect(r.assessedTax).toBe(0);
    expect(r.interestTotal).toBe(0);
    expect(r.fee234F).toBe(0);
    expect(r.periods.s234A).toBeNull();
    expect(r.net).toBe(-12500);
    expect(r.refund).toBe(12500);
    expect(r.payable).toBe(0);
  });

  it("ITR-2 salaried filer short by 50,000 filing on 2026-09-15 pays 234A, 234B and 234F", () => {
    // TDS 47,500 -> assessed 50,000, no advance tax.
    // 234A: 2026-08-01 to 2026-09-15 = Aug + part Sep = 2 months; 50,000 x 1% x 2 = 1,000.
    // 234B: 2026-04-01 to 2026-09-15 = Apr..Aug + part Sep = 6 months;
    //       50,000 x 1% x 6 = 3,000.
    // 234C: 15% 7,500 x 3% = 225; 45% 22,500 x 3% = 675; 75% 37,500 x 3% = 1,125;
    //       100% 50,000 x 1% = 500; total 2,525.
    // 234F: total income 14,25,000 above the threshold -> 5,000.
    // Net: 97,500 + 1,000 + 3,000 + 2,525 + 5,000 - 47,500 = 61,525 -> s.288B 61,530.
    const r = computeTaxSummary(
      {
        tax: salaried,
        tdsCredit: 47500,
        tcsCredit: 0,
        advanceTaxPayments: [],
        filingDate: "2026-09-15",
        dueDate: ITR2_DUE,
      },
      pack,
    );
    expect(r.assessedTax).toBe(50000);
    expect(r.periods.s234A).toEqual({
      from: "2026-08-01",
      to: "2026-09-15",
      months: 2,
    });
    expect(r.periods.s234B.months).toBe(6);
    expect(r.s234A.interest).toBe(1000);
    expect(r.s234B.interest).toBe(3000);
    expect(r.s234C.totalInterest).toBe(2525);
    expect(r.fee234F).toBe(5000);
    expect(r.netBeforeRounding).toBe(61525);
    expect(r.net).toBe(61530);
    expect(r.payable).toBe(61530);
  });

  it("late advance tax instalments are charged 234C only on the missed instalment", () => {
    // TDS 17,500 -> assessed 80,000. Advance tax: 12,000 on 2025-06-20 (after
    // the 15 June due date), 20,000 on 2025-09-10, 30,000 on 2025-12-15 (on the
    // due date counts), 18,000 on 2026-03-10.
    // Cumulative by due date: 0 / 32,000 / 62,000 / 80,000.
    // Jun: 15% = 12,000, safe harbour 12% = 9,600, paid 0 -> 12,000 x 1% x 3 = 360.
    // Sep: paid 32,000 >= 36% (28,800) -> safe harbour, 0.
    // Dec: 75% = 60,000, paid 62,000 -> 0. Mar: 80,000 paid -> 0.
    // 234B: advance 80,000 >= 90% of 80,000 -> none. Filed on time -> no 234A/F.
    // Net: 97,500 + 360 - 17,500 - 80,000 = 360.
    const r = computeTaxSummary(
      {
        tax: salaried,
        tdsCredit: 17500,
        tcsCredit: 0,
        advanceTaxPayments: [
          { date: "2025-06-20", amount: 12000 },
          { date: "2025-09-10", amount: 20000 },
          { date: "2025-12-15", amount: 30000 },
          { date: "2026-03-10", amount: 18000 },
        ],
        filingDate: "2026-07-25",
        dueDate: ITR2_DUE,
      },
      pack,
    );
    expect(r.periods.s234CCumulativePaid.map((c) => c.paid)).toEqual([
      0, 32000, 62000, 80000,
    ]);
    expect(r.advanceTaxPaid).toBe(80000);
    expect(r.s234C.totalInterest).toBe(360);
    expect(r.s234B.interest).toBe(0);
    expect(r.s234A.interest).toBe(0);
    expect(r.fee234F).toBe(0);
    expect(r.net).toBe(360);
  });

  it("a self-assessment payment splits the 234B period", () => {
    // Same 50,000 shortfall, filed 2026-09-15, 20,000 paid on 2026-07-10
    // (Apr..Jul = 4 months from 1 April).
    // 234B: months 1-4 on 50,000 = 2,000; months 5-6 on 30,000 = 600; 2,600.
    // 234A (before any Prannoy Roy relief): 50,000 x 1% x 2 = 1,000.
    // 234C ignores the s.140A payment: 2,525. 234F 5,000.
    // Net: 97,500 + 1,000 + 2,600 + 2,525 + 5,000 - 47,500 - 20,000 = 41,125 -> 41,130.
    const r = computeTaxSummary(
      {
        tax: salaried,
        tdsCredit: 47500,
        tcsCredit: 0,
        advanceTaxPayments: [],
        selfAssessmentPayments: [{ date: "2026-07-10", amount: 20000 }],
        filingDate: "2026-09-15",
        dueDate: ITR2_DUE,
      },
      pack,
    );
    expect(r.periods.selfAssessmentMonthsFromApril).toEqual([
      { date: "2026-07-10", monthsFromApril: 4 },
    ]);
    expect(r.s234B.segments.map((s) => [s.months, s.base, s.interest])).toEqual(
      [
        [4, 50000, 2000],
        [2, 30000, 600],
      ],
    );
    expect(r.s234B.interest).toBe(2600);
    expect(r.s234A.interest).toBe(1000);
    expect(r.s234C.totalInterest).toBe(2525);
    expect(r.netBeforeRounding).toBe(41125);
    expect(r.net).toBe(41130);
    expect(r.notes.join(" ")).toContain("Prannoy Roy");
  });

  it("income within the threshold pays the lower 234F fee", () => {
    // Salary 4,80,000 new regime: taxable 4,05,000, slab tax 250, s.87A rebate
    // clears it -> totalTax 0. Filed 2026-08-10 after 31 July: 234F at the
    // lower amount (total income 4,05,000 <= 5,00,000). Nothing outstanding,
    // so no 234A. Net = fee.
    const r = computeTaxSummary(
      {
        tax: { ...salaried, salaryIncome: 480000 },
        tdsCredit: 0,
        tcsCredit: 0,
        advanceTaxPayments: [],
        filingDate: "2026-08-10",
        dueDate: ITR2_DUE,
      },
      pack,
    );
    expect(r.tax.totalIncome).toBe(405000);
    expect(r.totalTax).toBe(0);
    expect(r.s234A.interest).toBe(0);
    expect(r.fee234F).toBe(pack.lateFee234F.incomeUpTo5L);
    expect(r.net).toBe(1000);
  });

  it("reads the lower-fee threshold from the pack", () => {
    const r = computeTaxSummary(
      {
        tax: { ...salaried, salaryIncome: 480000 },
        tdsCredit: 0,
        tcsCredit: 0,
        advanceTaxPayments: [],
        filingDate: "2026-08-10",
        dueDate: ITR2_DUE,
      },
      pack,
    );
    // New regime: 4,80,000 - 75,000 = 4,05,000 total income, at or below the
    // pack's lateFee234F.incomeThreshold, so the lower s.234F fee applies.
    expect(r.tax.totalIncome).toBe(405000);
    expect(r.fee234F).toBe(pack.lateFee234F.incomeUpTo5L);
  });

  it("warns when filing after the belated deadline", () => {
    const r = computeTaxSummary(
      {
        tax: salaried,
        tdsCredit: 97500,
        tcsCredit: 0,
        advanceTaxPayments: [],
        filingDate: "2027-01-15",
        dueDate: ITR2_DUE,
      },
      pack,
    );
    expect(r.warnings.join(" ")).toContain("updated return");
  });

  it("rejects an impossible date", () => {
    expect(() =>
      computeTaxSummary(
        {
          tax: salaried,
          tdsCredit: 0,
          tcsCredit: 0,
          advanceTaxPayments: [],
          filingDate: "2026-02-30",
          dueDate: ITR2_DUE,
        },
        pack,
      ),
    ).toThrow(/filingDate/);
  });

  it("s.207(2): a senior without business income pays no 234B or 234C", () => {
    // Same 50,000 shortfall as the ITR-2 case, filed on time: 234B and 234C
    // would be 2,000 and 2,525, but s.207(2) leaves no advance tax liability.
    const r = computeTaxSummary(
      {
        tax: { ...salaried, ageBand: "senior" },
        tdsCredit: 47500,
        tcsCredit: 0,
        advanceTaxPayments: [],
        filingDate: "2026-07-20",
        dueDate: ITR2_DUE,
        advanceTaxExempt: true,
      },
      pack,
    );
    expect(r.s234B.interest).toBe(0);
    expect(r.s234C.totalInterest).toBe(0);
    expect(r.notes.join(" ")).toContain("s.207(2)");
    expect(r.net).toBe(50000);
  });

  it("s.288B rounds a refund like a payable: 15 back is 20, not 10", () => {
    // 4,80,000 salary, new regime: 4,05,000 total income, nil tax after the
    // rebate. TDS of 15 is all refund.
    const r = computeTaxSummary(
      {
        tax: { ...salaried, salaryIncome: 480000 },
        tdsCredit: 15,
        tcsCredit: 0,
        advanceTaxPayments: [],
        filingDate: "2026-07-20",
        dueDate: ITR2_DUE,
      },
      pack,
    );
    expect(r.netBeforeRounding).toBe(-15);
    expect(r.net).toBe(-20);
  });
});
