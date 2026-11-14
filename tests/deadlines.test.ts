import { describe, expect, it } from "vitest";
import { filingStatus } from "../src/engine/deadlines.js";
import { loadRulePack } from "../src/engine/rulepack.js";

const pack = loadRulePack("2025-26");

function group(status: ReturnType<typeof filingStatus>, key: string) {
  const g = status.groups.find((x) => x.group === key);
  if (!g) throw new Error(`no group ${key}`);
  return g;
}

describe("filingStatus", () => {
  it("2026-07-15: before every due date", () => {
    const s = filingStatus("2026-07-15", pack);
    expect(s.fy).toBe("2025-26");
    expect(s.groups.map((g) => g.phase)).toEqual([
      "beforeDueDate",
      "beforeDueDate",
      "beforeDueDate",
    ]);
    expect(group(s, "itr1_2").daysToDueDate).toBe(16);
    expect(group(s, "itr3_4_nonAudit").daysToDueDate).toBe(47);
    expect(group(s, "audit").daysToDueDate).toBe(108);
    expect(group(s, "itr1_2").lateFee234F).toBeNull();
    expect(group(s, "itr1_2").interest234A.running).toBe(false);
    const itr12 = s.deadlines.find((d) => d.key === "itr1_2");
    expect(itr12?.date).toBe("2026-07-31");
    expect(itr12?.passed).toBe(false);
    expect(itr12?.citation).toBe(pack.deadlineCitations.itr1_2);
    expect(s.deadlines).toHaveLength(Object.keys(pack.deadlines).length);
    expect(s.revised?.open).toBe(true);
    expect(s.revised?.fee234I).toBe(false);
  });

  it("2026-11-14: belated window for every group, 47 days left", () => {
    const s = filingStatus("2026-11-14", pack);
    for (const g of s.groups) {
      expect(g.phase).toBe("belatedWindow");
      expect(g.daysToBelatedEnd).toBe(47);
      expect(g.lateFee234F).toEqual({
        default: 5000,
        incomeUpTo5L: 1000,
        incomeThreshold: 500000,
      });
      expect(g.interest234A.running).toBe(true);
    }
    const itr12 = group(s, "itr1_2");
    expect(itr12.daysToDueDate).toBe(-106);
    expect(itr12.interest234A.from).toBe("2026-08-01");
    expect(itr12.interest234A.monthsSoFar).toBe(4);
    expect(group(s, "audit").daysToDueDate).toBe(-14);
    expect(group(s, "audit").interest234A.from).toBe("2026-11-01");
    expect(group(s, "audit").interest234A.monthsSoFar).toBe(1);
    expect(s.revised?.open).toBe(true);
    expect(s.revised?.fee234I).toBe(false);
  });

  it("2027-01-05: updated return only; revised window open with the 234I fee", () => {
    const s = filingStatus("2027-01-05", pack);
    for (const g of s.groups) {
      expect(g.phase).toBe("updatedReturnOnly");
      expect(g.lateFee234F).toBeNull();
      expect(g.daysToBelatedEnd).toBe(-5);
    }
    expect(s.revised?.open).toBe(true);
    expect(s.revised?.daysLeft).toBe(85);
    expect(s.revised?.fee234I).toBe(true);
    // s.234-I (Finance Act 2026 s.16): Rs 5,000, or Rs 1,000 up to Rs 5 lakh.
    expect(s.revised?.fee234IAmount).toEqual({
      default: 5000,
      incomeUpTo5L: 1000,
      incomeThreshold: 500000,
    });
    expect(s.revised?.summary).toContain("s.234I fee of Rs 5,000");
  });

  it("the day of a due date is still on time", () => {
    const s = filingStatus("2026-07-31", pack);
    const g = group(s, "itr1_2");
    expect(g.phase).toBe("beforeDueDate");
    expect(g.daysToDueDate).toBe(0);
    expect(g.lateFee234F).toBeNull();
    const d = s.deadlines.find((x) => x.key === "itr1_2");
    expect(d?.daysLeft).toBe(0);
    expect(d?.passed).toBe(false);
    expect(filingStatus("2026-08-01", pack).groups[0]?.phase).toBe(
      "belatedWindow",
    );
  });

  it("the belated end date and the fee-free revision date are inclusive", () => {
    const s = filingStatus("2026-12-31", pack);
    expect(group(s, "audit").phase).toBe("belatedWindow");
    expect(s.revised?.fee234I).toBe(false);
  });

  it("advance tax for 2026-02-10: 15 March 2026 is next", () => {
    const s = filingStatus("2026-02-10", pack);
    expect(s.advanceTax.fy).toBe("2025-26");
    expect(s.advanceTax.covered).toBe(true);
    expect(s.advanceTax.installments.map((i) => i.dueDate)).toEqual([
      "2025-06-15",
      "2025-09-15",
      "2025-12-15",
      "2026-03-15",
    ]);
    expect(s.advanceTax.installments.map((i) => i.passed)).toEqual([
      true,
      true,
      true,
      false,
    ]);
    expect(s.advanceTax.next?.dueDate).toBe("2026-03-15");
    expect(s.advanceTax.next?.daysLeft).toBe(33);
    expect(s.advanceTax.next?.cumulativePct).toBe(1);
  });

  it("advance tax for 2026-11-14 with no FY 2026-27 pack says so", () => {
    const s = filingStatus("2026-11-14", pack);
    expect(s.advanceTax.fy).toBe("2026-27");
    expect(s.advanceTax.covered).toBe(false);
    expect(s.advanceTax.installments).toEqual([]);
    expect(s.advanceTax.next).toBeNull();
    expect(s.notes.join(" ")).toContain("FY 2026-27");
  });

  it("uses currentYearPack when its fy matches the year of asOf", () => {
    const next = { ...pack, fy: "2026-27", ay: "2027-28" };
    const s = filingStatus("2026-11-14", pack, next);
    expect(s.advanceTax.covered).toBe(true);
    expect(s.advanceTax.installments.map((i) => i.dueDate)).toEqual([
      "2026-06-15",
      "2026-09-15",
      "2026-12-15",
      "2027-03-15",
    ]);
    expect(s.advanceTax.next?.dueDate).toBe("2026-12-15");
    expect(s.advanceTax.next?.daysLeft).toBe(31);
  });

  it("rejects an impossible asOf", () => {
    expect(() => filingStatus("2026-02-30", pack)).toThrow(/asOf/);
    expect(() => filingStatus("14-11-2026", pack)).toThrow(/asOf/);
  });
});
