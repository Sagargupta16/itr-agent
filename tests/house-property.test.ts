import { describe, expect, it } from "vitest";
import { computeTax, type TaxInput } from "../src/engine/compute.js";
import {
  computeHouseProperty,
  type HouseInput,
} from "../src/engine/house-property.js";
import { loadRulePack } from "../src/engine/rulepack.js";

const pack = loadRulePack("2025-26");

// No published worked example could be fetched for these cases
// (incometaxindia.gov.in answers 403 to scripted reads), so each is
// hand-worked from the section cited beside it. The cap figures themselves
// (Rs 2,00,000 self-occupied on a post-1999 purchase or construction loan,
// Rs 30,000 for repairs or a pre-1999 loan, let-out interest without limit)
// match the s.24(b) table on
// https://www.incometax.gov.in/iec/foportal/help/individual/return-applicable-1
// (read 2026-11-14).

const salaried = (regime: "old" | "new"): TaxInput => ({
  regime,
  salaryIncome: 1500000,
  otherIncome: 0,
  stcg111A: 0,
  ltcg112A: 0,
  deductions: 0,
  ageBand: "below60",
});

function head(houses: HouseInput[], regime: "old" | "new" = "old") {
  return computeHouseProperty(houses, pack, regime);
}

describe("let-out house (s.23(1) proviso, s.24(a), s.24(b))", () => {
  it("deducts municipal taxes paid, then 30% of the net annual value, then interest in full", () => {
    // Hand-worked from s.23(1) proviso, s.24(a) and s.24(b):
    //   NAV = 3,60,000 - 10,000 = 3,50,000
    //   s.24(a) = 30% x 3,50,000 = 1,05,000
    //   income = 3,50,000 - 1,05,000 - 1,50,000 = 95,000
    const r = head([
      {
        use: "letOut",
        grossAnnualValue: 360000,
        municipalTaxesPaid: 10000,
        interestPayable: 150000,
      },
    ]);
    const h = r.houses[0];
    expect(h?.treatedAs).toBe("letOut");
    expect(h?.netAnnualValue).toBe(350000);
    expect(h?.standardDeduction).toBe(105000);
    expect(h?.interestAllowed).toBe(150000);
    expect(h?.interestDisallowed).toBe(0);
    expect(r.totals.income).toBe(95000);
    expect(r.forComputeTax).toEqual({
      otherIncome: 95000,
      housePropertyLoss: 0,
      housePropertyType: "letOut",
    });
    expect(r.warnings).toEqual([]);
  });

  it("leaves let-out interest uncapped and hands the loss to compute_tax for the s.71(3A) limit", () => {
    // Hand-worked from s.24(a), s.24(b) (no cap on a let-out house) and s.71(3A):
    //   NAV 2,40,000; s.24(a) 72,000; interest 5,00,000
    //   income = 2,40,000 - 72,000 - 5,00,000 = -3,32,000
    //   compute_tax (old): set off 2,00,000, carry forward 1,32,000 (s.71B)
    const r = head([
      { use: "letOut", grossAnnualValue: 240000, interestPayable: 500000 },
    ]);
    expect(r.houses[0]?.standardDeduction).toBe(72000);
    expect(r.houses[0]?.interestAllowed).toBe(500000);
    expect(r.totals.income).toBe(-332000);
    expect(r.forComputeTax.housePropertyLoss).toBe(332000);
    expect(r.forComputeTax.otherIncome).toBe(0);

    const tax = computeTax({ ...salaried("old"), ...r.forComputeTax }, pack);
    expect(tax.housePropertyLossDisallowed).toBe(0);
    expect(tax.housePropertyLossSetOff).toBe(200000);
    expect(tax.housePropertyLossCarriedForward).toBe(132000);
  });

  it("rounds the s.24(a) deduction to the rupee", () => {
    // 30% x 1,23,457 = 37,037.1 -> 37,037; income 1,23,457 - 37,037 = 86,420
    const r = head([{ use: "letOut", grossAnnualValue: 123457 }]);
    expect(r.houses[0]?.standardDeduction).toBe(37037);
    expect(r.totals.income).toBe(86420);
  });
});

