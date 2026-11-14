import { interestMonths, parseIsoDate, start234A } from "./dates.js";
import type { LowIncomeFee, RulePack } from "./rulepack.js";

/** Filing status as of a given date: which return deadlines have passed, how
 * many days are left and which late-filing consequences now run, so the caller
 * never compares dates itself. Pure: the caller passes `asOf` (today in
 * Asia/Kolkata); every date and fee comes from the rule pack. */

const DAY_MS = 86_400_000;

export interface DeadlineEntry {
  key: string;
  date: string;
  citation: string | null;
  /** Negative once the date has passed; 0 on the day itself. */
  daysLeft: number;
  /** True only after the date (the day itself is still on time). */
  passed: boolean;
}

export type FilingPhase =
  | "beforeDueDate"
  | "belatedWindow"
  | "updatedReturnOnly";

export interface FormGroupStatus {
  group: string;
  forms: string;
  dueKey: string;
  dueDate: string;
  daysToDueDate: number;
  phase: FilingPhase;
  belatedUntil: string;
  daysToBelatedEnd: number;
  /** s.234F fee for a return filed now; null while the return is on time or
   * once only an updated return is possible. */
  lateFee234F: LowIncomeFee | null;
  /** s.234A interest on unpaid tax: running from the day after the due date. */
  interest234A: {
    running: boolean;
    ratePerMonth: number;
    from: string | null;
    /** Months so far, Rule 119A(b); null while not running. */
    monthsSoFar: number | null;
  };
  summary: string;
}

export interface RevisedReturnStatus {
  open: boolean;
  until: string;
  daysLeft: number;
  /** True when a revision filed now attracts the s.234I fee. */
  fee234I: boolean;
  /** The s.234I fee bands from the pack while `fee234I` is true, else null. */
  fee234IAmount: LowIncomeFee | null;
  feeFreeUntil: string | null;
  summary: string;
}

export interface AdvanceTaxInstallmentStatus {
  dueDate: string;
  cumulativePct: number;
  passed: boolean;
  daysLeft: number;
  next: boolean;
}

export interface AdvanceTaxStatus {
  /** Financial year that contains asOf, e.g. "2026-27". */
  fy: string;
  /** False when no supplied pack covers that year (no figures then). */
  covered: boolean;
  installments: AdvanceTaxInstallmentStatus[];
  next: AdvanceTaxInstallmentStatus | null;
  summary: string;
}

export interface FilingStatus {
  asOf: string;
  fy: string;
  ay: string;
  deadlines: DeadlineEntry[];
  groups: FormGroupStatus[];
  revised: RevisedReturnStatus | null;
  advanceTax: AdvanceTaxStatus;
  summaries: string[];
  notes: string[];
  disclaimers: string[];
}

function requireDate(value: string, label: string): number {
  const p = parseIsoDate(value);
  if (!p) {
    throw new Error(
      `${label} must be a real date as YYYY-MM-DD, got "${value}"`,
    );
  }
  return Date.UTC(p.y, p.m - 1, p.d);
}

function daysBetween(fromMs: number, toMs: number): number {
  return Math.round((toMs - fromMs) / DAY_MS);
}

