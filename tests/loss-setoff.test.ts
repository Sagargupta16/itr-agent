import { describe, expect, it } from "vitest";
import { computeTax } from "../src/engine/compute.js";
import {
  computeLossSetoff,
  type LossSetoffResult,
  type LossTotals,
} from "../src/engine/loss-setoff.js";
import { loadRulePack } from "../src/engine/rulepack.js";

// Every case below is hand-worked from the sections named in its comment
// (1961 Act, FY 2025-26 pack): the incometaxindia.gov.in tutorial on set off
// and carry forward could not be fetched (the site answered 403), so no case
// is pinned to a published example yet.
const pack = loadRulePack("2025-26");

/** compute_tax fields the set-off engine does not decide. */
const taxRest = { deductions: 0, ageBand: "below60" as const };

const zero: LossTotals = {
  houseProperty: 0,
  business: 0,
  speculative: 0,
  shortTermCapital: 0,
  longTermCapital: 0,
};

/** CFL must balance: what was brought forward, less what BFLA used and what
 * lapsed, plus this year's carried loss, is what goes to next year. */
function expectCflBalances(r: LossSetoffResult): void {
  const cfl = r.schedules.cfl;
  for (const kind of Object.keys(zero) as (keyof LossTotals)[]) {
    expect(cfl.carriedToFuture[kind]).toBe(
      cfl.totalBroughtForward[kind] -
        cfl.adjustedInBfla[kind] -
        cfl.lapsedAtYearEnd[kind] +
        cfl.currentYear[kind],
    );
  }
}

describe("the issue #4 ledger: brought-forward STCL absorbs this year's STCG", () => {
  // Hand-worked from s.70(3) and s.74(1)(a)/(d):
  //   s.70(3): this year's LTCL 45,000 against this year's 112A gain 30,000
  //            -> 30,000 set off, 15,000 LTCL left.
  //   s.74(1)(a): STCL brought forward from FY 2023-24 (1,50,000) against
  //            111A STCG 80,000 -> 80,000 set off, 70,000 left; no long-term
  //            gain is left for it.
  //   s.74(1)(d): both carry for 8 AYs, the 2023-24 STCL to FY 2031-32 and
  //            the new LTCL to FY 2033-34.
  const r = computeLossSetoff(
    {
      regime: "new",
      filedByDueDate: true,
      salaryIncome: 1800000,
      capitalGains: { stcg111A: 80000, ltcg112A: 30000, longTermLoss: 45000 },
      broughtForward: [
        { kind: "shortTermCapital", originFy: "2023-24", amount: 150000 },
      ],
    },
    pack,
  );

  it("sets off in statutory order with the section for each step", () => {
    expect(r.steps).toEqual([
      {
        step: 1,
        stage: "intraHead",
        section: "s.70(3)",
        loss: "longTermCapital",
        originFy: "2025-26",
        against: "ltcg112A",
        amount: 30000,
      },
      {
        step: 2,
        stage: "broughtForward",
        section: "s.74(1)(a)",
        loss: "shortTermCapital",
        originFy: "2023-24",
        against: "stcg111A",
        amount: 80000,
      },
    ]);
  });

  it("carries the residual STCL and the new LTCL with their last usable years", () => {
    expect(r.carryForward).toEqual([
      {
        kind: "shortTermCapital",
        originFy: "2023-24",
        originAy: "2024-25",
        amount: 70000,
        lastUsableFy: "2031-32",
        lastUsableAy: "2032-33",
        section: "s.74(1)(d)",
      },
      {
        kind: "longTermCapital",
        originFy: "2025-26",
        originAy: "2026-27",
        amount: 15000,
        lastUsableFy: "2033-34",
        lastUsableAy: "2034-35",
        section: "s.74(1)(d)",
      },
    ]);
    expect(r.expired).toEqual([]);
    expect(r.forfeited).toEqual([]);
  });

  it("fills Schedule CFL and BFLA rows", () => {
    expect(r.schedules.cfl.broughtForward).toEqual([
      { fy: "2023-24", ay: "2024-25", ...zero, shortTermCapital: 150000 },
    ]);
    expect(r.schedules.cfl.adjustedInBfla).toEqual({
      ...zero,
      shortTermCapital: 80000,
    });
    expect(r.schedules.cfl.currentYear).toEqual({
      fy: "2025-26",
      ay: "2026-27",
      ...zero,
      longTermCapital: 15000,
    });
    expect(r.schedules.cfl.carriedToFuture).toEqual({
      ...zero,
      shortTermCapital: 70000,
      longTermCapital: 15000,
    });
    const stcgRow = r.schedules.bfla.rows.find(
      (row) => row.head === "stcg111A",
    );
    expect(stcgRow).toEqual({
      head: "stcg111A",
      income: 80000,
      ...zero,
      shortTermCapital: 80000,
      remaining: 0,
    });
    expectCflBalances(r);
  });

  it("hands compute_tax the gains left after set-off", () => {
    // Salary 18,00,000 less the 75,000 standard deduction; no gains left.
    expect(r.incomeAfterSetoff.grossTotalIncome).toBe(1725000);
    expect(r.forComputeTax).toEqual({
      regime: "new",
      salaryIncome: 1800000,
      otherIncome: 0,
      stcg111A: 0,
      ltcg112A: 0,
    });
    const tax = computeTax({ ...taxRest, ...r.forComputeTax }, pack);
    expect(tax.totalIncome).toBe(1725000);
  });
});

