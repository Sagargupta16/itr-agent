import { describe, expect, it } from "vitest";
import {
  filingChecklist,
  type ItrFormInput,
  recommendItrForm,
} from "../src/engine/itr-form.js";
import { loadRulePack } from "../src/engine/rulepack.js";

const pack = loadRulePack("2025-26");

const noLosses = {
  business: false,
  speculative: false,
  capital: false,
  houseProperty: false,
};

const base: ItrFormInput = {
  residency: "resident",
  totalIncome: 1800000,
  houseProperties: 0,
  stcg111A: 0,
  ltcg112A: 0,
  hasOtherCapitalGains: false,
  hasBusinessIncome: false,
  presumptive: false,
  isPartnerInFirm: false,
  losses: noLosses,
  hasForeignAssetsOrIncome: false,
  isDirector: false,
  holdsUnlistedShares: false,
  agriIncome: 0,
  esopDeferral: false,
  hasLotteryOrGamingIncome: false,
};

describe("recommendItrForm", () => {
  it("plain salaried resident under 50L gets ITR-1", () => {
    const r = recommendItrForm(base, pack);
    expect(r.recommended).toBe("ITR-1");
    expect(r.dueDate).toBe("2026-07-31");
  });

  it("LTCG 112A within 1.25L stays ITR-1 (AY 2025-26 carve-in)", () => {
    const r = recommendItrForm({ ...base, ltcg112A: 100000 }, pack);
    expect(r.recommended).toBe("ITR-1");
    expect(r.notes.some((n) => n.includes("1.25L"))).toBe(true);
  });

  it("LTCG 112A above 1.25L bumps to ITR-2", () => {
    const r = recommendItrForm({ ...base, ltcg112A: 200000 }, pack);
    expect(r.recommended).toBe("ITR-2");
    expect(r.ruledOut.some((h) => h.form === "ITR-1")).toBe(true);
  });

  it("any 111A STCG bumps to ITR-2", () => {
    const r = recommendItrForm({ ...base, stcg111A: 1 }, pack);
    expect(r.recommended).toBe("ITR-2");
  });

  it("foreign RSUs (Schedule FA) bump to ITR-2", () => {
    const r = recommendItrForm(
      { ...base, hasForeignAssetsOrIncome: true },
      pack,
    );
    expect(r.recommended).toBe("ITR-2");
    expect(r.ruledOut.some((h) => h.rule.includes("Schedule FA"))).toBe(true);
  });

  it("income above 50L bumps to ITR-2", () => {
    const r = recommendItrForm({ ...base, totalIncome: 5000001 }, pack);
    expect(r.recommended).toBe("ITR-2");
  });

  it("NRI cannot file ITR-1", () => {
    const r = recommendItrForm({ ...base, residency: "nri" }, pack);
    expect(r.recommended).toBe("ITR-2");
  });

  it("business income needs ITR-3 with the later deadline", () => {
    const r = recommendItrForm({ ...base, hasBusinessIncome: true }, pack);
    expect(r.recommended).toBe("ITR-3");
    expect(r.dueDate).toBe("2026-08-31");
  });

  // The issue #3 real-world case: zero current-year business income, but a
  // brought-forward business loss. ITR-2 would abandon the carry-forward.
  it("business-loss continuity forces ITR-3 even with no business income", () => {
    const r = recommendItrForm(
      { ...base, losses: { ...noLosses, business: true } },
      pack,
    );
    expect(r.recommended).toBe("ITR-3");
    expect(r.reasons.some((x) => x.includes("carry-forward"))).toBe(true);
    expect(r.notes.some((x) => x.includes("No Account Case"))).toBe(true);
  });

  it("presumptive with no disqualifier gets ITR-4", () => {
    const r = recommendItrForm(
      {
        ...base,
        totalIncome: 1200000,
        hasBusinessIncome: true,
        presumptive: true,
      },
      pack,
    );
    expect(r.recommended).toBe("ITR-4");
  });

  it("presumptive with business-loss continuity still forces ITR-3", () => {
    const r = recommendItrForm(
      {
        ...base,
        hasBusinessIncome: true,
        presumptive: true,
        losses: { ...noLosses, business: true },
      },
      pack,
    );
    expect(r.recommended).toBe("ITR-3");
  });

  it("capital-loss carry-forward alone bumps ITR-1 to ITR-2", () => {
    const r = recommendItrForm(
      { ...base, losses: { ...noLosses, capital: true } },
      pack,
    );
    expect(r.recommended).toBe("ITR-2");
  });

  // s.80: the ITR-3 "keeps the carry-forward alive" reason is only true for a
  // return filed by the due date, and filingChecklist says so separately -- the
  // two tools must not contradict each other.
  it.each([
    ["business", { ...noLosses, business: true }],
    ["speculative", { ...noLosses, speculative: true }],
    ["capital", { ...noLosses, capital: true }],
  ])("a %s loss adds the s.80 date-sensitivity note", (_label, losses) => {
    const r = recommendItrForm({ ...base, losses }, pack);
    const note = r.notes.find((x) => x.includes("s.80"));
    expect(note).toBeDefined();
    expect(note).toContain("s.139(4)");
    expect(note).toContain("s.71B");
  });

  // The note names business, speculative and capital losses as the ones s.80
  // forfeits, and in the same breath says a house-property loss survives under
  // s.71B. Firing it for a house-property-only filer would warn them about a
  // deadline for losses they do not have.
  it("a house-property-only loss does not add the s.80 note", () => {
    const r = recommendItrForm(
      { ...base, losses: { ...noLosses, houseProperty: true } },
      pack,
    );
    expect(r.notes.some((x) => x.includes("s.80"))).toBe(false);
  });

  // The due date is the pack's non-audit value and recommendItrForm takes no
  // audit/44AB input, so the note must not assert it as the filer's deadline.
  it("the s.80 note does not assert a calendar due date", () => {
    const r = recommendItrForm(
      { ...base, losses: { ...noLosses, business: true } },
      pack,
    );
    const note = r.notes.find((x) => x.includes("s.80"));
    expect(note).toBeDefined();
    expect(note).not.toContain(r.dueDate);
    expect(note).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  // dueDate can only ever be a non-audit date here, so the caveat rides on
  // every response and not just the ones that happen to carry a loss note.
  it.each([
    ["no losses", noLosses],
    ["a business loss", { ...noLosses, business: true }],
    ["a house-property loss", { ...noLosses, houseProperty: true }],
  ])("flags dueDate as the non-audit date with %s", (_label, losses) => {
    const r = recommendItrForm({ ...base, losses }, pack);
    expect(r.notes).toContain(
      "Deadlines are the non-audit dates from the rule pack; audit cases differ.",
    );
  });

  it("no loss flag means no s.80 note", () => {
    const r = recommendItrForm(base, pack);
    expect(r.notes.some((x) => x.includes("s.80"))).toBe(false);
  });

  it("director flag bumps to ITR-2", () => {
    const r = recommendItrForm({ ...base, isDirector: true }, pack);
    expect(r.recommended).toBe("ITR-2");
  });

  // CBDT Notification 45/2026: the AY 2026-27 ITR-1/ITR-4 admit TWO house
  // properties. "More than one" was the AY 2025-26 rule.
  it("two house properties stay in ITR-1 (AY 2026-27); three bump to ITR-2", () => {
    expect(
      recommendItrForm({ ...base, houseProperties: 2 }, pack).recommended,
    ).toBe("ITR-1");
    const three = recommendItrForm({ ...base, houseProperties: 3 }, pack);
    expect(three.recommended).toBe("ITR-2");
    expect(three.ruledOut.some((h) => h.rule.includes("more than 2"))).toBe(
      true,
    );
  });

  it("s.194N TDS bars ITR-1 but not ITR-4", () => {
    const salaried = recommendItrForm({ ...base, tds194N: true }, pack);
    expect(salaried.recommended).toBe("ITR-2");
    expect(salaried.ruledOut.some((h) => h.rule.includes("194N"))).toBe(true);
    const presumptive = recommendItrForm(
      {
        ...base,
        totalIncome: 1200000,
        hasBusinessIncome: true,
        presumptive: true,
        tds194N: true,
      },
      pack,
    );
    expect(presumptive.recommended).toBe("ITR-4");
  });

  describe("presumptive ceilings", () => {
    const trader = {
      ...base,
      totalIncome: 1200000,
      hasBusinessIncome: true,
      presumptive: true,
    };

    it("44AD above Rs 2 crore forces ITR-3 (3 crore only with cash receipts within 5%)", () => {
      const over = recommendItrForm(
        { ...trader, presumptiveScheme: "44AD", presumptiveTurnover: 25000000 },
        pack,
      );
      expect(over.recommended).toBe("ITR-3");
      expect(
        over.reasons.some((x) => x.includes("44AD turnover exceeds")),
      ).toBe(true);
      const digital = recommendItrForm(
        {
          ...trader,
          presumptiveScheme: "44AD",
          presumptiveTurnover: 25000000,
          cashReceiptsWithin5Pct: true,
        },
        pack,
      );
      expect(digital.recommended).toBe("ITR-4");
    });

    it("44ADA above Rs 50 lakh forces ITR-3 (75 lakh with cash receipts within 5%)", () => {
      const over = recommendItrForm(
        { ...trader, presumptiveScheme: "44ADA", presumptiveTurnover: 6000000 },
        pack,
      );
      expect(over.recommended).toBe("ITR-3");
      const digital = recommendItrForm(
        {
          ...trader,
          presumptiveScheme: "44ADA",
          presumptiveTurnover: 6000000,
          cashReceiptsWithin5Pct: true,
        },
        pack,
      );
      expect(digital.recommended).toBe("ITR-4");
    });

    it("says so when the turnover was not supplied", () => {
      const r = recommendItrForm(trader, pack);
      expect(r.recommended).toBe("ITR-4");
      expect(r.notes.some((n) => n.includes("NOT checked"))).toBe(true);
    });

    it("presumptive plus non-presumptive business forces ITR-3", () => {
      const r = recommendItrForm(
        { ...trader, hasNonPresumptiveBusiness: true },
        pack,
      );
      expect(r.recommended).toBe("ITR-3");
    });
  });

  it("returns the statutory citation for the due date and the revised deadline", () => {
    const itr1 = recommendItrForm(base, pack);
    expect(itr1.dueDateCitation).toContain("s.139(1)");
    expect(itr1.revisedDeadline).toBe("2027-03-31");
    expect(itr1.notes.some((n) => n.includes("s.234I"))).toBe(true);
    const itr3 = recommendItrForm({ ...base, hasBusinessIncome: true }, pack);
    expect(itr3.dueDate).toBe("2026-08-31");
    expect(itr3.dueDateCitation).toContain("Finance Act 2026");
  });

  it("the lottery disqualifier names both simple forms", () => {
    const r = recommendItrForm(
      {
        ...base,
        hasBusinessIncome: true,
        presumptive: true,
        hasLotteryOrGamingIncome: true,
      },
      pack,
    );
    const hit = r.ruledOut.find((h) => h.rule.includes("lottery"));
    expect(hit?.form).toBe("ITR-4");
    expect(hit?.rule).toContain("ITR-4");
  });
});

describe("filingChecklist", () => {
  it("ITR-1 checklist ends with e-verification and never auto-submits", () => {
    const c = filingChecklist("ITR-1", pack);
    const last = c.steps[c.steps.length - 1];
    expect(last?.phase).toBe("verify");
    expect(c.steps.some((s) => s.detail.includes("only you"))).toBe(true);
    expect(c.dueDate).toBe("2026-07-31");
  });

  it("ITR-3 checklist includes Schedule BP gathering and the later deadline", () => {
    const c = filingChecklist("ITR-3", pack);
    expect(c.steps.some((s) => s.action.includes("business/F&O"))).toBe(true);
    expect(c.dueDate).toBe("2026-08-31");
  });

  it("steps are contiguously numbered from 1", () => {
    const c = filingChecklist("ITR-2", pack);
    expect(c.steps.map((s) => s.step)).toEqual(
      Array.from({ length: c.steps.length }, (_, i) => i + 1),
    );
  });

  it("Schedule AL threshold is Rs 1 crore, not 50 lakh", () => {
    const c = filingChecklist("ITR-2", pack);
    const schedules = c.steps.find(
      (s) => s.action === "Fill the extra schedules",
    );
    expect(schedules?.detail).toContain("Rs 100 lakh");
    expect(schedules?.detail).not.toContain("50L");
    expect(c.dueDateCitation).toContain("s.139(1)");
    expect(c.notes.some((n) => n.includes("s.234I"))).toBe(true);
  });
});
