import { readFile, stat } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { scheduleAdvanceTax } from "./engine/advance-tax.js";
import { computeTax, type TaxInput } from "./engine/compute.js";
import { compute80GG, computeHra, type HraPeriod } from "./engine/hra.js";
import { interest234A, interest234B, interest234C } from "./engine/interest.js";
import {
  filingChecklist,
  type ItrFormInput,
  recommendItrForm,
} from "./engine/itr-form.js";
import { type ReconcileInput, reconcile } from "./engine/reconcile.js";
import { availableYears, DEFAULT_FY, loadRulePack } from "./engine/rulepack.js";
import {
  AisDecryptError,
  decryptAis,
  parseAisDocument,
} from "./parsers/ais.js";
import { parseForm26AS } from "./parsers/form26as.js";

const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;

// Rs 1 lakh crore. No individual return reaches it, and without a ceiling a
// caller-supplied 1e308 overflows the sum to Infinity, which JSON.stringify
// then serializes as `null` -- so every tax figure came back null on success.
const MAX_RUPEES = 1e12;

// A 26AS/AIS export is a few MB at worst. Past this, readFile succeeds and the
// failure surfaces later as a bare V8 "Invalid string length" with no remedy
// named, or as the tool's path error, which misdiagnoses a size problem.
const MAX_DOC_BYTES = 64 * 1024 * 1024;

/** Read a user-supplied document path, distinguishing missing from oversized. */
async function readDocument(
  path: string,
  hint: string,
): Promise<{ text: string } | { error: string }> {
  try {
    const info = await stat(path);
    if (info.isDirectory()) {
      return { error: `${path} is a directory, not a file. ${hint}` };
    }
    if (info.size > MAX_DOC_BYTES) {
      return {
        error: `file is ${Math.round(info.size / 1024 / 1024)} MB, above the ${MAX_DOC_BYTES / 1024 / 1024} MB limit. A genuine export is a few MB -- check that this is the right file.`,
      };
    }
    return { text: await readFile(path, "utf8") };
  } catch {
    return { error: `could not read file: ${path}. ${hint}` };
  }
}

const taxInputShape = {
  regime: z
    .enum(["new", "old"])
    .describe(
      "Tax regime. 'new' (115BAC) is the default regime since FY 2023-24.",
    ),
  salaryIncome: z
    .number()
    .min(0)
    .max(MAX_RUPEES)
    .default(0)
    .describe("Gross salary income in INR, before standard deduction"),
  otherIncome: z
    .number()
    .min(0)
    .max(MAX_RUPEES)
    .default(0)
    .describe("Other normal-rate income in INR (interest, net rent, etc.)"),
  stcg111A: z
    .number()
    .min(0)
    .max(MAX_RUPEES)
    .default(0)
    .describe(
      "Short-term capital gains under section 111A (listed equity, STT paid) in INR",
    ),
  ltcg112A: z
    .number()
    .min(0)
    .max(MAX_RUPEES)
    .default(0)
    .describe(
      "Long-term capital gains under section 112A in INR, BEFORE the 1.25L exemption",
    ),
  deductions: z
    .number()
    .min(0)
    .max(MAX_RUPEES)
    .default(0)
    .describe(
      "Old regime only: total Chapter VI-A deductions (80C, 80D, ...) in INR. Ignored under the new regime.",
    ),
  ageBand: z
    .enum(["below60", "senior", "superSenior"])
    .default("below60")
    .describe(
      "Age band: below60, senior (60-79), superSenior (80+). Affects old-regime exemption only.",
    ),
  fy: z
    .string()
    .default(DEFAULT_FY)
    .describe("Fiscal year, e.g. '2025-26' (AY 2026-27)"),
};