describe("s.71(2A): a business loss never touches salary", () => {
  // Hand-worked from s.71(1), s.71(2A) and s.72(3): business loss 3,00,000;
  // the only head it may reach is other sources (50,000), so 2,50,000 carries
  // to FY 2033-34 and the 11,25,000 of net salary is untouched.
  const r = computeLossSetoff(
    {
      regime: "new",
      filedByDueDate: true,
      salaryIncome: 1200000,
      business: -300000,
      otherSources: 50000,
    },
    pack,
  );

  it("sets off against other sources only", () => {
    expect(r.steps).toEqual([
      {
        step: 1,
        stage: "interHead",
        section: "s.71(1)",
        loss: "business",
        originFy: "2025-26",
        against: "otherSources",
        amount: 50000,
      },
    ]);
    expect(r.incomeAfterSetoff.salary).toBe(1125000);
    const salaryRow = r.schedules.cyla.rows.find(
      (row) => row.head === "salary",
    );
    expect(salaryRow).toEqual({
      head: "salary",
      income: 1125000,
      housePropertyLossSetOff: 0,
      businessLossSetOff: 0,
      remaining: 1125000,
    });
    expect(r.schedules.cyla.lossRemaining.business).toBe(250000);
    expect(r.notes.some((n) => n.includes("s.71(2A)"))).toBe(true);
  });

  it("carries the rest for eight years", () => {
    expect(r.carryForward).toEqual([
      {
        kind: "business",
        originFy: "2025-26",
        originAy: "2026-27",
        amount: 250000,
        lastUsableFy: "2033-34",
        lastUsableAy: "2034-35",
        section: "s.72(3)",
      },
    ]);
    const tax = computeTax({ ...taxRest, ...r.forComputeTax }, pack);
    expect(tax.taxableNormalIncome).toBe(1125000);
  });
});