/** Financial year label (April to March) that contains the date. */
function financialYearOf(asOf: string): string {
  const p = parseIsoDate(asOf);
  if (!p) throw new Error(`asOf must be YYYY-MM-DD, got "${asOf}"`);
  const start = p.m >= 4 ? p.y : p.y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

const GROUPS: { group: string; forms: string; dueKey: string }[] = [
  { group: "itr1_2", forms: "ITR-1 / ITR-2", dueKey: "itr1_2" },
  {
    group: "itr3_4_nonAudit",
    forms: "ITR-3 / ITR-4 (non-audit)",
    dueKey: "itr3_4_nonAudit",
  },
  { group: "audit", forms: "Audit cases", dueKey: "audit" },
];

function dayWord(n: number): string {
  const abs = Math.abs(n);
  return `${abs} day${abs === 1 ? "" : "s"}`;
}

function inr(n: number): string {
  return `Rs ${n.toLocaleString("en-IN")}`;
}

function advanceTaxStatus(
  asOfMs: number,
  asOf: string,
  pack: RulePack,
  currentYearPack: RulePack | undefined,
  notes: string[],
): AdvanceTaxStatus {
  const fy = financialYearOf(asOf);
  const source =
    currentYearPack?.fy === fy ? currentYearPack : pack.fy === fy ? pack : null;
  if (!source) {
    notes.push(
      `No rule pack covers FY ${fy} (the year that contains ${asOf}), so its advance tax instalments are not listed.`,
    );
    return {
      fy,
      covered: false,
      installments: [],
      next: null,
      summary: `Advance tax for FY ${fy}: no rule pack for that year, so no dates are given.`,
    };
  }

  const startYear = Number.parseInt(fy.slice(0, 4), 10);
  const installments: AdvanceTaxInstallmentStatus[] = [];
  let nextSet = false;
  for (const inst of source.advanceTax.installments) {
    const [mm, dd] = inst.dueDate.split("-");
    const month = Number(mm);
    const year = month < 4 ? startYear + 1 : startYear;
    const date = `${year}-${String(mm)}-${String(dd)}`;
    const daysLeft = daysBetween(asOfMs, requireDate(date, "advance tax date"));
    const passed = daysLeft < 0;
    const next = !passed && !nextSet;
    if (next) nextSet = true;
    installments.push({
      dueDate: date,
      cumulativePct: inst.cumulativePct,
      passed,
      daysLeft,
      next,
    });
  }
  const next = installments.find((i) => i.next) ?? null;
  const summary = next
    ? `Advance tax FY ${fy}: next instalment ${next.dueDate} (${Math.round(next.cumulativePct * 100)}% cumulative), ${dayWord(next.daysLeft)} left.`
    : `Advance tax FY ${fy}: every instalment date has passed.`;
  return { fy, covered: true, installments, next, summary };
}

/** Which deadlines of `pack.fy` have passed as of `asOf`, what each form group
 * owes for filing now, the revised-return window, and the advance tax
 * instalments of the financial year that contains `asOf`. */
export function filingStatus(
  asOf: string,
  pack: RulePack,
  currentYearPack?: RulePack,
): FilingStatus {
  const asOfMs = requireDate(asOf, "asOf");
  const notes: string[] = [];
  const summaries: string[] = [];

  const deadlines: DeadlineEntry[] = Object.entries(pack.deadlines).map(
    ([key, date]) => {
      const daysLeft = daysBetween(
        asOfMs,
        requireDate(date, `deadline ${key}`),
      );
      return {
        key,
        date,
        citation: pack.deadlineCitations[key] ?? null,
        daysLeft,
        passed: daysLeft < 0,
      };
    },
  );

  const belated = pack.deadlines.belated;
  if (!belated) {
    throw new Error(`rule pack fy${pack.fy}.json has no deadlines.belated`);
  }
  const belatedMs = requireDate(belated, "deadline belated");
  const daysToBelatedEnd = daysBetween(asOfMs, belatedMs);

  const groups: FormGroupStatus[] = [];
  for (const g of GROUPS) {
    const due = pack.deadlines[g.dueKey];
    if (!due) continue;
    const daysToDue = daysBetween(
      asOfMs,
      requireDate(due, `deadline ${g.dueKey}`),
    );
    const phase: FilingPhase =
      daysToDue >= 0
        ? "beforeDueDate"
        : daysToBelatedEnd >= 0
          ? "belatedWindow"
          : "updatedReturnOnly";

    const rate = pack.interest.s234A.ratePerMonth;
    let from: string | null = null;
    let monthsSoFar: number | null = null;
    if (phase !== "beforeDueDate") {
      from = start234A(due, pack);
      monthsSoFar = interestMonths(
        from,
        asOf,
        pack.interest.partMonthIsFullMonth,
      );
    }
    const fee = phase === "belatedWindow" ? { ...pack.lateFee234F } : null;

    let summary: string;
    if (phase === "beforeDueDate") {
      summary =
        daysToDue === 0
          ? `${g.forms}: due today (${due}), last day to file on time with no s.234F fee.`
          : `${g.forms}: due ${due}, ${dayWord(daysToDue)} left; on time means no s.234F fee and no s.234A interest.`;
    } else if (phase === "belatedWindow") {
      summary = `${g.forms}: due date ${due} passed ${dayWord(daysToDue)} ago; a belated return is allowed until ${belated} (${dayWord(daysToBelatedEnd)} left) with the s.234F fee (${inr(fee?.default ?? 0)}, or ${inr(fee?.incomeUpTo5L ?? 0)} if total income is up to ${inr(fee?.incomeThreshold ?? 0)}) and s.234A interest at ${rate * 100}% a month, ${monthsSoFar} month(s) so far.`;
    } else {
      summary = `${g.forms}: due date ${due} and the belated window (${belated}) have both passed; only an updated return remains.`;
    }

    groups.push({
      group: g.group,
      forms: g.forms,
      dueKey: g.dueKey,
      dueDate: due,
      daysToDueDate: daysToDue,
      phase,
      belatedUntil: belated,
      daysToBelatedEnd,
      lateFee234F: fee,
      interest234A: {
        running: phase !== "beforeDueDate",
        ratePerMonth: rate,
        from,
        monthsSoFar,
      },
      summary,
    });
    summaries.push(summary);
  }

  let revised: RevisedReturnStatus | null = null;
  const revisedDate = pack.deadlines.revised;
  if (revisedDate) {
    const daysLeft = daysBetween(
      asOfMs,
      requireDate(revisedDate, "deadline revised"),
    );
    const feeFreeUntil = pack.deadlines.revisedWithoutFee234I ?? null;
    const fee234I =
      feeFreeUntil !== null &&
      asOfMs > requireDate(feeFreeUntil, "deadline revisedWithoutFee234I");
    const open = daysLeft >= 0;
    const summary = !open
      ? `Revised return: the window closed on ${revisedDate}.`
      : `Revised return: open until ${revisedDate} (${dayWord(daysLeft)} left)${
          feeFreeUntil === null
            ? "."
            : fee234I
              ? `; a revision now attracts the s.234I fee of ${inr(pack.fee234I.default)}, or ${inr(pack.fee234I.incomeUpTo5L)} if total income is up to ${inr(pack.fee234I.incomeThreshold)} (fee-free only up to ${feeFreeUntil}).`
              : `; no s.234I fee if filed by ${feeFreeUntil}.`
        }`;
    revised = {
      open,
      until: revisedDate,
      daysLeft,
      fee234I,
      fee234IAmount: fee234I ? { ...pack.fee234I } : null,
      feeFreeUntil,
      summary,
    };
    summaries.push(summary);
  }

  const advanceTax = advanceTaxStatus(
    asOfMs,
    asOf,
    pack,
    currentYearPack,
    notes,
  );
  summaries.push(advanceTax.summary);

  return {
    asOf,
    fy: pack.fy,
    ay: pack.ay,
    deadlines,
    groups,
    revised,
    advanceTax,
    summaries,
    notes,
    disclaimers: [
      "Not tax advice. Dates and fees come from the rule pack; the Central Board of Direct Taxes can extend a due date by notification, which this does not model.",
      `The s.234F fee depends on total income (the lower figure applies up to ${inr(pack.lateFee234F.incomeThreshold)}); confirm the band before quoting one.`,
    ],
  };
}