const interest234Shape = {
  assessedTax: z
    .number()
    .min(0)
    .max(MAX_RUPEES)
    .describe(
      "234B base: tax on total income minus TDS/TCS and reliefs, in INR (advance tax is NOT deducted here)",
    ),
  advanceTaxPaid: z
    .number()
    .min(0)
    .max(MAX_RUPEES)
    .default(0)
    .describe("Total advance tax paid during the FY, in INR"),
  monthsFor234B: z
    .number()
    .int()
    .min(0)
    .max(36)
    .describe(
      "Months from 1 April of the AY to the date of payment or assessment (part month = full month). Filing on 20 July of the AY is 4.",
    ),
  selfAssessmentPayments: z
    .array(
      z.object({
        monthsFromApril: z
          .number()
          .int()
          .min(1)
          .max(36)
          .describe(
            "Months from 1 April of the AY to this payment (part month = full month)",
          ),
        amount: z
          .number()
          .min(0)
          .max(MAX_RUPEES)
          .describe("Amount paid, in INR"),
      }),
    )
    .max(12)
    .optional()
    .describe(
      "Self-assessment tax paid under s.140A before assessment: each payment stops 234B interest on that amount from its own month (s.234B(2))",
    ),
  taxDueOnReturnedIncome: z
    .number()
    .min(0)
    .max(MAX_RUPEES)
    .optional()
    .describe(
      "234C base: tax due on RETURNED income minus TDS/TCS/reliefs, in INR. Defaults to assessedTax when omitted.",
    ),
  cumulativePaid: z
    .array(z.number().min(0).max(MAX_RUPEES))
    .length(4)
    .optional()
    .describe(
      "Cumulative (running-total) advance tax paid by Jun 15 / Sep 15 / Dec 15 / Mar 15, in INR. Required for 234C.",
    ),
  presumptive: z
    .boolean()
    .default(false)
    .describe(
      "44AD/44ADA presumptive: a single 100% installment by Mar 15 instead of four",
    ),
  monthsLateFiling: z
    .number()
    .int()
    .min(0)
    .max(36)
    .default(0)
    .describe(
      "234A: months from the day after the due date to the date of filing (part month = full month). 0 means filed on time.",
    ),
  taxOutstandingForms234A: z
    .number()
    .min(0)
    .max(MAX_RUPEES)
    .optional()
    .describe(
      "234A base: tax outstanding after TDS/TCS, advance tax, AND reliefs, in INR. Defaults to assessedTax minus advanceTaxPaid.",
    ),
  fy: z
    .string()
    .default(DEFAULT_FY)
    .describe("Fiscal year, e.g. '2025-26' (AY 2026-27)"),
};

const hraShape = {
  periods: z
    .array(
      z.object({
        months: z
          .number()
          .int()
          .min(1)
          .max(12)
          .describe("Months in this period; all periods must total 12"),
        basic: z
          .number()
          .min(0)
          .max(MAX_RUPEES)
          .describe("Basic salary for the PERIOD in INR"),
        daRetirement: z
          .number()
          .min(0)
          .max(MAX_RUPEES)
          .optional()
          .describe("DA forming part of retirement benefits, for the period"),
        turnoverCommission: z
          .number()
          .min(0)
          .max(MAX_RUPEES)
          .optional()
          .describe(
            "Commission at a fixed percentage of turnover, per Gestetner",
          ),
        hraReceived: z
          .number()
          .min(0)
          .max(MAX_RUPEES)
          .describe("HRA actually received for the period in INR"),
        rentPaid: z
          .number()
          .min(0)
          .max(MAX_RUPEES)
          .describe("Rent actually paid for the period in INR"),
        isMetro: z
          .boolean()
          .describe(
            "Rented home in Delhi/Mumbai/Kolkata/Chennai (FY 2025-26 metro list)",
          ),
      }),
    )
    .min(1)
    .max(12)
    .describe(
      "Homogeneous periods (amounts are per-period TOTALS, not monthly). Split whenever salary, rent, HRA, or city changes.",
    ),
  regime: z
    .enum(["old", "new"])
    .default("old")
    .describe(
      "HRA exemption and 80GG are both unavailable under the new regime",
    ),
  eightyGG: z
    .object({
      rentPaid: z
        .number()
        .min(0)
        .max(MAX_RUPEES)
        .describe("Total rent paid in the year, INR"),
      adjustedTotalIncome: z
        .number()
        .min(0)
        .max(MAX_RUPEES)
        .describe(
          "Total income before 80GG, excluding LTCG, 111A STCG, and other Chapter VI-A deductions",
        ),
      months: z
        .number()
        .int()
        .min(1)
        .max(12)
        .default(12)
        .describe("Months rent was paid; the cap limb is Rs 5,000 PER MONTH"),
      hraReceivedAnyMonth: z
        .boolean()
        .default(false)
        .describe(
          "True if any HRA was received at any time in the year, which bars 80GG outright",
        ),
    })
    .optional()
    .describe(
      "Compute the 80GG alternative instead of HRA (requires: no HRA received at any time in the year)",
    ),
  fy: z
    .string()
    .default(DEFAULT_FY)
    .describe("Fiscal year, e.g. '2025-26' (AY 2026-27)"),
};