describe("house-property loss above the s.71(3A) cap", () => {
  const input = {
    filedByDueDate: true,
    salaryIncome: 1500000,
    houseProperty: -350000,
    housePropertyType: "letOut" as const,
  };

  it("old regime: 2,00,000 against salary, 1,50,000 carried, compute_tax caps nothing twice", () => {
    // Hand-worked from s.71(1), s.71(3A) and s.71B: let-out loss 3,50,000,
    // inter-head set-off capped at 2,00,000 (against net salary 14,50,000),
    // 1,50,000 carried for 8 AYs against house-property income only.
    const r = computeLossSetoff({ ...input, regime: "old" }, pack);
    expect(r.steps).toEqual([
      {
        step: 1,
        stage: "interHead",
        section: "s.71(1), s.71(3A)",
        loss: "houseProperty",
        originFy: "2025-26",
        against: "salary",
        amount: 200000,
      },
    ]);
    expect(r.carryForward).toEqual([
      {
        kind: "houseProperty",
        originFy: "2025-26",
        originAy: "2026-27",
        amount: 150000,
        lastUsableFy: "2033-34",
        lastUsableAy: "2034-35",
        section: "s.71B",
      },
    ]);
    expect(r.forComputeTax).toEqual({
      regime: "old",
      salaryIncome: 1500000,
      otherIncome: 0,
      stcg111A: 0,
      ltcg112A: 0,
      housePropertyLoss: 200000,
      housePropertyType: "letOut",
    });
    // 15,00,000 - 50,000 standard deduction - 2,00,000 = 12,50,000.
    const tax = computeTax({ ...taxRest, ...r.forComputeTax }, pack);
    expect(tax.housePropertyLossSetOff).toBe(200000);
    expect(tax.housePropertyLossCarriedForward).toBe(0);
    expect(tax.taxableNormalIncome).toBe(1250000);
    expect(r.incomeAfterSetoff.grossTotalIncome).toBe(1250000);
  });

  it("new regime: nothing crosses heads, all 3,50,000 carried", () => {
    // Hand-worked from s.115BAC(2)(ii)(b) and s.71B: no inter-head set-off of
    // a house-property loss under the new regime; the whole loss carries.
    const r = computeLossSetoff({ ...input, regime: "new" }, pack);
    expect(r.steps).toEqual([]);
    expect(r.carryForwardTotals).toEqual({ ...zero, houseProperty: 350000 });
    expect(r.forComputeTax).toEqual({
      regime: "new",
      salaryIncome: 1500000,
      otherIncome: 0,
      stcg111A: 0,
      ltcg112A: 0,
    });
    expect(r.notes.some((n) => n.includes("s.115BAC(2)(ii)(b)"))).toBe(true);
    // 15,00,000 - 75,000 standard deduction.
    const tax = computeTax({ ...taxRest, ...r.forComputeTax }, pack);
    expect(tax.taxableNormalIncome).toBe(1425000);
  });

  it("old regime: a loss larger than slab-rate income reaches the gains, and compute_tax sees it once", () => {
    // Hand-worked from s.71(1), s.71(2) and s.71(3A): no salary; loss
    // 2,50,000 takes other sources 50,000, then 1,50,000 of the 111A gain
    // (the cap's remainder), and 50,000 carries under s.71B.
    const r = computeLossSetoff(
      {
        regime: "old",
        filedByDueDate: true,
        otherSources: 50000,
        capitalGains: { stcg111A: 300000 },
        houseProperty: -250000,
        housePropertyType: "letOut",
      },
      pack,
    );
    expect(r.steps.map((s) => [s.section, s.against, s.amount])).toEqual([
      ["s.71(1), s.71(3A)", "otherSources", 50000],
      ["s.71(2), s.71(3A)", "stcg111A", 150000],
    ]);
    expect(r.carryForwardTotals.houseProperty).toBe(50000);
    expect(r.forComputeTax).toEqual({
      regime: "old",
      salaryIncome: 0,
      otherIncome: 50000,
      stcg111A: 150000,
      ltcg112A: 0,
      housePropertyLoss: 50000,
      housePropertyType: "letOut",
    });
    const tax = computeTax({ ...taxRest, ...r.forComputeTax }, pack);
    expect(tax.housePropertyLossSetOff).toBe(50000);
    expect(tax.totalIncome).toBe(r.incomeAfterSetoff.grossTotalIncome);
    expect(tax.totalIncome).toBe(150000);
  });
});

describe("self-occupied interest follows compute_tax's s.24(b) rule", () => {
  const input = {
    filedByDueDate: true,
    salaryIncome: 1500000,
    houseProperty: -300000,
    housePropertyType: "selfOccupied" as const,
  };

  it("old regime: 2,00,000 is the loss, 1,00,000 is no loss at all", () => {
    // Hand-worked from s.24(b) second proviso and s.71(3A): interest 3,00,000
    // is deductible to 2,00,000, set off against salary in full; the
    // 1,00,000 above the cap is neither set off nor carried.
    const r = computeLossSetoff({ ...input, regime: "old" }, pack);
    expect(r.housePropertyLossDisallowed).toBe(100000);
    expect(r.currentYearLosses.houseProperty).toBe(200000);
    expect(r.carryForward).toEqual([]);
    expect(r.forComputeTax.housePropertyLoss).toBe(200000);
    expect(r.forComputeTax.housePropertyType).toBe("selfOccupied");
    const tax = computeTax({ ...taxRest, ...r.forComputeTax }, pack);
    expect(tax.housePropertyLossDisallowed).toBe(0);
    expect(tax.taxableNormalIncome).toBe(1250000);
  });

  it("new regime: all of it is disallowed and nothing carries", () => {
    // Hand-worked from s.115BAC(2)(i): no s.24(b) deduction on a
    // self-occupied house under the new regime.
    const r = computeLossSetoff({ ...input, regime: "new" }, pack);
    expect(r.housePropertyLossDisallowed).toBe(300000);
    expect(r.steps).toEqual([]);
    expect(r.carryForward).toEqual([]);
  });
});

