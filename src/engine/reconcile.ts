import type { RulePack } from "./rulepack.js";

/** Cross-document reconciliation: Form 16 vs AIS vs 26AS -- the mismatches
 * that trigger 143(1)(a) intimations and 139(9) defect notices.
 *
 * Authority split (verified): 26AS is the ledger of record for TDS credit
 * (CPC restricts credit to 26AS); AIS is the ledger for income lines;
 * Form 16 anchors salary. */

export interface TdsSummaryEntry {
  tan: string;
  deductorName?: string | undefined;
  section?: string | undefined;
  amountPaid: number;
  tdsDeposited: number;
}

export interface ReconcileInput {
  /** Per-TAN TDS entries from 26AS (the ledger of record). */
  form26asTds?: TdsSummaryEntry[];
  /** Salary TDS per Form 16 Part A, one entry per employer TAN. */
  form16?: {
    tan: string;
    grossSalary?: number | undefined;
    tdsDeposited: number;
  }[];
  /** AIS aggregates the user (or parse_ais) computed. */
  ais?: {
    salaryByTan?: Record<string, number> | undefined;
    interestTotal?: number | undefined;
    dividendTotal?: number | undefined;
  };
  /** Figures from the draft return. */
  return?: {
    tdsClaimed?: number | undefined;
    salaryDeclared?: number | undefined;
    interestDeclared?: number | undefined;
    dividendDeclared?: number | undefined;
  };
}

export interface ReconcileFinding {
  id: string;
  severity: "high" | "medium" | "low";
  title: string;
  figures?: { a: number; b: number; delta: number };
  remedy: string;
  noticePreempted?: string;
}

export interface ReconcileReport {
  fy: string;
  findings: ReconcileFinding[];
  checksRun: string[];
  checksSkipped: { id: string; reason: string }[];
  /** TDS in 26AS grouped by the income head its section implies, so the filer
   * knows which schedule each credit belongs against. Sections outside the rule
   * pack's map land under "unmapped" rather than being dropped. */
  tdsByHead: { head: string; sections: string[]; tdsDeposited: number }[];
  disclaimers: string[];
}

type Tier = "pass" | "info" | "warn" | "high";

function tier(delta: number, pack: RulePack): Tier {
  const t = pack.reconcile.toleranceRupees;
  const d = Math.abs(delta);
  if (d <= t.pass) return "pass";
  if (d < t.warn) return "info";
  if (d < t.high) return "warn";
  return "high";
}

/** Map the tolerance tier onto a finding severity. `info` deltas are inside the
 * warn tolerance, so they are reported as low rather than folded into medium. */
function severityFor(t: Tier): ReconcileFinding["severity"] {
  if (t === "high") return "high";
  if (t === "warn") return "medium";
  return "low";
}

/** Sum rupee amounts without float drift: 26AS figures carry paise, and a plain
 * reduce over 40 rows can land Rs 0.0000001 off and trip an exact comparison. */
function sumRupees(values: number[]): number {
  const paise = values.reduce((s, v) => s + Math.round(v * 100), 0);
  return paise / 100;
}

/** Group 26AS TDS by income head using the rule pack's section map. A section
 * the pack does not know is reported as "unmapped" -- silently dropping it would
 * hide TDS the filer still has to place in a schedule. */
function groupTdsByHead(
  rows: TdsSummaryEntry[],
  pack: RulePack,
): ReconcileReport["tdsByHead"] {
  const map = pack.tdsSectionToHead;
  const byHead = new Map<
    string,
    { sections: Set<string>; amounts: number[] }
  >();

  for (const row of rows) {
    const section = row.section?.trim() ?? "";
    const head = (section && map[section]) || "unmapped";
    const bucket = byHead.get(head) ?? { sections: new Set(), amounts: [] };
    if (section) bucket.sections.add(section);
    bucket.amounts.push(row.tdsDeposited);
    byHead.set(head, bucket);
  }

  return [...byHead.entries()]
    .map(([head, b]) => ({
      head,
      sections: [...b.sections].sort(),
      tdsDeposited: sumRupees(b.amounts),
    }))
    .sort((a, b) => b.tdsDeposited - a.tdsDeposited);
}