describe("self-occupied houses (s.23(2), s.24(b) provisos)", () => {
  it("caps interest at Rs 2,00,000 and does not cap it again in compute_tax", () => {
    // Hand-worked from s.23(2) (nil annual value) and the s.24(b) second proviso:
    //   interest 2,60,000 -> allowed 2,00,000, disallowed 60,000
    //   income = 0 - 2,00,000 = -2,00,000
    const r = head([{ use: "selfOccupied", interestPayable: 260000 }]);
    const h = r.houses[0];
    expect(h?.netAnnualValue).toBe(0);
    expect(h?.interestAllowed).toBe(200000);
    expect(h?.interestDisallowed).toBe(60000);
    expect(r.totals.income).toBe(-200000);
    expect(r.selfOccupiedInterestCap).toBe(200000);
    expect(r.forComputeTax).toEqual({
      otherIncome: 0,
      housePropertyLoss: 200000,
      housePropertyType: "letOut",
    });
    expect(r.notes.join(" ")).toContain("not carried forward");

    const tax = computeTax({ ...salaried("old"), ...r.forComputeTax }, pack);
    expect(tax.housePropertyLossDisallowed).toBe(0);
    expect(tax.housePropertyLossSetOff).toBe(200000);
    expect(tax.housePropertyLossCarriedForward).toBe(0);
  });

  it("ignores rent and municipal tax on a self-occupied house", () => {
    // s.23(2): annual value nil, so the 8,000 of municipal tax is not deducted.
    const r = head([
      {
        use: "selfOccupied",
        grossAnnualValue: 300000,
        municipalTaxesPaid: 8000,
        interestPayable: 50000,
      },
    ]);
    const h = r.houses[0];
    expect(h?.grossAnnualValue).toBe(0);
    expect(h?.municipalTaxes).toBe(0);
    expect(h?.standardDeduction).toBe(0);
    expect(h?.income).toBe(-50000);
    expect(r.notes.join(" ")).toContain("nil annual value");
  });

  it("makes two self-occupied houses share one Rs 2,00,000 cap, in input order", () => {
    // Hand-worked from s.23(2) (two houses) and the aggregate s.24(b) cap:
    //   1,50,000 + 1,20,000 = 2,70,000 against a 2,00,000 cap
    //   house A 1,50,000 allowed; house B 2,00,000 - 1,50,000 = 50,000 allowed,
    //   70,000 disallowed; head -2,00,000
    const r = head([
      { label: "A", use: "selfOccupied", interestPayable: 150000 },
      { label: "B", use: "selfOccupied", interestPayable: 120000 },
    ]);
    expect(r.houses.map((h) => h.interestAllowed)).toEqual([150000, 50000]);
    expect(r.houses.map((h) => h.interestDisallowed)).toEqual([0, 70000]);
    expect(r.totals.interestDisallowed).toBe(70000);
    expect(r.totals.income).toBe(-200000);
    expect(r.notes.join(" ")).toContain("shared");
  });

  it("keeps an older or repair loan on the Rs 30,000 cap", () => {
    // Hand-worked from the s.24(b) first proviso: 45,000 -> 30,000 allowed.
    const r = head([
      {
        use: "selfOccupied",
        interestPayable: 45000,
        loanQualifiesForHigherCap: false,
      },
    ]);
    expect(r.houses[0]?.interestAllowed).toBe(30000);
    expect(r.houses[0]?.interestDisallowed).toBe(15000);
    expect(r.selfOccupiedInterestCap).toBe(30000);
    expect(r.totals.income).toBe(-30000);
  });

  it("fits the Rs 30,000 cap inside the shared Rs 2,00,000, whatever the order", () => {
    // Qualifying 1,90,000 + older 40,000 (older capped at 30,000):
    //   A first: A 1,90,000, B min(40,000, 30,000, 10,000 left) = 10,000
    //   B first: B 30,000, A min(1,90,000, 1,70,000 left) = 1,70,000
    //   head -2,00,000 either way
    const a: HouseInput = {
      label: "A",
      use: "selfOccupied",
      interestPayable: 190000,
    };
    const b: HouseInput = {
      label: "B",
      use: "selfOccupied",
      interestPayable: 40000,
      loanQualifiesForHigherCap: false,
    };
    const ab = head([a, b]);
    const ba = head([b, a]);
    expect(ab.houses.map((h) => h.interestAllowed)).toEqual([190000, 10000]);
    expect(ba.houses.map((h) => h.interestAllowed)).toEqual([30000, 170000]);
    expect(ab.totals.income).toBe(-200000);
    expect(ba.totals.income).toBe(-200000);
  });
});