describe("a speculative loss stranded", () => {
  // Hand-worked from s.73(1) and s.73(4): speculative loss 80,000 with no
  // speculative profit; business profit 2,00,000 cannot absorb it, so it
  // carries for 4 AYs, to FY 2029-30.
  const r = computeLossSetoff(
    {
      regime: "new",
      filedByDueDate: true,
      salaryIncome: 1000000,
      business: 200000,
      speculative: -80000,
      otherSources: 30000,
    },
    pack,
  );

  it("is set off against nothing and carried four years", () => {
    expect(r.steps).toEqual([]);
    expect(r.incomeAfterSetoff.business).toBe(200000);
    expect(r.carryForward).toEqual([
      {
        kind: "speculative",
        originFy: "2025-26",
        originAy: "2026-27",
        amount: 80000,
        lastUsableFy: "2029-30",
        lastUsableAy: "2030-31",
        section: "s.73(4)",
      },
    ]);
    // Business 2,00,000 + other sources 30,000, both at slab rates.
    expect(r.forComputeTax.otherIncome).toBe(230000);
    expect(r.notes.some((n) => n.includes("s.73(1)"))).toBe(true);
  });
});

describe("an expired brought-forward business loss", () => {
  // Hand-worked from s.72(1) and s.72(3): a FY 2016-17 loss could be used to
  // FY 2024-25 and has expired; a FY 2017-18 loss has FY 2025-26 as its last
  // year, takes the 40,000 business income and the other 20,000 lapses.
  const r = computeLossSetoff(
    {
      regime: "old",
      filedByDueDate: true,
      business: 40000,
      broughtForward: [
        { kind: "business", originFy: "2016-17", amount: 100000 },
        { kind: "business", originFy: "2017-18", amount: 60000 },
      ],
    },
    pack,
  );

  it("uses only the loss still inside its period", () => {
    expect(r.steps).toEqual([
      {
        step: 1,
        stage: "broughtForward",
        section: "s.72(1)",
        loss: "business",
        originFy: "2017-18",
        against: "business",
        amount: 40000,
      },
    ]);
  });

  it("reports what expired and what lapses, carries nothing", () => {
    expect(r.expired).toEqual([
      {
        kind: "business",
        originFy: "2016-17",
        originAy: "2017-18",
        amount: 100000,
        lastUsableFy: "2024-25",
        lastUsableAy: "2025-26",
        section: "s.72(3)",
        when: "beforeThisYear",
      },
      {
        kind: "business",
        originFy: "2017-18",
        originAy: "2018-19",
        amount: 20000,
        lastUsableFy: "2025-26",
        lastUsableAy: "2026-27",
        section: "s.72(3)",
        when: "endOfThisYear",
      },
    ]);
    expect(r.carryForward).toEqual([]);
    expect(r.schedules.cfl.broughtForward).toEqual([
      { fy: "2017-18", ay: "2018-19", ...zero, business: 60000 },
    ]);
    expect(r.schedules.cfl.lapsedAtYearEnd).toEqual({
      ...zero,
      business: 20000,
    });
    expect(r.schedules.cfl.carriedToFuture).toEqual(zero);
    expectCflBalances(r);
  });
});

