import { createCipheriv, pbkdf2Sync, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { computeTax } from "../src/engine/compute.js";
import { compute80GG, computeHra } from "../src/engine/hra.js";
import {
  floor100,
  interest234A,
  interest234B,
  interest234C,
} from "../src/engine/interest.js";
import { reconcile } from "../src/engine/reconcile.js";
import { loadRulePack } from "../src/engine/rulepack.js";
import {
  AisDecryptError,
  decryptAis,
  parseAisDocument,
} from "../src/parsers/ais.js";

const pack = loadRulePack("2025-26");

describe("rule 119A rounding", () => {
  it("floors interest principal to the lower Rs 100", () => {
    // Verified ITD example: 3,125 -> 3,100
    expect(floor100(3125, pack)).toBe(3100);
    expect(floor100(3100, pack)).toBe(3100);
    expect(floor100(99, pack)).toBe(0);
  });
});

describe("interest234A (golden cases)", () => {
  it("8,400 outstanding, 5 months late -> 420", () => {
    const r = interest234A(
      { taxOnTotalIncomeNetOfPrepaid: 8400, months: 5 },
      pack,
    );
    expect(r.applies).toBe(true);
    // 8,400 is already a multiple of 100, so 119A(c) does not bite.
    expect(r.base).toBe(8400);
    expect(r.interest).toBe(420);
  });

  it("23,000 outstanding, 1 month late -> 230", () => {
    const r = interest234A(
      { taxOnTotalIncomeNetOfPrepaid: 23000, months: 1 },
      pack,
    );
    expect(r.interest).toBe(230);
  });

  it("nil when the return is on time", () => {
    const r = interest234A(
      { taxOnTotalIncomeNetOfPrepaid: 50000, months: 0 },
      pack,
    );
    expect(r.applies).toBe(false);
    expect(r.interest).toBe(0);
    expect(r.note).toContain("on or before the due date");
  });

  it("nil when nothing is outstanding, and says the 234F fee can still apply", () => {
    // A late return with full TDS coverage carries no 234A -- only s.234F.
    const r = interest234A(
      { taxOnTotalIncomeNetOfPrepaid: 0, months: 6 },
      pack,
    );
    expect(r.applies).toBe(false);
    expect(r.interest).toBe(0);
    expect(r.note).toContain("234F");
  });

  it("floors the principal to the lower Rs 100 before charging", () => {
    // 12,345 -> 12,300 -> x1% x2 = 246, not 246.90.
    const r = interest234A(
      { taxOnTotalIncomeNetOfPrepaid: 12345, months: 2 },
      pack,
    );
    expect(r.base).toBe(12300);
    expect(r.interest).toBe(246);
  });
});

describe("interest234B (golden cases)", () => {
  it("Suraj: 18,400 assessed, no advance, paid 31 Aug -> 920", () => {
    const r = interest234B(
      { assessedTax: 18400, advanceTaxPaid: 0, months: 5 },
      pack,
    );
    expect(r.applies).toBe(true);
    expect(r.interest).toBe(920);
  });

  it("no 234B when advance >= 90% of assessed", () => {
    // Company case: base 2,90,000; paid 2,67,000; 90% = 2,61,000
    const r = interest234B(
      { assessedTax: 290000, advanceTaxPaid: 267000, months: 4 },
      pack,
    );
    expect(r.applies).toBe(false);
    expect(r.interest).toBe(0);
  });

  it("s.234B(2): a s.140A payment cuts the principal from its own month on", () => {
    // 1,00,000 shortfall over 6 months is 6,000 flat. Paying 60,000 in month 4
    // leaves 1,00,000 for months 1-4 (4,000) and 40,000 for months 5-6 (800).
    const r = interest234B(
      {
        assessedTax: 100000,
        advanceTaxPaid: 0,
        months: 6,
        selfAssessmentPayments: [{ monthsFromApril: 4, amount: 60000 }],
      },
      pack,
    );
    expect(r.segments.map((s) => [s.months, s.base, s.interest])).toEqual([
      [4, 100000, 4000],
      [2, 40000, 800],
    ]);
    expect(r.interest).toBe(4800);
    expect(r.note).toContain("s.234B(2)");
  });

  it("s.234B(2): each segment principal is floored under Rule 119A(c)", () => {
    // Residue 39,950 floors to 39,900 before the 2-month charge -> 798.
    const r = interest234B(
      {
        assessedTax: 100000,
        advanceTaxPaid: 0,
        months: 6,
        selfAssessmentPayments: [{ monthsFromApril: 4, amount: 60050 }],
      },
      pack,
    );
    expect(r.segments[1]?.base).toBe(39900);
    expect(r.interest).toBe(4798);
  });

  it("s.234B(2): payments arrive unordered and are applied chronologically", () => {
    const r = interest234B(
      {
        assessedTax: 100000,
        advanceTaxPaid: 0,
        months: 6,
        selfAssessmentPayments: [
          { monthsFromApril: 5, amount: 20000 },
          { monthsFromApril: 3, amount: 50000 },
        ],
      },
      pack,
    );
    // months 1-3 on 1,00,000 (3,000); 4-5 on 50,000 (1,000); 6 on 30,000 (300)
    expect(r.segments.map((s) => s.months)).toEqual([3, 2, 1]);
    expect(r.interest).toBe(4300);
  });
});

describe("interest234C (golden cases)", () => {
  it("Khushal: only Dec short, 119A floor exercised -> 93", () => {
    // liability 45,500; cumulative paid 8,000/19,000/31,000/45,500
    // Dec shortfall 34,125-31,000 = 3,125 -> floor 3,100 -> x1% x3 = 93
    const r = interest234C(
      {
        taxDueOnReturnedIncome: 45500,
        cumulativePaid: [8000, 19000, 31000, 45500],
      },
      pack,
    );
    // Jun: paid 8,000 >= 12% of 45,500 (5,460) -> safe harbor
    expect(r.installments[0]?.safeHarborApplied).toBe(true);
    // Sep: paid 19,000 >= 36% (16,380) -> safe harbor
    expect(r.installments[1]?.safeHarborApplied).toBe(true);
    expect(r.installments[2]?.interest).toBe(93);
    expect(r.installments[3]?.interest).toBe(0);
    expect(r.totalInterest).toBe(93);
  });

  it("company safe-harbor branch -> 605", () => {
    // base 2,90,000: Jun 40,000 >= 12% (34,800) nil; Sep 1,05,000 >= 36% (1,04,400) nil;
    // Dec shortfall 2,17,500-2,05,000 = 12,500 x 3% = 375; Mar 2,90,000-2,67,000 = 23,000 x 1% = 230
    const r = interest234C(
      {
        taxDueOnReturnedIncome: 290000,
        cumulativePaid: [40000, 105000, 205000, 267000],
      },
      pack,
    );
    expect(r.installments[0]?.interest).toBe(0);
    expect(r.installments[1]?.interest).toBe(0);
    expect(r.installments[2]?.interest).toBe(375);
    expect(r.installments[3]?.interest).toBe(230);
    expect(r.totalInterest).toBe(605);
  });

  it("ClearTax below-safe-harbor branch -> 2,600 (shortfall from 15%, not 12%)", () => {
    // liability 1,00,000; paid 5,000/25,000/35,000/50,000
    const r = interest234C(
      {
        taxDueOnReturnedIncome: 100000,
        cumulativePaid: [5000, 25000, 35000, 50000],
      },
      pack,
    );
    // Jun: 5% < 12% -> shortfall from 15,000: 10,000 x 3% = 300
    expect(r.installments[0]?.interest).toBe(300);
    // Sep: 25% < 36% -> shortfall 45,000-25,000 = 20,000 x 3% = 600
    expect(r.installments[1]?.interest).toBe(600);
    // Dec: 75,000-35,000 = 40,000 x 3% = 1,200
    expect(r.installments[2]?.interest).toBe(1200);
    // Mar: 1,00,000-50,000 = 50,000 x 1% = 500
    expect(r.installments[3]?.interest).toBe(500);
    expect(r.totalInterest).toBe(2600);
  });

  it("safe harbor boundary: exactly 12% is nil, 11.99% measures from 15%", () => {
    const base = 100000;
    const atHarbor = interest234C(
      {
        taxDueOnReturnedIncome: base,
        cumulativePaid: [12000, 45000, 75000, 100000],
      },
      pack,
    );
    expect(atHarbor.installments[0]?.interest).toBe(0);
    const below = interest234C(
      {
        taxDueOnReturnedIncome: base,
        cumulativePaid: [11990, 45000, 75000, 100000],
      },
      pack,
    );
    // shortfall = 15,000 - 11,990 = 3,010 -> floor 3,000 -> x3% = 90
    expect(below.installments[0]?.interest).toBe(90);
  });

  it("below 10K liability: not applicable", () => {
    const r = interest234C(
      { taxDueOnReturnedIncome: 9000, cumulativePaid: [0, 0, 0, 0] },
      pack,
    );
    expect(r.applies).toBe(false);
  });

  it("presumptive: single Mar installment, 1 month", () => {
    const r = interest234C(
      {
        taxDueOnReturnedIncome: 50000,
        cumulativePaid: [0, 0, 0, 30000],
        presumptive: true,
      },
      pack,
    );
    expect(r.installments.length).toBe(1);
    // shortfall 20,000 x 1% x 1 = 200
    expect(r.totalInterest).toBe(200);
  });
});

describe("computeHra (golden cases)", () => {
  it("metro vs non-metro (Anwar): 1,62,000 / 1,29,600", () => {
    // salary 3,24,000/yr; HRA 1,80,000; rent 1,94,400
    const base = {
      months: 12,
      basic: 324000,
      hraReceived: 180000,
      rentPaid: 194400,
    };
    const metro = computeHra([{ ...base, isMetro: true }], pack);
    // limbs: A=1,80,000; B=1,94,400-32,400=1,62,000; C=1,62,000 -> 1,62,000
    expect(metro.totalExempt).toBe(162000);
    const nonMetro = computeHra([{ ...base, isMetro: false }], pack);
    // C = 40% = 1,29,600 -> least
    expect(nonMetro.totalExempt).toBe(129600);
  });

  it("salary includes retirement DA + turnover commission (Vinod): 91,200", () => {
    // basic 4,00,000 + DA 80,000 + commission 48,000 = 5,28,000
    // HRA 1,20,000; rent 1,44,000; non-metro
    // limbs: A=1,20,000; B=1,44,000-52,800=91,200; C=2,11,200 -> 91,200
    const r = computeHra(
      [
        {
          months: 12,
          basic: 400000,
          daRetirement: 80000,
          turnoverCommission: 48000,
          hraReceived: 120000,
          rentPaid: 144000,
          isMetro: false,
        },
      ],
      pack,
    );
    expect(r.totalExempt).toBe(91200);
  });

  it("new regime: exemption 0, HRA fully taxable", () => {
    const r = computeHra(
      [
        {
          months: 12,
          basic: 500000,
          hraReceived: 100000,
          rentPaid: 120000,
          isMetro: true,
        },
      ],
      pack,
      "new",
    );
    expect(r.totalExempt).toBe(0);
    expect(r.totalTaxable).toBe(100000);
  });

  it("landlord PAN warning above 1L annual rent", () => {
    const r = computeHra(
      [
        {
          months: 12,
          basic: 600000,
          hraReceived: 200000,
          rentPaid: 150000,
          isMetro: true,
        },
      ],
      pack,
    );
    expect(r.warnings.some((w) => w.includes("landlord PAN"))).toBe(true);
  });

  it("80GG limbs: cap / 25% / rent-excess", () => {
    // cap limb: high income, high rent -> 5,000 x 12 = 60,000
    expect(
      compute80GG({ rentPaid: 200000, adjustedTotalIncome: 1000000 }, pack)
        .deduction,
    ).toBe(60000);
    // 25% limb: ATI 2,00,000 -> 50,000 when rent allows
    expect(
      compute80GG({ rentPaid: 200000, adjustedTotalIncome: 200000 }, pack)
        .deduction,
    ).toBe(50000);
    // rent limb: rent 60,000, ATI 1,80,000 -> 60,000-18,000 = 42,000
    expect(
      compute80GG({ rentPaid: 60000, adjustedTotalIncome: 180000 }, pack)
        .deduction,
    ).toBe(42000);
  });

  it("80GG cap limb is Rs 5,000 PER MONTH, so a part year caps lower", () => {
    // 7 months of tenancy: cap limb 5,000 x 7 = 35,000, not the annual 60,000.
    const r = compute80GG(
      { rentPaid: 200000, adjustedTotalIncome: 1000000, months: 7 },
      pack,
    );
    expect(r.limbs.cap).toBe(35000);
    expect(r.deduction).toBe(35000);
  });

  it("80GG is barred under the new regime and when any HRA was received", () => {
    const newRegime = compute80GG(
      { rentPaid: 200000, adjustedTotalIncome: 1000000 },
      pack,
      "new",
    );
    expect(newRegime.eligible).toBe(false);
    expect(newRegime.deduction).toBe(0);

    const withHra = compute80GG(
      {
        rentPaid: 200000,
        adjustedTotalIncome: 1000000,
        hraReceivedAnyMonth: true,
      },
      pack,
    );
    expect(withHra.eligible).toBe(false);
    expect(withHra.deduction).toBe(0);
    expect(withHra.warnings.some((w) => w.includes("mutually exclusive"))).toBe(
      true,
    );
  });

  it("80GG never returns a negative deduction when rent is below 10% of ATI", () => {
    const r = compute80GG(
      { rentPaid: 10000, adjustedTotalIncome: 1000000 },
      pack,
    );
    expect(r.limbs.rentExcess).toBe(0);
    expect(r.deduction).toBe(0);
  });

  it("warns when the periods do not cover all 12 months", () => {
    const r = computeHra(
      [
        {
          months: 9,
          basic: 450000,
          hraReceived: 90000,
          rentPaid: 108000,
          isMetro: true,
        },
      ],
      pack,
    );
    expect(r.warnings.some((w) => w.includes("9 months"))).toBe(true);
  });
});

describe("old-regime 87A fix", () => {
  const base = {
    regime: "old" as const,
    salaryIncome: 0,
    otherIncome: 0,
    stcg111A: 0,
    ltcg112A: 0,
    deductions: 0,
    ageBand: "below60" as const,
  };

  it("threshold tests TOTAL income: 4.9L normal + 2L LTCG denies the rebate", () => {
    const r = computeTax(
      { ...base, otherIncome: 490000, ltcg112A: 200000 },
      pack,
    );
    // total income 6.9L > 5L -> no 87A even though normal income is under 5L
    expect(r.rebate87A).toBe(0);
  });

  it("87A can offset 111A STCG tax under the old regime", () => {
    const r = computeTax(
      { ...base, otherIncome: 200000, stcg111A: 250000 },
      pack,
    );
    // s.111A proviso: normal income 2L leaves 50,000 of the 2.5L basic
    // exemption unexhausted, which reduces the gains to 2,00,000 -> tax 40,000.
    expect(r.basicExemptionSetOff).toBe(50000);
    expect(r.taxableStcg111A).toBe(200000);
    // total 4.5L <= 5L -> rebate applies: min(40,000, 12,500) = 12,500 off STCG
    expect(r.rebate87A).toBe(12500);
    expect(r.stcgTax).toBe(27500);
  });

  it("87A never offsets 112A LTCG tax", () => {
    const r = computeTax(
      { ...base, otherIncome: 200000, ltcg112A: 250000 },
      pack,
    );
    // (2.5L - 1.25L exemption) = 1.25L, less the 50,000 unexhausted basic
    // exemption (s.112A(2) proviso) = 75,000 -> tax 9,375, and 87A cannot touch it.
    expect(r.taxableLtcg112A).toBe(75000);
    expect(r.ltcgTax).toBe(9375);
    expect(r.rebate87A).toBe(0);
  });
});

describe("AIS decrypt (synthetic round-trip)", () => {
  function encryptAis(payload: object, password: string): string {
    const iv = randomBytes(16);
    const salt = randomBytes(16);
    const key = pbkdf2Sync(password, salt, 1000, 32, "sha256");
    const cipher = createCipheriv("aes-256-cbc", key, iv);
    const ct = Buffer.concat([
      cipher.update(JSON.stringify(payload), "utf8"),
      cipher.final(),
    ]);
    return iv.toString("hex") + salt.toString("hex") + ct.toString("base64");
  }

  const doc = {
    partA: {
      columnLabel: ["Name", "PAN"],
      columnData: [["Test User", "ABCDE1234F"]],
    },
    partB: {
      sections: [
        {
          title: "TDS/TCS Information",
          elements: [
            {
              title: "Salary (Section 192)",
              l1Src: "EMPLOYER LTD",
              l1: {
                columnLabel: [
                  "TAN",
                  "Amount Paid/Credited",
                  "Tax Deducted",
                  "Date",
                ],
                columnData: [["ABCD12345E", "1500000", "150000", "2026-03-31"]],
              },
            },
          ],
        },
      ],
    },
  };

  it("decrypts with the peppered pan+dob password", () => {
    const pepperedPw = "abcde1234f" + "GQ39%*g" + "01011990";
    const blob = encryptAis(doc, pepperedPw);
    const out = decryptAis(blob, { pan: "ABCDE1234F", dob: "01-01-1990" });
    expect(out).toEqual(doc);
  });

  it("falls back to the un-peppered password", () => {
    const blob = encryptAis(doc, "abcde1234f01011990");
    const out = decryptAis(blob, { pan: "ABCDE1234F", dob: "01011990" });
    expect(out).toEqual(doc);
  });

  it("explicit password wins", () => {
    const blob = encryptAis(doc, "custom-secret");
    const out = decryptAis(blob, { password: "custom-secret" });
    expect(out).toEqual(doc);
  });

  it("fails actionably on a wrong password", () => {
    const blob = encryptAis(doc, "right-password");
    expect(() =>
      decryptAis(blob, { pan: "ABCDE1234F", dob: "02021992" }),
    ).toThrow(AisDecryptError);
  });

  it("a wrong DOB never reports the format as changed", () => {
    // AES-CBC accepts a wrong key whenever the trailing bytes form valid PKCS#7
    // padding, so a plain DOB typo used to surface as "the AIS export format has
    // changed -- file an issue". Sweep enough wrong DOBs to hit that branch: the
    // survivor rate is ~1/256 per attempt, so 400 keys make a miss vanishingly
    // unlikely. Every failure must name the DOB, never the format.
    const blob = encryptAis(doc, "abcde1234f" + "GQ39%*g" + "01011990");
    for (let d = 0; d < 400; d++) {
      const dob = `${String((d % 28) + 1).padStart(2, "0")}${String((d % 12) + 1).padStart(2, "0")}${1950 + d}`;
      if (dob === "01011990") continue;
      let message = "";
      try {
        decryptAis(blob, { pan: "ABCDE1234F", dob });
        throw new Error(`wrong DOB ${dob} decrypted successfully`);
      } catch (err) {
        expect(err).toBeInstanceOf(AisDecryptError);
        message = (err as Error).message;
      }
      expect(message).not.toContain("format has changed");
      expect(message).toContain("DOB");
    }
  });

  it("parseAisDocument ignores labels past the end of a row", () => {
    // A hostile file can declare far more labels than any row has cells. The
    // parser must cost O(row), not O(labels): iterating the label list per row
    // made a 3.5 MB file block the single-threaded server for ~97s.
    const wide = {
      partB: {
        sections: [
          {
            title: "SFT",
            elements: [
              {
                title: "Securities",
                l1: {
                  columnLabel: Array.from(
                    { length: 200_000 },
                    (_, i) => `c${i}`,
                  ),
                  columnData: Array.from({ length: 20_000 }, () => ["1000"]),
                },
              },
            ],
          },
        ],
      },
    };
    const started = Number(process.hrtime.bigint());
    const parsed = parseAisDocument(wide);
    const elapsedMs = (Number(process.hrtime.bigint()) - started) / 1e6;
    expect(parsed.rows.length).toBe(20_000);
    // Only the first cell carries data, so each row keeps exactly one field.
    expect(Object.keys(parsed.rows[0]?.fields ?? {})).toEqual(["c0"]);
    // Measured on this shape: 8519ms iterating labels per row, 10ms iterating
    // the row. The threshold sits ~100x above the fixed cost and ~8x below the
    // quadratic one, so it discriminates without being flaky on a slow runner.
    expect(elapsedMs).toBeLessThan(1000);
  });

  it("parseAisDocument normalizes rows with label-matched fields", () => {
    const parsed = parseAisDocument(doc);
    expect(parsed.taxpayer.PAN).toBe("ABCDE1234F");
    expect(parsed.rows.length).toBe(1);
    const row = parsed.rows[0];
    expect(row?.sectionTitle).toBe("TDS/TCS Information");
    expect(row?.source).toBe("EMPLOYER LTD");
    expect(row?.amount).toBe(1500000);
    expect(row?.date).toBe("2026-03-31");
  });
});

describe("reconcile", () => {
  it("H1: TDS over-claim vs 26AS", () => {
    const r = reconcile(
      {
        form26asTds: [
          {
            tan: "ABCD12345E",
            section: "192",
            amountPaid: 1500000,
            tdsDeposited: 140000,
          },
        ],
        return: { tdsClaimed: 150000 },
      },
      pack,
    );
    const h1 = r.findings.find((f) => f.id === "H1");
    expect(h1?.severity).toBe("high");
    expect(h1?.figures?.delta).toBe(10000);
  });

  it("H3: missing employer Form 16", () => {
    const r = reconcile(
      {
        form26asTds: [
          {
            tan: "AAAA11111A",
            section: "192",
            amountPaid: 800000,
            tdsDeposited: 50000,
          },
          {
            tan: "BBBB22222B",
            section: "192",
            amountPaid: 600000,
            tdsDeposited: 30000,
          },
        ],
        form16: [{ tan: "AAAA11111A", tdsDeposited: 50000 }],
      },
      pack,
    );
    const h3 = r.findings.find((f) => f.id === "H3");
    expect(h3?.title).toContain("BBBB22222B");
  });

  it("H4: AIS interest above declared, Rs 10 slack respected", () => {
    const clean = reconcile(
      { ais: { interestTotal: 50008 }, return: { interestDeclared: 50000 } },
      pack,
    );
    expect(clean.findings.find((f) => f.id === "H4")).toBeUndefined();
    const dirty = reconcile(
      { ais: { interestTotal: 65000 }, return: { interestDeclared: 50000 } },
      pack,
    );
    expect(dirty.findings.find((f) => f.id === "H4")?.severity).toBe("high");
  });

  it("skipped checks are reported with reasons", () => {
    const r = reconcile({}, pack);
    expect(r.findings).toEqual([]);
    expect(r.checksSkipped.length).toBeGreaterThan(0);
    expect(r.checksSkipped.every((s) => s.reason.length > 0)).toBe(true);
  });

  it("M4: declared salary below the Form 16 total", () => {
    const r = reconcile(
      {
        form16: [
          { tan: "AAAA11111A", grossSalary: 1200000, tdsDeposited: 90000 },
          { tan: "BBBB22222B", grossSalary: 600000, tdsDeposited: 30000 },
        ],
        return: { salaryDeclared: 1200000 },
      },
      pack,
    );
    const m4 = r.findings.find((f) => f.id === "M4");
    expect(m4?.severity).toBe("high");
    expect(m4?.figures?.delta).toBe(600000);
    expect(m4?.noticePreempted).toBe("143(1)(a)(vi)");
  });

  it("M1: a Form 16 TAN entirely absent from 26AS is HIGH, not skipped", () => {
    const r = reconcile(
      {
        form26asTds: [
          {
            tan: "AAAA11111A",
            section: "192",
            amountPaid: 1200000,
            tdsDeposited: 90000,
          },
        ],
        form16: [
          { tan: "AAAA11111A", tdsDeposited: 90000 },
          { tan: "CCCC33333C", tdsDeposited: 25000 },
        ],
      },
      pack,
    );
    const m1 = r.findings.filter((f) => f.id === "M1");
    expect(m1.length).toBe(1);
    expect(m1[0]?.severity).toBe("high");
    expect(m1[0]?.title).toContain("CCCC33333C");
    expect(m1[0]?.figures?.delta).toBe(25000);
  });

  it("M5: 26AS rows with TDS but no gross amount", () => {
    const r = reconcile(
      {
        form26asTds: [
          {
            tan: "AAAA11111A",
            section: "194A",
            amountPaid: 0,
            tdsDeposited: 500,
          },
        ],
      },
      pack,
    );
    const m5 = r.findings.find((f) => f.id === "M5");
    expect(m5?.noticePreempted).toBe("139(9) defect");
  });

  it("groups 26AS TDS by income head, unmapped sections included", () => {
    const r = reconcile(
      {
        form26asTds: [
          {
            tan: "AAAA11111A",
            section: "192",
            amountPaid: 1200000,
            tdsDeposited: 90000,
          },
          {
            tan: "BBBB22222B",
            section: "194A",
            amountPaid: 50000,
            tdsDeposited: 5000,
          },
          {
            tan: "CCCC33333C",
            section: "194Z",
            amountPaid: 10000,
            tdsDeposited: 1000,
          },
        ],
      },
      pack,
    );
    // Sorted by amount, so salary leads.
    expect(r.tdsByHead[0]).toEqual({
      head: "salary",
      sections: ["192"],
      tdsDeposited: 90000,
    });
    const unmapped = r.tdsByHead.find((h) => h.head === "unmapped");
    expect(unmapped?.sections).toEqual(["194Z"]);
    expect(unmapped?.tdsDeposited).toBe(1000);
  });

  it("sums TDS in paise so long lists do not drift", () => {
    // 3 x 33.33 sums to 99.99000000000001 with plain float addition.
    const r = reconcile(
      {
        form26asTds: [33.33, 33.33, 33.33].map((tdsDeposited, i) => ({
          tan: `AAAA1111${i}A`,
          section: "194A",
          amountPaid: 1000,
          tdsDeposited,
        })),
        return: { tdsClaimed: 99.99 },
      },
      pack,
    );
    expect(r.tdsByHead[0]?.tdsDeposited).toBe(99.99);
    // Claim equals the deposited total exactly, so no H1 over-claim finding.
    expect(r.findings.find((f) => f.id === "H1")).toBeUndefined();
  });
});

describe("rule pack validation", () => {
  it("rejects an FY outside the available-years allow-list", () => {
    expect(() => loadRulePack("../package")).toThrow(/no rule pack/);
    expect(() => loadRulePack("2024-25")).toThrow(/Available: 2025-26/);
  });

  it("exposes every section the engine reads", () => {
    // If a future pack drops one of these, validatePack throws at load time
    // instead of a TypeError surfacing mid tool call.
    for (const key of [
      "interest",
      "hra",
      "deduction80GG",
      "reconcile",
      "tdsSectionToHead",
      "itrEligibility",
      "rounding",
    ] as const) {
      expect(pack[key]).toBeDefined();
    }
    expect(pack.oldRegime.slabsSenior.length).toBeGreaterThan(0);
    expect(pack.oldRegime.slabsSuperSenior.length).toBeGreaterThan(0);
  });
});
