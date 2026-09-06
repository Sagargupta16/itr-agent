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
  it("any loss flag adds the s.80 date-sensitivity note", () => {
    const r = recommendItrForm(
      { ...base, losses: { ...noLosses, business: true } },
      pack,
    );
    const note = r.notes.find((x) => x.includes("s.80"));
    expect(note).toBeDefined();
    expect(note).toContain(r.dueDate);
    expect(note).toContain("s.139(4)");
    expect(note).toContain("s.71B");
  });

  it("no loss flag means no s.80 note", () => {
    const r = recommendItrForm(base, pack);
    expect(r.notes.some((x) => x.includes("s.80"))).toBe(false);
  });

  it("director flag bumps to ITR-2", () => {
    const r = recommendItrForm({ ...base, isDirector: true }, pack);
    expect(r.recommended).toBe("ITR-2");
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
});