describe("brought-forward losses go oldest first", () => {
  it("across two origin years of the same kind, whatever the input order", () => {
    // Hand-worked from s.72(1): business income 1,00,000 takes the FY 2019-20
    // loss (50,000) before the FY 2022-23 one (50,000 of 1,20,000); 70,000 of
    // the later loss carries to FY 2030-31 (s.72(3)).
    const r = computeLossSetoff(
      {
        regime: "new",
        filedByDueDate: true,
        business: 100000,
        broughtForward: [
          { kind: "business", originFy: "2022-23", amount: 120000 },
          { kind: "business", originFy: "2019-20", amount: 50000 },
        ],
      },
      pack,
    );
    expect(r.steps.map((s) => [s.section, s.originFy, s.amount])).toEqual([
      ["s.72(1)", "2019-20", 50000],
      ["s.72(1)", "2022-23", 50000],
    ]);
    expect(r.carryForward).toEqual([
      {
        kind: "business",
        originFy: "2022-23",
        originAy: "2023-24",
        amount: 70000,
        lastUsableFy: "2030-31",
        lastUsableAy: "2031-32",
        section: "s.72(3)",
      },
    ]);
    expect(r.notes.some((n) => n.includes("s.115BAC(2)(ii)(a)"))).toBe(true);
  });

  it("on speculative profit, the loss whose period ends first", () => {
    // Hand-worked from s.72(1), s.73(2), s.72(3) and s.73(4): the FY 2021-22
    // speculative loss lasts to FY 2025-26, the FY 2018-19 business loss to
    // FY 2026-27, so the speculative one takes the 40,000 first (30,000) and
    // the business loss the remaining 10,000; 40,000 of it carries.
    const r = computeLossSetoff(
      {
        regime: "old",
        filedByDueDate: true,
        speculative: 40000,
        broughtForward: [
          { kind: "business", originFy: "2018-19", amount: 50000 },
          { kind: "speculative", originFy: "2021-22", amount: 30000 },
        ],
      },
      pack,
    );
    expect(r.steps.map((s) => [s.section, s.loss, s.amount])).toEqual([
      ["s.73(2)", "speculative", 30000],
      ["s.72(1)", "business", 10000],
    ]);
    expect(
      r.carryForward.map((l) => [l.kind, l.amount, l.lastUsableFy]),
    ).toEqual([["business", 40000, "2026-27"]]);
    expect(r.expired).toEqual([]);
  });

  it("house property against house-property income only (s.71B)", () => {
    // Hand-worked from s.71B: let-out income 1,20,000 absorbs 1,20,000 of the
    // FY 2021-22 loss; 30,000 carries to FY 2029-30.
    const r = computeLossSetoff(
      {
        regime: "new",
        filedByDueDate: true,
        salaryIncome: 900000,
        houseProperty: 120000,
        broughtForward: [
          { kind: "houseProperty", originFy: "2021-22", amount: 150000 },
        ],
      },
      pack,
    );
    expect(r.steps.map((s) => [s.section, s.against, s.amount])).toEqual([
      ["s.71B", "houseProperty", 120000],
    ]);
    expect(r.carryForward.map((l) => [l.amount, l.lastUsableFy])).toEqual([
      [30000, "2029-30"],
    ]);
    expect(r.incomeAfterSetoff.salary).toBe(825000);
  });
});

describe("this year's capital losses within the head (s.70)", () => {
  it("slab-rate and 111A gains before 112A, the long-term loss before the short-term on long-term gains", () => {
    // Hand-worked from s.70(2) and s.70(3):
    //   STCL 1,00,000: slab-rate STCG 20,000, then 111A 30,000 -> 50,000 left.
    //   LTCL 40,000: s.112 gain 25,000, then 112A 15,000.
    //   STCL 50,000 left: 112A 50,000.
    //   112A gain left 2,00,000 - 15,000 - 50,000 = 1,35,000.
    const r = computeLossSetoff(
      {
        regime: "new",
        filedByDueDate: true,
        capitalGains: {
          stcgOther: 20000,
          stcg111A: 30000,
          ltcgOther: 25000,
          ltcg112A: 200000,
          shortTermLoss: 100000,
          longTermLoss: 40000,
        },
      },
      pack,
    );
    expect(
      r.steps.map((s) => [s.section, s.loss, s.against, s.amount]),
    ).toEqual([
      ["s.70(2)", "shortTermCapital", "stcgOther", 20000],
      ["s.70(2)", "shortTermCapital", "stcg111A", 30000],
      ["s.70(3)", "longTermCapital", "ltcgOther", 25000],
      ["s.70(3)", "longTermCapital", "ltcg112A", 15000],
      ["s.70(2)", "shortTermCapital", "ltcg112A", 50000],
    ]);
    expect(r.carryForward).toEqual([]);
    expect(r.forComputeTax.ltcg112A).toBe(135000);
    expect(r.outsideComputeTax.ltcgOther).toBe(0);
    expect(r.notes.some((n) => n.includes("s.112A threshold"))).toBe(true);
  });

  it("s.112 gains left over are reported outside compute_tax with a warning", () => {
    const r = computeLossSetoff(
      {
        regime: "old",
        filedByDueDate: true,
        capitalGains: { ltcgOther: 100000 },
      },
      pack,
    );
    expect(r.outsideComputeTax.ltcgOther).toBe(100000);
    expect(r.warnings.some((w) => w.includes("s.112"))).toBe(true);
  });
});