describe("s.23(4): more self-occupied houses than s.23(2) admits", () => {
  it("deems the third house let out on its expected rent, with no s.24(b) cap", () => {
    // Hand-worked from s.23(4)(b), s.23(1), s.24(a) and s.24(b):
    //   house 3: NAV 2,40,000 - 12,000 = 2,28,000; s.24(a) 68,400
    //            income 2,28,000 - 68,400 - 80,000 = 79,600
    //   houses 1 and 2: -1,00,000 and -50,000 (inside the shared cap)
    //   head = 79,600 - 1,50,000 = -70,400
    const r = head([
      { use: "selfOccupied", interestPayable: 100000 },
      { use: "selfOccupied", interestPayable: 50000 },
      {
        use: "selfOccupied",
        grossAnnualValue: 240000,
        municipalTaxesPaid: 12000,
        interestPayable: 80000,
      },
    ]);
    expect(r.houses.map((h) => h.treatedAs)).toEqual([
      "selfOccupied",
      "selfOccupied",
      "deemedLetOut",
    ]);
    const third = r.houses[2];
    expect(third?.netAnnualValue).toBe(228000);
    expect(third?.standardDeduction).toBe(68400);
    expect(third?.income).toBe(79600);
    expect(r.totals.income).toBe(-70400);
    expect(r.forComputeTax.housePropertyLoss).toBe(70400);
    expect(r.warnings.join(" ")).toMatch(/s\.23\(4\).*house 3/);
  });

  it("warns when a deemed let-out house has no expected rent", () => {
    const r = head([
      { use: "selfOccupied", interestPayable: 10000 },
      { use: "selfOccupied", interestPayable: 10000 },
      { use: "selfOccupied", interestPayable: 60000 },
    ]);
    expect(r.houses[2]?.treatedAs).toBe("deemedLetOut");
    expect(r.houses[2]?.income).toBe(-60000);
    expect(r.warnings.join(" ")).toContain("s.23(1)(a)");
  });
});

describe("pre-construction interest (Explanation to s.24(b))", () => {
  it("allows instalment 3 of 5 inside the window, within the self-occupied cap", () => {
    // Hand-worked from the Explanation to s.24(b) and the second proviso:
    //   completed FY 2023-24: 2023-24 is 1, 2024-25 is 2, 2025-26 is 3
    //   instalment 2,50,000 / 5 = 50,000; claimed 1,80,000 + 50,000 = 2,30,000
    //   allowed 2,00,000 (the cap covers the instalment), disallowed 30,000
    const r = head([
      {
        use: "selfOccupied",
        interestPayable: 180000,
        preConstructionInterest: 250000,
        constructionCompletedFy: "2023-24",
      },
    ]);
    const h = r.houses[0];
    expect(h?.preConstructionInstalment).toBe(50000);
    expect(h?.preConstructionInstalmentNumber).toBe(3);
    expect(h?.interestClaimed).toBe(230000);
    expect(h?.interestAllowed).toBe(200000);
    expect(h?.interestDisallowed).toBe(30000);
    expect(r.totals.income).toBe(-200000);
    expect(r.notes.join(" ")).toContain("instalment 3 of 5");
  });

  it("allows the fifth and last instalment on a let-out house in full", () => {
    // Completed FY 2021-22, so FY 2025-26 is instalment 5: 3,00,000 / 5 = 60,000
    //   NAV 3,00,000; s.24(a) 90,000; interest 2,00,000 + 60,000 = 2,60,000
    //   income = 3,00,000 - 90,000 - 2,60,000 = -50,000
    const r = head([
      {
        use: "letOut",
        grossAnnualValue: 300000,
        interestPayable: 200000,
        preConstructionInterest: 300000,
        constructionCompletedFy: "2021-22",
      },
    ]);
    const h = r.houses[0];
    expect(h?.preConstructionInstalment).toBe(60000);
    expect(h?.preConstructionInstalmentNumber).toBe(5);
    expect(h?.interestAllowed).toBe(260000);
    expect(r.totals.income).toBe(-50000);
  });

  it("allows nothing once the five instalments have run, and says so", () => {
    // Completed FY 2020-21: instalments ran 2020-21 to 2024-25.
    //   income = 3,00,000 - 90,000 - 1,00,000 = 1,10,000
    const r = head([
      {
        use: "letOut",
        grossAnnualValue: 300000,
        interestPayable: 100000,
        preConstructionInterest: 300000,
        constructionCompletedFy: "2020-21",
      },
    ]);
    expect(r.houses[0]?.preConstructionInstalment).toBe(0);
    expect(r.houses[0]?.preConstructionInstalmentNumber).toBeNull();
    expect(r.totals.income).toBe(110000);
    expect(r.warnings.join(" ")).toContain("FY 2020-21 to FY 2024-25");
  });

  it("disallows this year's interest on a house completed after this FY", () => {
    // Interest before the year of completion is pre-construction interest.
    const r = head([
      {
        use: "selfOccupied",
        interestPayable: 100000,
        constructionCompletedFy: "2026-27",
      },
    ]);
    expect(r.houses[0]?.interestAllowed).toBe(0);
    expect(r.houses[0]?.interestDisallowed).toBe(100000);
    expect(r.totals.income).toBe(0);
    expect(r.warnings.join(" ")).toContain("after FY 2025-26");
  });

  it("allows no instalment without the completion FY, and says what to pass", () => {
    const r = head([
      {
        use: "selfOccupied",
        interestPayable: 50000,
        preConstructionInterest: 100000,
      },
    ]);
    expect(r.houses[0]?.preConstructionInstalment).toBe(0);
    expect(r.houses[0]?.interestAllowed).toBe(50000);
    expect(r.warnings.join(" ")).toContain("constructionCompletedFy");
  });
});