export function reconcile(
  input: ReconcileInput,
  pack: RulePack,
): ReconcileReport {
  const findings: ReconcileFinding[] = [];
  const checksRun: string[] = [];
  const checksSkipped: { id: string; reason: string }[] = [];

  const tds26 = input.form26asTds ?? [];
  const total26asTds = sumRupees(tds26.map((e) => e.tdsDeposited));

  // H1: return TDS claim vs 26AS deposited (exact -- CPC restricts to 26AS)
  if (input.return?.tdsClaimed !== undefined && tds26.length > 0) {
    checksRun.push("H1");
    if (input.return.tdsClaimed > total26asTds) {
      findings.push({
        id: "H1",
        severity: "high",
        title: "TDS claimed in return exceeds 26AS deposited total",
        figures: {
          a: input.return.tdsClaimed,
          b: total26asTds,
          delta: input.return.tdsClaimed - total26asTds,
        },
        remedy:
          "CPC restricts credit to 26AS; the excess claim yields a 143(1) demand. Ask the deductor to revise their TDS return (correction window: 6 years).",
        noticePreempted: "143(1) adjustment",
      });
    }
  } else {
    checksSkipped.push({
      id: "H1",
      reason: "needs return.tdsClaimed + form26asTds",
    });
  }

  // H3: employer TANs in 26AS s.192 vs Form 16s supplied
  const salary26Tans = new Set(
    tds26.filter((e) => e.section === "192").map((e) => e.tan),
  );
  if (salary26Tans.size > 0 && input.form16) {
    checksRun.push("H3");
    const f16Tans = new Set(input.form16.map((f) => f.tan));
    for (const tan of salary26Tans) {
      if (!f16Tans.has(tan)) {
        findings.push({
          id: "H3",
          severity: "high",
          title: `Salary TDS from TAN ${tan} in 26AS has no matching Form 16`,
          remedy:
            "Classic job-switch trigger: salary from a second employer missing from the return. Include ALL employers' salary; get the missing Form 16.",
          noticePreempted: "143(1)(a)(vi)",
        });
      }
    }
  } else {
    checksSkipped.push({
      id: "H3",
      reason: "needs 26AS section-192 rows + form16 list",
    });
  }

  // H4: AIS interest vs declared
  if (
    input.ais?.interestTotal !== undefined &&
    input.return?.interestDeclared !== undefined
  ) {
    checksRun.push("H4");
    const delta = input.ais.interestTotal - input.return.interestDeclared;
    const t = tier(delta, pack);
    if (delta > 0 && t !== "pass") {
      findings.push({
        id: "H4",
        severity: severityFor(t),
        title: "AIS interest exceeds interest declared in return",
        figures: {
          a: input.ais.interestTotal,
          b: input.return.interestDeclared,
          delta,
        },
        remedy:
          "Report GROSS accrued interest and claim 80TTA (10K) / 80TTB (50K senior) separately -- netting before reporting triggers 143(1)(a). Joint account? Use AIS feedback 'Information relates to another PAN/Year'.",
        noticePreempted: "143(1)(a)",
      });
    }
  } else {
    checksSkipped.push({
      id: "H4",
      reason: "needs ais.interestTotal + return.interestDeclared",
    });
  }

  // H5: AIS dividend vs declared
  if (
    input.ais?.dividendTotal !== undefined &&
    input.return?.dividendDeclared !== undefined
  ) {
    checksRun.push("H5");
    const delta = input.ais.dividendTotal - input.return.dividendDeclared;
    const t = tier(delta, pack);
    if (delta > 0 && t !== "pass") {
      findings.push({
        id: "H5",
        severity: severityFor(t),
        title: "AIS dividend exceeds dividend declared in return",
        figures: {
          a: input.ais.dividendTotal,
          b: input.return.dividendDeclared,
          delta,
        },
        remedy:
          "Report gross dividend (before TDS). Company + RTA duplicates: use AIS feedback 'Information is duplicate / included in other information'.",
        noticePreempted: "143(1)(a)",
      });
    }
  } else {
    checksSkipped.push({
      id: "H5",
      reason: "needs ais.dividendTotal + return.dividendDeclared",
    });
  }

  // M1: Form 16 Part A deposited vs 26AS per TAN (exact)
  if (input.form16 && tds26.length > 0) {
    checksRun.push("M1");
    // Index once instead of re-filtering per Form 16: the LLM composes both
    // arrays, so a mis-scaled call made this O(form16 x tds26).
    const tds26ByTan = new Map<string, typeof tds26>();
    for (const e of tds26) {
      const bucket = tds26ByTan.get(e.tan);
      if (bucket) bucket.push(e);
      else tds26ByTan.set(e.tan, [e]);
    }
    for (const f16 of input.form16) {
      const rows26 = tds26ByTan.get(f16.tan) ?? [];
      const from26 = sumRupees(rows26.map((e) => e.tdsDeposited));
      // No rows at all is the WORST case (nothing deposited against this TAN),
      // so it must not be skipped the way a zero-TDS-but-present TAN can be.
      if (rows26.length === 0) {
        findings.push({
          id: "M1",
          severity: "high",
          title: `Form 16 shows TDS for TAN ${f16.tan} but 26AS has no entry for that TAN`,
          figures: { a: f16.tdsDeposited, b: 0, delta: f16.tdsDeposited },
          remedy:
            "The deductor has not filed (or has mis-quoted your PAN in) their TDS return: nothing is creditable until 26AS shows it. Contact the deductor before claiming this TDS.",
          noticePreempted: "143(1) adjustment",
        });
        continue;
      }
      const delta = f16.tdsDeposited - from26;
      if (delta !== 0) {
        findings.push({
          id: "M1",
          severity: severityFor(tier(delta, pack)),
          title: `Form 16 TDS deposited (TAN ${f16.tan}) differs from 26AS`,
          figures: {
            a: f16.tdsDeposited,
            b: from26,
            delta,
          },
          remedy:
            "Deductor filing inconsistency between 24Q and OLTAS -- ask the employer to verify their TDS return.",
        });
      }
    }
  } else {
    checksSkipped.push({ id: "M1", reason: "needs form16 + form26asTds" });
  }

  // M3: Form 16 gross salary vs AIS salary per TAN (gross-to-gross only, Rs 10 slack)
  if (input.form16 && input.ais?.salaryByTan) {
    checksRun.push("M3");
    for (const f16 of input.form16) {
      if (f16.grossSalary === undefined) continue;
      const aisSalary = input.ais.salaryByTan[f16.tan];
      if (aisSalary === undefined) continue;
      const delta = f16.grossSalary - aisSalary;
      if (tier(delta, pack) !== "pass") {
        findings.push({
          id: "M3",
          severity: "medium",
          title: `Form 16 gross salary differs from AIS salary (TAN ${f16.tan})`,
          figures: { a: f16.grossSalary, b: aisSalary, delta },
          remedy:
            "Employer 24Q Annexure-II inconsistency. Compare gross-to-gross only -- never Form 16 taxable salary vs AIS.",
        });
      }
    }
  } else {
    checksSkipped.push({
      id: "M3",
      reason: "needs form16.grossSalary + ais.salaryByTan",
    });
  }

  // M4: salary declared in the return vs the sum of Form 16 gross salaries.
  // A declared figure BELOW the forms is the 139(9)/143(1)(a) trigger; above is
  // legitimate (arrears, perquisites, a missing Form 16).
  const f16WithSalary = (input.form16 ?? []).filter(
    (f) => f.grossSalary !== undefined,
  );
  if (
    input.return?.salaryDeclared !== undefined &&
    f16WithSalary.length > 0 &&
    f16WithSalary.length === (input.form16?.length ?? 0)
  ) {
    checksRun.push("M4");
    const totalF16Salary = sumRupees(
      f16WithSalary.map((f) => f.grossSalary ?? 0),
    );
    const delta = totalF16Salary - input.return.salaryDeclared;
    const t = tier(delta, pack);
    if (delta > 0 && t !== "pass") {
      findings.push({
        id: "M4",
        severity: severityFor(t),
        title:
          "Salary declared in return is below the total Form 16 gross salary",
        figures: {
          a: totalF16Salary,
          b: input.return.salaryDeclared,
          delta,
        },
        remedy:
          "Declare GROSS salary from every Form 16, then claim exemptions (HRA, LTA) and the standard deduction as separate lines -- netting them into the salary figure is the top 143(1)(a) trigger. If a second employer is missing, add it.",
        noticePreempted: "143(1)(a)(vi)",
      });
    }
  } else {
    checksSkipped.push({
      id: "M4",
      reason: "needs return.salaryDeclared + grossSalary on every form16 entry",
    });
  }

  // M5: 26AS rows with TDS deposited but no amount paid/credited. ITR schedule
  // TDS needs both columns, and a blank gross is a 139(9) defect risk.
  if (tds26.length > 0) {
    checksRun.push("M5");
    const orphans = tds26.filter(
      (e) => e.tdsDeposited > 0 && !(e.amountPaid > 0),
    );
    if (orphans.length > 0) {
      findings.push({
        id: "M5",
        severity: "low",
        title: `${orphans.length} 26AS row(s) show TDS deposited with no amount paid/credited`,
        remedy:
          "Schedule TDS wants the gross amount alongside the tax deducted. Re-check the parsed rows against the TRACES export (a blank gross column is usually a parse artefact, occasionally a deductor error) and fill the gross from the payer's statement.",
        noticePreempted: "139(9) defect",
      });
    }
  } else {
    checksSkipped.push({ id: "M5", reason: "needs form26asTds" });
  }

  return {
    fy: pack.fy,
    findings,
    checksRun,
    checksSkipped,
    tdsByHead: groupTdsByHead(tds26, pack),
    disclaimers: [
      "Tolerances beyond the Rs 10 statutory rounding slack are tool heuristics, not CPC rules.",
      "A return figure lower than form figures may be legitimately explained by HRA exemption, standard deduction, or Chapter VI-A deductions -- review findings before acting.",
      "Not tax advice. Verify against the official portal before filing.",
    ],
  };
}