describe("s.80: a return after the due date", () => {
  // Hand-worked from s.70(2), s.71(1), s.71(3A), s.71B and s.80:
  //   s.70(2): STCL 60,000 against 111A 10,000 -> 50,000 left.
  //   s.71: house-property loss 2,50,000 against net salary 7,50,000, capped
  //         at 2,00,000 -> 50,000 left; business loss 1,50,000 against other
  //         sources 1,00,000 -> 50,000 left.
  //   s.72(1): the FY 2022-23 business loss finds no business income.
  //   s.80: business 50,000, speculative 20,000 and STCL 50,000 of this year
  //         are forfeited; the house-property 50,000 still carries (s.71B is
  //         not named in s.80), and so does the earlier year's business loss.
  const r = computeLossSetoff(
    {
      regime: "old",
      filedByDueDate: false,
      salaryIncome: 800000,
      houseProperty: -250000,
      housePropertyType: "letOut",
      business: -150000,
      speculative: -20000,
      otherSources: 100000,
      capitalGains: { stcg111A: 10000, shortTermLoss: 60000 },
      broughtForward: [
        { kind: "business", originFy: "2022-23", amount: 40000 },
      ],
    },
    pack,
  );

  it("still sets off this year's losses this year", () => {
    expect(
      r.steps.map((s) => [s.stage, s.section, s.against, s.amount]),
    ).toEqual([
      ["intraHead", "s.70(2)", "stcg111A", 10000],
      ["interHead", "s.71(1), s.71(3A)", "salary", 200000],
      ["interHead", "s.71(1)", "otherSources", 100000],
    ]);
  });

  it("forfeits this year's business, speculative and capital losses, keeps house property", () => {
    expect(r.forfeited).toEqual([
      { kind: "business", amount: 50000, section: "s.80" },
      { kind: "speculative", amount: 20000, section: "s.80" },
      { kind: "shortTermCapital", amount: 50000, section: "s.80" },
    ]);
    expect(r.carryForward.map((l) => [l.kind, l.originFy, l.amount])).toEqual([
      ["business", "2022-23", 40000],
      ["houseProperty", "2025-26", 50000],
    ]);
    expect(r.schedules.cfl.currentYear).toEqual({
      fy: "2025-26",
      ay: "2026-27",
      ...zero,
      houseProperty: 50000,
    });
    expectCflBalances(r);
    expect(r.notes.some((n) => n.startsWith("s.80:"))).toBe(true);
  });

  it("feeds compute_tax the same income the schedules show", () => {
    // 8,00,000 - 50,000 standard deduction - 2,00,000 = 5,50,000.
    const tax = computeTax({ ...taxRest, ...r.forComputeTax }, pack);
    expect(tax.taxableNormalIncome).toBe(550000);
    expect(r.incomeAfterSetoff.grossTotalIncome).toBe(550000);
  });

  it("the same facts filed on time carry all of it", () => {
    const onTime = computeLossSetoff(
      {
        regime: "old",
        filedByDueDate: true,
        salaryIncome: 800000,
        houseProperty: -250000,
        housePropertyType: "letOut",
        business: -150000,
        speculative: -20000,
        otherSources: 100000,
        capitalGains: { stcg111A: 10000, shortTermLoss: 60000 },
      },
      pack,
    );
    expect(onTime.forfeited).toEqual([]);
    expect(onTime.carryForwardTotals).toEqual({
      houseProperty: 50000,
      business: 50000,
      speculative: 20000,
      shortTermCapital: 50000,
      longTermCapital: 0,
    });
  });
});

describe("input checks", () => {
  it("warns when a house-property loss comes without its type", () => {
    const r = computeLossSetoff(
      { regime: "old", filedByDueDate: true, houseProperty: -100000 },
      pack,
    );
    expect(r.warnings[0]).toMatch(/housePropertyType was not given/);
  });

  it("refuses a brought-forward loss from this year or a malformed year", () => {
    expect(() =>
      computeLossSetoff(
        {
          regime: "new",
          filedByDueDate: true,
          broughtForward: [
            { kind: "business", originFy: "2025-26", amount: 1000 },
          ],
        },
        pack,
      ),
    ).toThrow(/not before FY 2025-26/);
    expect(() =>
      computeLossSetoff(
        {
          regime: "new",
          filedByDueDate: true,
          broughtForward: [
            { kind: "business", originFy: "2021-23", amount: 1000 },
          ],
        },
        pack,
      ),
    ).toThrow(/not a financial year/);
  });

  it("refuses a negative gain", () => {
    expect(() =>
      computeLossSetoff(
        {
          regime: "new",
          filedByDueDate: true,
          capitalGains: { stcg111A: -5000 },
        },
        pack,
      ),
    ).toThrow(/shortTermLoss/);
  });
});