describe("new regime (s.115BAC(2)(i))", () => {
  it("disallows self-occupied interest, keeps let-out interest, and compute_tax sets nothing off", () => {
    // Hand-worked from s.115BAC(2)(i), s.24(a), s.24(b), s.115BAC(2)(ii)(b):
    //   self-occupied: 1,80,000 claimed, nil allowed, income 0
    //   let-out: NAV 3,00,000; s.24(a) 90,000; interest 2,50,000 -> -40,000
    //   compute_tax (new): nothing set off, 40,000 carried forward
    const r = head(
      [
        { use: "selfOccupied", interestPayable: 180000 },
        { use: "letOut", grossAnnualValue: 300000, interestPayable: 250000 },
      ],
      "new",
    );
    expect(r.houses[0]?.interestAllowed).toBe(0);
    expect(r.houses[0]?.interestDisallowed).toBe(180000);
    expect(r.houses[0]?.income).toBe(0);
    expect(r.houses[1]?.interestAllowed).toBe(250000);
    expect(r.houses[1]?.income).toBe(-40000);
    expect(r.totals.income).toBe(-40000);
    expect(r.selfOccupiedInterestCap).toBe(0);
    expect(r.notes.join(" ")).toContain("s.115BAC(2)(i)");

    const tax = computeTax({ ...salaried("new"), ...r.forComputeTax }, pack);
    expect(tax.housePropertyLossDisallowed).toBe(0);
    expect(tax.housePropertyLossSetOff).toBe(0);
    expect(tax.housePropertyLossCarriedForward).toBe(40000);
  });
});

describe("input handling", () => {
  it("returns a nil head for no houses", () => {
    const r = head([]);
    expect(r.totals.income).toBe(0);
    expect(r.selfOccupiedInterestCap).toBeNull();
    expect(r.forComputeTax).toEqual({
      otherIncome: 0,
      housePropertyLoss: 0,
      housePropertyType: "letOut",
    });
  });

  it("warns on a let-out house with no rent instead of throwing", () => {
    const r = head([{ use: "letOut", interestPayable: 20000 }]);
    expect(r.totals.income).toBe(-20000);
    expect(r.warnings.join(" ")).toContain("s.23(1)(c)");
  });

  it("throws on impossible input", () => {
    expect(() => head([{ use: "letOut", grossAnnualValue: -1 }])).toThrow(
      /non-negative/,
    );
    expect(() =>
      head([
        {
          use: "selfOccupied",
          preConstructionInterest: 1000,
          constructionCompletedFy: "2023-25",
        },
      ]),
    ).toThrow(/financial year/);
  });
});

describe("pre-construction instalments add up to the total", () => {
  it("five instalments of 1,00,003 sum to 1,00,003, not 1,00,005", () => {
    // Completion in FY 2021-22 to 2025-26 puts instalment 5, 4, 3, 2 and 1 in
    // FY 2025-26. Rounding each fifth on its own gives 20,001 x 5 = 1,00,005;
    // cumulative rounding gives 20,001 + 20,000 + 20,001 + 20,000 + 20,001.
    const fys = ["2021-22", "2022-23", "2023-24", "2024-25", "2025-26"];
    const amounts = fys.map(
      (fy) =>
        computeHouseProperty(
          [
            {
              use: "letOut",
              grossAnnualValue: 0,
              preConstructionInterest: 100003,
              constructionCompletedFy: fy,
            },
          ],
          pack,
          "old",
        ).houses[0]?.preConstructionInstalment ?? 0,
    );
    expect(amounts.reduce((s, a) => s + a, 0)).toBe(100003);
  });
});
