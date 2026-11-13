import type { RulePack } from "./rulepack.js";

/** Calendar arithmetic for the interest sections, so a caller passes dates and
 * the month counts come out of code instead of being worked out by the model.
 * Dates are ISO `YYYY-MM-DD` strings and are handled in UTC throughout: a
 * filing date has no time of day, and local time would shift it near midnight. */

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

interface Ymd {
  y: number;
  m: number;
  d: number;
}

/** Parse `YYYY-MM-DD`, rejecting impossible dates such as 2026-02-30. */
export function parseIsoDate(value: string): Ymd | null {
  const match = ISO_DATE_RE.exec(value);
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  const t = new Date(Date.UTC(y, m - 1, d));
  if (
    t.getUTCFullYear() !== y ||
    t.getUTCMonth() !== m - 1 ||
    t.getUTCDate() !== d
  ) {
    return null;
  }
  return { y, m, d };
}

function requireDate(value: string, label: string): Ymd {
  const parsed = parseIsoDate(value);
  if (!parsed) {
    throw new Error(
      `${label} must be a real date as YYYY-MM-DD, got "${value}"`,
    );
  }
  return parsed;
}

function toUtc(p: Ymd): number {
  return Date.UTC(p.y, p.m - 1, p.d);
}

function fromUtc(ms: number): Ymd {
  const t = new Date(ms);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

function toIso(p: Ymd): string {
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

/** `start` moved forward by `months`, the day clamped to the target month. */
function addMonths(start: Ymd, months: number): Ymd {
  const index = start.m - 1 + months;
  const y = start.y + Math.floor(index / 12);
  const m = (((index % 12) + 12) % 12) + 1;
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { y, m, d: Math.min(start.d, lastDay) };
}

/** Months of interest for a period running from `start` to `end`, both days
 * included. Rule 119A(b): where interest is charged for every month or part of
 * a month, a part month counts as a full one (`partMonthIsFullMonth`); with the
 * flag off only whole months count. An `end` before `start` is zero months.
 * 1 April to 20 July is 3 months and 20 days, so 4. */
export function interestMonths(
  start: string,
  end: string,
  partMonthIsFullMonth: boolean,
): number {
  const s = requireDate(start, "start date");
  const e = requireDate(end, "end date");
  if (toUtc(e) < toUtc(s)) return 0;

  // Work with the day after `end` so the period is [start, endExclusive).
  const endExclusive = fromUtc(toUtc(e) + DAY_MS);
  let whole = (endExclusive.y - s.y) * 12 + (endExclusive.m - s.m);
  if (endExclusive.d < s.d) whole -= 1;
  while (whole > 0 && toUtc(addMonths(s, whole)) > toUtc(endExclusive)) {
    whole -= 1;
  }
  const partMonth = toUtc(addMonths(s, whole)) < toUtc(endExclusive);
  return whole + (partMonth && partMonthIsFullMonth ? 1 : 0);
}

/** First day of 234B interest, from the pack's `interest.s234B.fromDate`. */
export function start234B(pack: RulePack): string {
  const token = pack.interest.s234B.fromDate;
  if (token !== "AY-04-01") {
    throw new Error(
      `rule pack fy${pack.fy}.json: unknown interest.s234B.fromDate "${token}" (this engine understands "AY-04-01")`,
    );
  }
  return `${pack.ay.slice(0, 4)}-04-01`;
}

/** First day of 234A interest for a given s.139(1) due date, from the pack's
 * `interest.s234A.fromDate`. */
export function start234A(dueDate: string, pack: RulePack): string {
  const token = pack.interest.s234A.fromDate;
  if (token !== "dueDatePlus1") {
    throw new Error(
      `rule pack fy${pack.fy}.json: unknown interest.s234A.fromDate "${token}" (this engine understands "dueDatePlus1")`,
    );
  }
  const due = requireDate(dueDate, "due date");
  return toIso(fromUtc(toUtc(due) + DAY_MS));
}