function toTaxInput(args: {
  regime: "new" | "old";
  salaryIncome: number;
  otherIncome: number;
  stcg111A: number;
  ltcg112A: number;
  deductions: number;
  ageBand: "below60" | "senior" | "superSenior";
}): TaxInput {
  return {
    regime: args.regime,
    salaryIncome: args.salaryIncome,
    otherIncome: args.otherIncome,
    stcg111A: args.stcg111A,
    ltcg112A: args.ltcg112A,
    deductions: args.deductions,
    ageBand: args.ageBand,
  };
}

function ok(structured: unknown) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(structured, null, 2) },
    ],
    structuredContent: structured as Record<string, unknown>,
  };
}

function fail(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true as const,
  };
}

export function createServer(): McpServer {
  const server = new McpServer({
    name: "itr-agent",
    version: "0.3.0",
  });

  server.registerTool(
    "compute_tax",
    {
      title: "Compute Indian income tax",
      description:
        "Deterministic Indian income tax computation for a fiscal year. Handles new/old regime slabs, standard deduction, 87A rebate with marginal relief, 111A/112A capital gains rates, surcharge (with the 15% cap on gains), and 4% cess. All arithmetic is done in code from a versioned rule pack -- never estimated.",
      inputSchema: taxInputShape,
      annotations: READ_ONLY,
    },
    async (args) => {
      try {
        const pack = loadRulePack(args.fy);
        return ok(computeTax(toTaxInput(args), pack));
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "compare_regimes",
    {
      title: "Compare old vs new tax regime",
      description:
        "Compute tax under BOTH regimes for the same income and return a side-by-side comparison with the recommended regime and the savings amount. Pass the old-regime deductions you could actually claim; the new regime ignores them.",
      inputSchema: (() => {
        const { regime: _regime, ...rest } = taxInputShape;
        return rest;
      })(),
      annotations: READ_ONLY,
    },
    async (args) => {
      try {
        const pack = loadRulePack(args.fy);
        const newTax = computeTax(toTaxInput({ ...args, regime: "new" }), pack);
        const oldTax = computeTax(toTaxInput({ ...args, regime: "old" }), pack);
        const winner = newTax.totalTax <= oldTax.totalTax ? "new" : "old";
        return ok({
          fy: pack.fy,
          newRegime: newTax,
          oldRegime: oldTax,
          recommended: winner,
          savings: Math.abs(newTax.totalTax - oldTax.totalTax),
          disclaimers: newTax.disclaimers,
        });
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "schedule_advance_tax",
    {
      title: "Plan advance tax installments",
      description:
        "Build the advance tax installment plan (Jun 15 / Sep 15 / Dec 15 / Mar 15 at 15/45/75/100%) for an estimated tax liability net of TDS. Reports per-installment amounts and shortfalls against what has been paid so far.",
      inputSchema: {
        estimatedTax: z
          .number()
          .min(0)
          .max(MAX_RUPEES)
          .describe(
            "Estimated total tax liability for the FY in INR (use compute_tax first)",
          ),
        tdsExpected: z
          .number()
          .min(0)
          .max(MAX_RUPEES)
          .default(0)
          .describe("TDS/TCS expected to be deducted during the year in INR"),
        paidSoFar: z
          .array(z.number().min(0))
          .max(4)
          .optional()
          .describe("Advance tax already paid per installment, in order"),
        fy: z
          .string()
          .default(DEFAULT_FY)
          .describe("Fiscal year, e.g. '2025-26'"),
      },
      annotations: READ_ONLY,
    },
    async (args) => {
      try {
        const pack = loadRulePack(args.fy);
        return ok(
          scheduleAdvanceTax(
            {
              estimatedTax: args.estimatedTax,
              tdsExpected: args.tdsExpected,
              ...(args.paidSoFar ? { paidSoFar: args.paidSoFar } : {}),
            },
            pack,
          ),
        );
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "list_deductions",
    {
      title: "List old-regime deductions",
      description:
        "Return the old-regime deduction checklist with statutory caps for a fiscal year (80C, 80CCD(1B), 80D tiers, 80TTA/TTB, 24(b), HRA metro list). Useful for estimating the `deductions` input to compute_tax/compare_regimes.",
      inputSchema: {
        fy: z
          .string()
          .default(DEFAULT_FY)
          .describe("Fiscal year, e.g. '2025-26'"),
      },
      annotations: READ_ONLY,
    },
    async (args) => {
      try {
        const pack = loadRulePack(args.fy);
        return ok({
          fy: pack.fy,
          caps: pack.oldRegime.deductionCaps,
          hraMetros: pack.oldRegime.hraMetros,
          notes: [
            "80C cap 1.5L covers PPF, ELSS, EPF, life insurance, principal repayment, tuition fees combined.",
            "80CCD(1B) is an ADDITIONAL 50K for NPS over the 80C cap.",
            "80D: self/family 25K (50K if senior) + parents 25K (50K if senior); preventive checkup 5K sublimit inside the caps.",
            "HRA exemption = least of (actual HRA, rent - 10% salary, 50% salary in metro / 40% non-metro).",
            "None of these apply under the new regime except employer NPS 80CCD(2).",
          ],
          disclaimers: [
            "Not tax advice. Caps are per the FY rule pack; eligibility conditions apply.",
          ],
        });
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "parse_form26as",
    {
      title: "Parse Form 26AS (text export)",
      description:
        "Parse the caret-delimited Form 26AS TEXT export from TRACES into structured TDS entries (deductor, TAN, section, amounts) with totals. Download the 'Text' format from TRACES -- it needs no password. PDF exports are not supported; the text export is more reliable.",
      inputSchema: {
        path: z
          .string()
          .describe(
            "Absolute path to the 26AS .txt file downloaded from TRACES",
          ),
      },
      annotations: READ_ONLY,
    },
    async (args) => {
      const read = await readDocument(
        args.path,
        "Provide the absolute path to the TRACES Text export (.txt).",
      );
      if ("error" in read) return fail(read.error);
      const parsed = parseForm26AS(read.text);
      // PII hygiene: mask PAN in the text mirror; keep it structured.
      const masked = {
        ...parsed,
        pan: parsed.pan
          ? `${parsed.pan.slice(0, 3)}XXXXX${parsed.pan.slice(-1)}`
          : null,
      };
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(masked, null, 2) },
        ],
        structuredContent: parsed as unknown as Record<string, unknown>,
      };
    },
  );

  server.registerTool(
    "parse_ais",
    {
      title: "Parse AIS (Annual Information Statement)",
      description:
        "Decrypt and parse the AIS JSON export from the income tax portal, entirely on-device. Provide pan + dob (DDMMYYYY) to derive the password, or pass it explicitly. Returns taxpayer info and normalized information rows (TDS entries, SFT transactions) with amounts, dates, and codes extracted by column label. The decryption scheme is reverse-engineered from the AIS utility; if it fails, use the portal's CSV export as a fallback and file an issue.",
      inputSchema: {
        path: z
          .string()
          .describe("Absolute path to the downloaded AIS .json file"),
        pan: z
          .string()
          .regex(/^[A-Za-z]{5}\d{4}[A-Za-z]$/)
          .optional()
          .describe("PAN (used to derive the decryption password)"),
        dob: z
          .string()
          .optional()
          .describe(
            "Date of birth as DDMMYYYY (or DD-MM-YYYY); date of incorporation for non-individuals",
          ),
        password: z
          .string()
          .optional()
          .describe(
            "Explicit decryption password (overrides pan+dob derivation)",
          ),
      },
      annotations: READ_ONLY,
    },
    async (args) => {
      const read = await readDocument(
        args.path,
        "Provide the absolute path to the AIS JSON download.",
      );
      if ("error" in read) return fail(read.error);
      try {
        const doc = decryptAis(read.text, {
          ...(args.pan ? { pan: args.pan } : {}),
          ...(args.dob ? { dob: args.dob } : {}),
          ...(args.password ? { password: args.password } : {}),
        });
        const parsed = parseAisDocument(doc);
        // PII hygiene: mask PAN-like values in the text mirror.
        // Case-insensitive: the parser preserves whatever case the file carries
        // (`String(v)`, no normalization), so a lowercase PAN anywhere in the
        // payload -- including free-text remarks and deductor names -- would
        // otherwise pass through the mask unchanged.
        const masked = JSON.stringify(parsed, null, 2).replace(
          /\b([A-Za-z]{3})[A-Za-z]{2}\d{4}([A-Za-z])\b/g,
          "$1XXXXXX$2",
        );
        return {
          content: [{ type: "text" as const, text: masked }],
          structuredContent: parsed as unknown as Record<string, unknown>,
        };
      } catch (err) {
        if (err instanceof AisDecryptError) return fail(err.message);
        return fail(
          `AIS parse failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    },
  );

  server.registerTool(
    "compute_interest_234",
    {
      title: "Compute 234A/234B/234C interest",
      description:
        "Deterministic sections 234A, 234B and 234C interest. 234A: 1%/month for filing after the due date, on tax outstanding after all prepaid tax. 234B: 1%/month on assessed-minus-advance when advance < 90% (from 1 April of the AY), reduced by self-assessment payments under s.140A. 234C: per-installment shortfalls with the statutory 12%/36% safe harbors for June/September, measured on tax due on RETURNED income. Rule 119A rounding applied (principal floored to Rs 100, part month = full month). Each section is computed only when its own inputs are supplied; anything skipped is named in `skipped`.",
      inputSchema: interest234Shape,
      annotations: READ_ONLY,
    },
    async (args) => {
      try {
        const pack = loadRulePack(args.fy);
        const skipped: string[] = [];

        const b = interest234B(
          {
            assessedTax: args.assessedTax,
            advanceTaxPaid: args.advanceTaxPaid,
            months: args.monthsFor234B,
            ...(args.selfAssessmentPayments
              ? { selfAssessmentPayments: args.selfAssessmentPayments }
              : {}),
          },
          pack,
        );

        // 234C measures against tax due on RETURNED income, which is not the
        // same figure as 234B's assessed tax. Default to it only explicitly.
        const returnedIncomeTax =
          args.taxDueOnReturnedIncome ?? args.assessedTax;
        const c = args.cumulativePaid
          ? interest234C(
              {
                taxDueOnReturnedIncome: returnedIncomeTax,
                cumulativePaid: args.cumulativePaid as [
                  number,
                  number,
                  number,
                  number,
                ],
                ...(args.presumptive ? { presumptive: true } : {}),
              },
              pack,
            )
          : null;
        if (!c) {
          skipped.push(
            "234C not computed: pass `cumulativePaid` (cumulative advance tax by Jun 15 / Sep 15 / Dec 15 / Mar 15). Interest under 234C can be due even when 234B is nil.",
          );
        } else if (args.taxDueOnReturnedIncome === undefined) {
          skipped.push(
            "234C used `assessedTax` as the tax on returned income: pass `taxDueOnReturnedIncome` separately if the return and the assessment differ.",
          );
        }

        const a =
          args.monthsLateFiling > 0
            ? interest234A(
                {
                  taxOnTotalIncomeNetOfPrepaid:
                    args.taxOutstandingForms234A ??
                    Math.max(0, args.assessedTax - args.advanceTaxPaid),
                  months: args.monthsLateFiling,
                },
                pack,
              )
            : null;
        if (!a) {
          skipped.push(
            "234A not computed: the return is treated as filed on time (`monthsLateFiling` is 0).",
          );
        }

        return ok({
          fy: pack.fy,
          section234A: a,
          section234B: b,
          section234C: c,
          totalInterest:
            (a?.interest ?? 0) + b.interest + (c?.totalInterest ?? 0),
          skipped,
          disclaimers: [
            "Not tax advice. Capital-gains/dividend 234C exclusions (first proviso) are not auto-applied: exclude such income from the base for the earlier installments yourself.",
            "Resident seniors (60+) with no business income owe no advance tax, hence no 234B/234C.",
            "234A stops at the date of filing; 234B runs to the date of payment or assessment. Supply the month counts you can evidence.",
          ],
        });
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "compute_hra",
    {
      title: "Compute HRA exemption (+80GG)",
      description:
        "HRA exemption per Rule 2A: least of (actual HRA, rent minus 10% of salary, 50% metro / 40% non-metro of salary), computed period-wise. Salary = basic + retirement-forming DA + fixed-percentage turnover commission. Old regime only; metro list for FY 2025-26 is Delhi/Mumbai/Kolkata/Chennai. Also computes the 80GG alternative for rent payers who received no HRA at any time in the year (the two are mutually exclusive).",
      inputSchema: hraShape,
      annotations: READ_ONLY,
    },
    async (args) => {
      try {
        const pack = loadRulePack(args.fy);
        const disclaimers = [
          "Not tax advice. Rent must be actually paid; keep receipts and the rent agreement.",
          "Rule 2A is computed period-wise: exemption is available only for months in which rent was actually paid for accommodation you occupied.",
          "Both HRA exemption and 80GG are unavailable under the new regime (115BAC).",
        ];
        if (args.eightyGG) {
          // The regime gate lives inside compute80GG so the new-regime answer is
          // an explicit ineligible-with-reason result, not a silent number.
          return ok({
            ...compute80GG(
              {
                rentPaid: args.eightyGG.rentPaid,
                adjustedTotalIncome: args.eightyGG.adjustedTotalIncome,
                months: args.eightyGG.months,
                hraReceivedAnyMonth: args.eightyGG.hraReceivedAnyMonth,
              },
              pack,
              args.regime,
            ),
            rulePackVersion: pack.rulePackVersion,
            disclaimers,
          });
        }
        return ok({
          ...computeHra(args.periods as HraPeriod[], pack, args.regime),
          rulePackVersion: pack.rulePackVersion,
          disclaimers,
        });
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "reconcile_documents",
    {
      title: "Reconcile Form 16 vs AIS vs 26AS",
      description:
        "Cross-document mismatch report -- the checks that pre-empt 143(1)(a) intimations and 139(9) defect notices: TDS claimed vs 26AS deposited (the ledger of record), missing-employer detection, AIS interest/dividend vs declared, Form 16 vs 26AS per-TAN totals, declared salary below the Form 16 total, and 26AS rows missing the gross amount. Also groups 26AS TDS by income head so each credit can be placed in the right schedule. Pass whichever documents you have; checks needing missing inputs are reported as skipped.",
      inputSchema: {
        form26asTds: z
          .array(
            z.object({
              tan: z.string().describe("Deductor TAN, e.g. DELS12345F"),
              deductorName: z.string().optional().describe("Deductor name"),
              section: z
                .string()
                .optional()
                .describe("TDS section code, e.g. 192, 194A"),
              amountPaid: z
                .number()
                .describe(
                  "Amount paid or credited in INR (may be negative on a correction row)",
                ),
              tdsDeposited: z
                .number()
                .describe(
                  "TDS deposited in INR (may be negative on a correction row)",
                ),
            }),
          )
          .max(2000)
          .optional()
          .describe("TDS entries from parse_form26as"),
        form16: z
          .array(
            z.object({
              tan: z.string().describe("Employer TAN from Form 16 Part A"),
              grossSalary: z
                .number()
                .optional()
                .describe("GROSS salary per Form 16 Part B, before exemptions"),
              tdsDeposited: z
                .number()
                .describe("Total TDS deposited per Form 16 Part A, in INR"),
            }),
          )
          .max(50)
          .optional()
          .describe("Per-employer Form 16 Part A figures"),
        ais: z
          .object({
            salaryByTan: z
              .record(z.string(), z.number())
              .optional()
              .describe("AIS gross salary keyed by employer TAN"),
            interestTotal: z
              .number()
              .optional()
              .describe("Total AIS interest across all banks, in INR"),
            dividendTotal: z
              .number()
              .optional()
              .describe("Total AIS dividend, in INR"),
          })
          .optional()
          .describe("AIS aggregates (from parse_ais rows)"),
        return: z
          .object({
            tdsClaimed: z
              .number()
              .optional()
              .describe("Total TDS credit claimed in the draft return"),
            salaryDeclared: z
              .number()
              .optional()
              .describe("Gross salary declared in the draft return, in INR"),
            interestDeclared: z
              .number()
              .optional()
              .describe("Interest income declared, GROSS of 80TTA/80TTB"),
            dividendDeclared: z
              .number()
              .optional()
              .describe("Dividend declared, gross of TDS"),
          })
          .optional()
          .describe("Figures from the draft return"),
        fy: z
          .string()
          .default(DEFAULT_FY)
          .describe("Fiscal year, e.g. '2025-26' (AY 2026-27)"),
      },
      annotations: READ_ONLY,
    },
    async (args) => {
      try {
        const pack = loadRulePack(args.fy);
        const input: ReconcileInput = {
          ...(args.form26asTds ? { form26asTds: args.form26asTds } : {}),
          ...(args.form16 ? { form16: args.form16 } : {}),
          ...(args.ais ? { ais: args.ais } : {}),
          ...(args.return ? { return: args.return } : {}),
        };
        return ok(reconcile(input, pack));
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "recommend_itr_form",
    {
      title: "Recommend the ITR form",
      description:
        "Recommend ITR-1/2/3/4 for an individual from income heads, residency, losses, and disqualifier flags, with rule-by-rule reasoning. Loss-continuity aware: brought-forward business/speculative losses force ITR-3 even with zero current-year business income (Schedule CFL). Returns the filing deadline and 234F late fee for the recommended form.",
      inputSchema: {
        fy: z
          .string()
          .default(DEFAULT_FY)
          .describe("Fiscal year, e.g. '2025-26'"),
        residency: z
          .enum(["resident", "rnor", "nri"])
          .default("resident")
          .describe(
            "Residential status for the FY (RNOR/NRI cannot file ITR-1/ITR-4)",
          ),
        totalIncome: z
          .number()
          .min(0)
          .max(MAX_RUPEES)
          .describe(
            "Estimated TOTAL income in INR, i.e. after Chapter VI-A deductions -- this is the figure the Rs 50 lakh ITR-1/ITR-4 ceiling tests. Use the gross figure only if you have no deductions.",
          ),
        houseProperties: z
          .number()
          .int()
          .min(0)
          .max(MAX_RUPEES)
          .default(0)
          .describe("Number of house properties with income or loss"),
        stcg111A: z
          .number()
          .min(0)
          .max(MAX_RUPEES)
          .default(0)
          .describe(
            "STCG under 111A in INR (any amount rules out ITR-1/ITR-4)",
          ),
        ltcg112A: z
          .number()
          .min(0)
          .max(MAX_RUPEES)
          .default(0)
          .describe("LTCG under 112A in INR before the 1.25L exemption"),
        hasOtherCapitalGains: z
          .boolean()
          .default(false)
          .describe(
            "Capital gains outside 111A/112A: property, debt MF, unlisted or foreign shares",
          ),
        hasBusinessIncome: z
          .boolean()
          .default(false)
          .describe(
            "Any business or professional income this year, incl. F&O trading and freelancing",
          ),
        presumptive: z
          .boolean()
          .default(false)
          .describe("Opting for presumptive taxation (44AD/44ADA/44AE)"),
        isPartnerInFirm: z
          .boolean()
          .default(false)
          .describe("Partner in a partnership firm"),
        businessLoss: z
          .boolean()
          .default(false)
          .describe(
            "Non-speculative business loss (incl. F&O) brought forward or arising this year",
          ),
        speculativeLoss: z
          .boolean()
          .default(false)
          .describe(
            "Speculative (intraday equity) loss brought forward or arising this year",
          ),
        capitalLoss: z
          .boolean()
          .default(false)
          .describe(
            "Capital loss (STCL/LTCL) brought forward or to carry forward",
          ),
        housePropertyLoss: z
          .boolean()
          .default(false)
          .describe("House property loss to carry forward"),
        hasForeignAssetsOrIncome: z
          .boolean()
          .default(false)
          .describe(
            "Foreign assets/income incl. vested RSUs or ESPP of a foreign parent (Schedule FA)",
          ),
        isDirector: z
          .boolean()
          .default(false)
          .describe("Director in any company during the FY"),
        holdsUnlistedShares: z
          .boolean()
          .default(false)
          .describe("Held unlisted equity shares during the FY"),
        agriIncome: z
          .number()
          .min(0)
          .max(MAX_RUPEES)
          .default(0)
          .describe(
            "Agricultural income in INR (above 5,000 rules out ITR-1/ITR-4)",
          ),
        esopDeferral: z
          .boolean()
          .default(false)
          .describe("Tax deferred on eligible-startup ESOPs (s80-IAC)"),
        hasLotteryOrGamingIncome: z
          .boolean()
          .default(false)
          .describe("Winnings from lottery, online games, or racehorses"),
      },
      annotations: READ_ONLY,
    },
    async (args) => {
      try {
        const pack = loadRulePack(args.fy);
        const input: ItrFormInput = {
          residency: args.residency,
          totalIncome: args.totalIncome,
          houseProperties: args.houseProperties,
          stcg111A: args.stcg111A,
          ltcg112A: args.ltcg112A,
          hasOtherCapitalGains: args.hasOtherCapitalGains,
          hasBusinessIncome: args.hasBusinessIncome,
          presumptive: args.presumptive,
          isPartnerInFirm: args.isPartnerInFirm,
          losses: {
            business: args.businessLoss,
            speculative: args.speculativeLoss,
            capital: args.capitalLoss,
            houseProperty: args.housePropertyLoss,
          },
          hasForeignAssetsOrIncome: args.hasForeignAssetsOrIncome,
          isDirector: args.isDirector,
          holdsUnlistedShares: args.holdsUnlistedShares,
          agriIncome: args.agriIncome,
          esopDeferral: args.esopDeferral,
          hasLotteryOrGamingIncome: args.hasLotteryOrGamingIncome,
        };
        return ok(recommendItrForm(input, pack));
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "filing_checklist",
    {
      title: "Step-by-step ITR filing checklist",
      description:
        "Ordered, form-specific walkthrough for filing ITR-1/2/3/4 on incometax.gov.in: documents to gather, reconciliation, tax computation, portal steps schedule by schedule, and e-verification. Guidance only -- the taxpayer performs the final submit on the portal themselves.",
      inputSchema: {
        fy: z
          .string()
          .default(DEFAULT_FY)
          .describe("Fiscal year, e.g. '2025-26'"),
        form: z
          .enum(["ITR-1", "ITR-2", "ITR-3", "ITR-4"])
          .describe("The ITR form to file (use recommend_itr_form if unsure)"),
      },
      annotations: READ_ONLY,
    },
    async (args) => {
      try {
        const pack = loadRulePack(args.fy);
        return ok(filingChecklist(args.form, pack));
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerPrompt(
    "file_my_itr",
    {
      title: "Guided ITR filing interview",
      description:
        "Step-by-step ITR filing agent: interviews the taxpayer one question at a time, picks the form, computes tax, reconciles documents, and walks them to the portal's submit button.",
      argsSchema: {},
    },
    () => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              "Act as my ITR filing agent for India. Interview me ONE question at a time -- never a wall of questions -- and drive the itr-agent tools after each answer. Sequence:",
              "",
              "1. Residency and age band for the FY.",
              "2. Income heads, one by one: salary (how many employers), house property (how many), capital gains (equity 111A/112A, anything else), business/professional incl. F&O or freelancing, other sources (interest, dividend).",
              "3. Disqualifier sweep: foreign assets or RSUs/ESPP of a foreign employer, director role, unlisted shares, agricultural income over 5,000, ESOP deferral, lottery/gaming winnings.",
              "4. Losses: brought-forward or current-year business/speculative/capital/house-property losses (this changes the form).",
              "5. Call recommend_itr_form with everything gathered; explain the recommendation and what ruled out simpler forms.",
              "6. Ask for real amounts, then call compare_regimes (and compute_hra / list_deductions when the old regime is in play). Recommend the regime.",
              "7. If documents are available, parse them (parse_form26as, parse_ais) and run reconcile_documents; walk me through fixing every finding.",
              "8. If advance tax applies, call schedule_advance_tax and compute_interest_234.",
              "9. Finish with filing_checklist for the recommended form and walk me through it step by step, waiting for my confirmation at each portal step.",
              "",
              "Rules: use tool outputs for every number (never estimate tax yourself), quote the disclaimers, and be explicit that I press the final submit button on incometax.gov.in myself -- you never file on my behalf.",
            ].join("\n"),
          },
        },
      ],
    }),
  );

  server.registerTool(
    "list_tax_years",
    {
      title: "List supported fiscal years",
      description:
        "List the fiscal years this server has rule packs for, with filing deadlines for the current assessment year.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      const pack = loadRulePack(DEFAULT_FY);
      return ok({
        supported: availableYears(),
        default: DEFAULT_FY,
        deadlines: pack.deadlines,
        rulePackVersion: pack.rulePackVersion,
        sources: pack.sources,
      });
    },
  );

  return server;
}
