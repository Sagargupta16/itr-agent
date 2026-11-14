import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { scheduleAdvanceTax } from "./engine/advance-tax.js";
import { regimeBreakeven } from "./engine/breakeven.js";
import { computeTax, type Regime, type TaxInput } from "./engine/compute.js";
import {
  interestMonths,
  parseIsoDate,
  start234A,
  start234B,
} from "./engine/dates.js";
import { filingStatus } from "./engine/deadlines.js";
import {
  computeHouseProperty,
  type HousePropertyResult,
} from "./engine/house-property.js";
import {
  compute80GG,
  computeHra,
  type HraPeriod,
  isMetroCity,
} from "./engine/hra.js";
import {
  interest234A,
  interest234B,
  interest234C,
  type SelfAssessmentPayment,
} from "./engine/interest.js";
import {
  filingChecklist,
  type ItrFormInput,
  recommendItrForm,
} from "./engine/itr-form.js";
import { computeLossSetoff } from "./engine/loss-setoff.js";
import {
  computePresumptiveIncome,
  type PresumptiveInput,
  type PresumptiveResult,
} from "./engine/presumptive.js";
import {
  type ReconcileInput,
  reconcile,
  type TdsSummaryEntry,
} from "./engine/reconcile.js";
import {
  availableYears,
  DEFAULT_FY,
  loadRulePack,
  packageVersion,
  type RulePack,
} from "./engine/rulepack.js";
import { computeTaxSummary } from "./engine/summary.js";
import {
  AisDecryptError,
  type AisParsed,
  decryptAis,
  parseAisDocument,
} from "./parsers/ais.js";
import { type Form26AS, parseForm26AS, sumRupees } from "./parsers/form26as.js";

const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;

// Tool descriptions quote FY figures (caps, rates, metro cities). They are built
// from the default year's pack, so a new pack changes them with no code edit;
// the `fy` input still picks the pack each computation runs on.
const P: RulePack = loadRulePack(DEFAULT_FY);
const rs = (n: number) => `Rs ${n.toLocaleString("en-IN")}`;
const pct = (x: number) => `${Math.round(x * 10000) / 100}%`;
const ISO_DATE = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "dates are YYYY-MM-DD");

// Rs 1 lakh crore. No individual return reaches it, and without a ceiling a
// caller-supplied 1e308 overflows the sum to Infinity, which JSON.stringify
// then serializes as `null` -- so every tax figure came back null on success.
const MAX_RUPEES = 1e12;

// A 26AS/AIS export is a few MB at worst. Past this, readFile succeeds and the
// failure surfaces later as a bare V8 "Invalid string length" with no remedy
// named, or as the tool's path error, which misdiagnoses a size problem.
const MAX_DOC_BYTES = 64 * 1024 * 1024;

/** Read a user-supplied document path, distinguishing missing from oversized.
 * `allowedExtensions` narrows what the tool will open: the two parsers only
 * ever need a .txt or a .json, and refusing anything else (dotfiles, keys,
 * config) closes the arbitrary-file-read path a prompt-injected client could
 * otherwise reach through `path`. The parsed output leaks little, but the
 * first PAN-shaped token and any free-text cell would still come back. */
async function readDocument(
  path: string,
  hint: string,
  allowedExtensions: readonly string[],
): Promise<{ text: string } | { error: string }> {
  const name = basename(path);
  const ext = extname(name).toLowerCase();
  if (name.startsWith(".") || !allowedExtensions.includes(ext)) {
    return {
      error: `refusing to read ${path}: this tool opens only ${allowedExtensions.join("/")} files. ${hint}`,
    };
  }
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

// One house for compute_house_property and the `houses` input of the tax
// tools. Hoisted like the other multi-field shapes (see CLAUDE.md, SDK v2).
const houseItem = z.object({
  label: z
    .string()
    .max(80)
    .optional()
    .describe("Name echoed back in the result, e.g. 'Pune flat'"),
  use: z
    .enum(["selfOccupied", "letOut"])
    .describe(
      `'selfOccupied': the owner lives in it (or cannot, because work keeps them elsewhere); up to ${P.houseProperty.maxSelfOccupied} such houses are valued at nil (s.23(2)), any more are deemed let out. 'letOut': let for the whole or any part of the year.`,
    ),
  grossAnnualValue: z
    .number()
    .min(0)
    .max(MAX_RUPEES)
    .optional()
    .describe(
      "Let out: rent received or receivable for the year (the owner's share if co-owned). Self-occupied: leave out, unless this house is past the self-occupied limit, when it is the rent it could fetch.",
    ),
  municipalTaxesPaid: z
    .number()
    .min(0)
    .max(MAX_RUPEES)
    .optional()
    .describe(
      "Municipal tax the OWNER paid in the year (tenant-paid tax does not count)",
    ),
  interestPayable: z
    .number()
    .min(0)
    .max(MAX_RUPEES)
    .optional()
    .describe(
      "Home-loan interest for the year (interest only; principal is 80C, not this)",
    ),
  preConstructionInterest: z
    .number()
    .min(0)
    .max(MAX_RUPEES)
    .optional()
    .describe(
      `TOTAL interest for the years before the house was completed; the tool works out this year's 1/${P.houseProperty.preConstructionInstallments} instalment from constructionCompletedFy`,
    ),
  constructionCompletedFy: z
    .string()
    .regex(/^\d{4}-\d{2}$/, "a financial year like '2023-24'")
    .optional()
    .describe(
      "Financial year the purchase or construction was completed, e.g. '2023-24'",
    ),
  loanQualifiesForHigherCap: z
    .boolean()
    .optional()
    .describe(
      `Self-occupied only. Default true: the loan was taken on or after 1 April 1999 to buy or build the house and it was finished within five years, so interest is capped at ${rs(P.oldRegime.deductionCaps["24b_selfOccupied"] ?? 0)}. False for an older loan, a repair loan or a late completion (cap ${rs(P.houseProperty.selfOccupiedInterestCapOlder)}).`,
    ),
});

const housesField = z
  .array(houseItem)
  .min(1)
  .max(20)
  .describe(
    "Every house the taxpayer owns, one entry each. The tool works out the head (annual value, 30% standard deduction, capped interest) per regime, so do not also pass housePropertyLoss.",
  );

const p44 = P.itrEligibility.presumptive;
const presumptiveBusinessShape = z.object({
  scheme: z
    .enum(["44AD", "44ADA", "44AE"])
    .describe(
      "44AD: small business on turnover. 44ADA: specified profession on gross receipts. 44AE: goods carriages.",
    ),
  digitalTurnover: z
    .number()
    .min(0)
    .max(MAX_RUPEES)
    .optional()
    .describe(
      `44AD: turnover received by account-payee cheque, bank transfer, UPI or other digital modes (deemed profit ${pct(p44.deemedProfit44ADDigital)})`,
    ),
  otherTurnover: z
    .number()
    .min(0)
    .max(MAX_RUPEES)
    .optional()
    .describe(
      `44AD: the rest of turnover, cash included (deemed profit ${pct(p44.deemedProfit44AD)})`,
    ),
  grossReceipts: z
    .number()
    .min(0)
    .max(MAX_RUPEES)
    .optional()
    .describe(
      `44ADA: gross professional receipts (deemed profit ${pct(p44.deemedProfit44ADA)})`,
    ),
  cashReceiptsWithin5Pct: z
    .boolean()
    .optional()
    .describe(
      `Cash receipts are at most ${pct(p44.cashShareLimit)} of the total, which lifts the ceiling to ${rs(p44.turnoverCap44ADDigital)} (44AD) or ${rs(p44.receiptsCap44ADADigital)} (44ADA). Required for 44ADA; for 44AD it is worked out from the two turnover figures when left out.`,
    ),
  carriages: z
    .array(
      z.object({
        type: z
          .enum(["heavy", "other"])
          .describe(
            `heavy: gross vehicle weight above ${p44.heavyVehicleAboveGrossWeightTons} tons (${rs(p44.deemedProfit44AEHeavyPerTonPerMonth)} per ton a month); other: ${rs(p44.deemedProfit44AEOtherPerVehiclePerMonth)} a month`,
          ),
        grossWeightTons: z
          .number()
          .positive()
          .max(1000)
          .optional()
          .describe("Gross vehicle weight in tons; required for heavy"),
        monthsOwned: z
          .number()
          .min(0)
          .max(12)
          .describe("Months owned in the year; a part month counts as full"),
      }),
    )
    .max(50)
    .optional()
    .describe(
      `44AE: each goods carriage owned in the year (the scheme allows at most ${p44.maxVehicles44AE} at any time)`,
    ),
  maxCarriagesAtAnyTime: z
    .number()
    .int()
    .min(0)
    .max(1000)
    .optional()
    .describe(
      "44AE: the most carriages owned at any one time; defaults to the number listed",
    ),
  declaredProfit: z
    .number()
    .min(0)
    .max(MAX_RUPEES)
    .optional()
    .describe(
      "A higher profit the taxpayer declares; the scheme taxes the deemed figure or more",
    ),
});

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
      `Long-term capital gains under section 112A in INR, BEFORE the ${rs(P.capitalGains.ltcg112AExemption)} exemption`,
    ),
  deductions: z
    .number()
    .min(0)
    .max(MAX_RUPEES)
    .default(0)
    .describe(
      "Old regime only: total Chapter VI-A deductions (80C, 80D, ...) in INR, EXCLUDING employer NPS (use employerNps80CCD2). Ignored under the new regime.",
    ),
  employerNps80CCD2: z
    .number()
    .min(0)
    .max(MAX_RUPEES)
    .default(0)
    .describe(
      `Employer's NPS contribution under s.80CCD(2) in INR. Allowed in BOTH regimes (the one Chapter VI-A deduction 115BAC keeps); capped at ${pct(P.newRegime.employerNps80CCD2.pctOfSalary)} of salary in the new regime, ${pct(P.oldRegime.employerNps80CCD2.pctOfSalaryPrivate)} (private) / ${pct(P.oldRegime.employerNps80CCD2.pctOfSalaryGovernment)} (government) in the old (FY ${P.fy}).`,
    ),
  governmentEmployer: z
    .boolean()
    .default(false)
    .describe(
      `Central/State Government employer (raises the old-regime 80CCD(2) cap to ${pct(P.oldRegime.employerNps80CCD2.pctOfSalaryGovernment)} for FY ${P.fy})`,
    ),
  housePropertyLoss: z
    .number()
    .min(0)
    .max(MAX_RUPEES)
    .default(0)
    .describe(
      `Loss under the head house property as a POSITIVE number: home-loan interest on the house you live in, or a let-out property's net loss. Requires housePropertyType. Old regime: set off against other heads up to ${rs(P.oldRegime.deductionCaps.housePropertyLossSetOff ?? 0)} (s.71(3A)). New regime: no inter-head set-off (s.115BAC(2)). Figures for FY ${P.fy}.`,
    ),
  housePropertyType: z
    .enum(["selfOccupied", "letOut"])
    .optional()
    .describe(
      `Required when housePropertyLoss is above 0. 'selfOccupied': the home you live in; its interest is deductible only up to ${rs(P.oldRegime.deductionCaps["24b_selfOccupied"] ?? 0)} in the old regime (s.24(b)) and not at all in the new regime (s.115BAC(2)(i)), and what is above that is neither set off nor carried forward. 'letOut': no s.24(b) cap; the part not set off is carried forward (s.71B).`,
    ),
  ageBand: z
    .enum(["below60", "senior", "superSenior"])
    .default("below60")
    .describe(
      "Age band: below60, senior (60-79), superSenior (80+). Affects old-regime exemption only.",
    ),
  houses: housesField
    .optional()
    .describe(
      "Optional: every house owned, one entry each, INSTEAD of housePropertyLoss. The tool works out income from house property per regime (nil self-occupied interest under the new regime) and folds it in, so never add it to otherIncome yourself.",
    ),
  presumptiveBusiness: presumptiveBusinessShape
    .optional()
    .describe(
      "Optional: presumptive business or profession (44AD / 44ADA / 44AE). The tool works out the deemed income and adds it to otherIncome itself.",
    ),
  fy: z
    .string()
    .default(DEFAULT_FY)
    .describe(
      "Fiscal year, e.g. '2025-26' (AY 2026-27); '2026-27' is tax year 2026-27 under the Income-tax Act 2025",
    ),
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
    .optional()
    .describe(
      "Months from 1 April of the AY to the date of payment or assessment (part month = full month). Prefer paidOrAssessedDate or filingDate and let the tool count. Filing on 20 July of the AY is 4.",
    ),
  paidOrAssessedDate: ISO_DATE.optional().describe(
    "234B end date (YYYY-MM-DD): when the outstanding tax is paid in full, or the assessment date. Defaults to filingDate. The tool counts the months from 1 April of the AY (Rule 119A, part month = full month).",
  ),
  filingDate: ISO_DATE.optional().describe(
    "Date the return is or will be filed (YYYY-MM-DD). Drives 234A (needs `form` or `dueDate`) and, unless paidOrAssessedDate is given, the end of 234B.",
  ),
  form: z
    .enum(["ITR-1", "ITR-2", "ITR-3", "ITR-4"])
    .optional()
    .describe(
      "ITR form, used with filingDate to pick the non-audit s.139(1) due date from the rule pack for 234A",
    ),
  dueDate: ISO_DATE.optional().describe(
    "Explicit s.139(1) due date (YYYY-MM-DD) for 234A, e.g. an audit case. Overrides `form`.",
  ),
  selfAssessmentPayments: z
    .array(
      z.object({
        monthsFromApril: z
          .number()
          .int()
          .min(1)
          .max(36)
          .optional()
          .describe(
            "Months from 1 April of the AY to this payment (part month = full month). Prefer `date`.",
          ),
        date: ISO_DATE.optional().describe(
          "Date of this s.140A payment (YYYY-MM-DD); the tool counts the months",
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
      `44AD/44ADA presumptive: a single ${pct(P.interest.s234C.presumptive.pct)} installment by ${P.interest.s234C.presumptive.due.slice(5)} (MM-DD) instead of four`,
    ),
  monthsLateFiling: z
    .number()
    .int()
    .min(0)
    .max(36)
    .default(0)
    .describe(
      "234A: months from the day after the due date to the date of filing (part month = full month). 0 means filed on time. Prefer filingDate with `form` and let the tool count.",
    ),
  taxOutstandingFor234A: z
    .number()
    .min(0)
    .max(MAX_RUPEES)
    .optional()
    .describe(
      "234A base: tax outstanding after TDS/TCS, advance tax, AND reliefs, in INR. Defaults to assessedTax minus advanceTaxPaid.",
    ),
  taxOutstandingForms234A: z
    .number()
    .min(0)
    .max(MAX_RUPEES)
    .optional()
    .describe(
      "Deprecated misspelling of taxOutstandingFor234A; still accepted.",
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
        city: z
          .string()
          .max(80)
          .optional()
          .describe(
            "City of the rented home, e.g. 'Pune'. The tool checks it against the fy's rule-pack metro list, which changes between years, so pass the city rather than deciding metro status yourself.",
          ),
        isMetro: z
          .boolean()
          .optional()
          .describe(
            "Only when the city cannot be named: true if the rented home is in one of the fy's rule-pack metro cities (list_deductions returns them as hraMetros). Ignored when `city` is given.",
          ),
      }),
    )
    .min(1)
    .max(12)
    .optional()
    .describe(
      "Homogeneous periods (amounts are per-period TOTALS, not monthly). Split whenever salary, rent, HRA, or city changes. Required unless eightyGG is supplied.",
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
        .describe(
          `Months rent was paid; the cap limb is ${rs(P.deduction80GG.capPerMonth)} PER MONTH (FY ${P.fy})`,
        ),
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

const fyField = z
  .string()
  .default(DEFAULT_FY)
  .describe(
    "Fiscal year, e.g. '2025-26' (AY 2026-27); '2026-27' is tax year 2026-27 under the Income-tax Act 2025",
  );

const houseHeadShape = {
  houses: housesField,
  regime: z
    .enum(["new", "old"])
    .describe(
      "Tax regime: self-occupied interest is nil under the new regime (s.115BAC(2)(i)) and capped in the old",
    ),
  fy: fyField,
};

const presumptiveToolShape = {
  ...presumptiveBusinessShape.shape,
  fy: fyField,
};

const rupeeLoss = z.number().min(0).max(MAX_RUPEES);
const signedRupees = z.number().min(-MAX_RUPEES).max(MAX_RUPEES);

const lossSetoffShape = {
  regime: z
    .enum(["new", "old"])
    .describe(
      "Tax regime: no house-property loss crosses heads under the new regime (s.115BAC(2)); run once per regime to compare",
    ),
  filedByDueDate: z
    .boolean()
    .describe(
      "The return for THIS year is filed by the s.139(1) due date. If not, s.80 stops this year's business, speculative and capital losses from being carried forward (house property survives, s.71B). list_tax_years `status` says whether the date has passed.",
    ),
  salaryIncome: rupeeLoss
    .optional()
    .describe("Gross salary before the standard deduction, in INR"),
  houseProperty: signedRupees
    .optional()
    .describe(
      "Income from house property for all houses together, in INR: positive income or a NEGATIVE loss (compute_house_property totals.income)",
    ),
  housePropertyType: z
    .enum(["selfOccupied", "letOut"])
    .optional()
    .describe(
      "Which kind of house a house-property LOSS comes from; 'letOut' for a figure from compute_house_property (its caps are already applied)",
    ),
  business: signedRupees
    .optional()
    .describe(
      "Business or profession other than speculation (F&O included), net: profit or a NEGATIVE loss, in INR",
    ),
  speculative: signedRupees
    .optional()
    .describe(
      "Speculative business (intraday equity), net: profit or a NEGATIVE loss, in INR",
    ),
  otherSources: rupeeLoss
    .optional()
    .describe("Income from other sources at normal rates, in INR"),
  capitalGains: z
    .object({
      stcg111A: rupeeLoss.optional().describe("s.111A STCG, in INR"),
      stcgOther: rupeeLoss
        .optional()
        .describe(
          "STCG at slab rates (debt funds under s.50AA, unlisted shares, short-term property), in INR",
        ),
      ltcg112A: rupeeLoss
        .optional()
        .describe("s.112A LTCG BEFORE the exemption, in INR"),
      ltcgOther: rupeeLoss
        .optional()
        .describe(
          "s.112 LTCG (property, unlisted shares, other long-term assets), in INR",
        ),
      shortTermLoss: rupeeLoss
        .optional()
        .describe("Short-term capital losses of the year, positive, in INR"),
      longTermLoss: rupeeLoss
        .optional()
        .describe("Long-term capital losses of the year, positive, in INR"),
    })
    .optional()
    .describe("Capital gains and losses of the year"),
  broughtForward: z
    .array(
      z.object({
        kind: z
          .enum([
            "houseProperty",
            "business",
            "speculative",
            "shortTermCapital",
            "longTermCapital",
          ])
          .describe("Kind of loss"),
        originFy: z
          .string()
          .regex(/^\d{4}-\d{2}$/, "a financial year like '2021-22'")
          .describe(
            "FY the loss arose in, e.g. '2021-22' (the AY 2022-23 row of Schedule CFL)",
          ),
        amount: rupeeLoss.describe(
          "Unabsorbed amount at the start of this year, positive, in INR",
        ),
      }),
    )
    .max(100)
    .default([])
    .describe(
      "Losses brought forward from earlier years: one entry per kind and origin year, from last year's Schedule CFL",
    ),
  fy: fyField,
};

const datedPayment = z.object({
  date: ISO_DATE.describe("Date paid, YYYY-MM-DD (from the challan)"),
  amount: z.number().min(0).max(MAX_RUPEES).describe("Amount paid, in INR"),
});

const taxSummaryShape = {
  ...taxInputShape,
  form26asPath: z
    .string()
    .max(4096)
    .optional()
    .describe(
      "Absolute path to the Form 26AS Text export from TRACES. Preferred: the tool takes TDS credit as the creditable (status F) total and TCS from Part VI itself.",
    ),
  tdsCredit: z
    .number()
    .min(0)
    .max(MAX_RUPEES)
    .optional()
    .describe(
      "Only without form26asPath: TDS credit in INR, e.g. from Form 16 Part A. 0 when no tax was deducted.",
    ),
  tcsCredit: z
    .number()
    .min(0)
    .max(MAX_RUPEES)
    .optional()
    .describe("Only without form26asPath: TCS credit in INR (default 0)"),
  advanceTaxPayments: z
    .array(datedPayment)
    .max(24)
    .default([])
    .describe(
      "Each advance tax payment made during the FY, with its date; the tool works out s.234B and s.234C from them",
    ),
  selfAssessmentPayments: z
    .array(datedPayment)
    .max(12)
    .optional()
    .describe(
      "Self-assessment tax (s.140A) paid after the FY, each with its date; each stops s.234B on its amount from that month",
    ),
  filingDate: ISO_DATE.optional().describe(
    "Date the return is or will be filed (YYYY-MM-DD); defaults to today in India",
  ),
  form: z
    .enum(["ITR-1", "ITR-2", "ITR-3", "ITR-4"])
    .optional()
    .describe(
      "ITR form, to take the non-audit s.139(1) due date from the rule pack (use recommend_itr_form if unsure)",
    ),
  dueDate: ISO_DATE.optional().describe(
    "Explicit s.139(1) due date (YYYY-MM-DD), e.g. for an audit case. Overrides `form`.",
  ),
  businessIncome: z
    .boolean()
    .optional()
    .describe(
      "Whether any of the income is from business or profession (counted in otherIncome). Required for a senior or super senior without presumptiveBusiness: a resident senior with none owes no advance tax (s.207(2)), so no s.234B or s.234C.",
    ),
};

const listTaxYearsShape = {
  asOf: ISO_DATE.optional().describe(
    "Date to report the status for (YYYY-MM-DD). Defaults to today in India; pass it only to plan ahead.",
  ),
};

function toTaxInput(args: {
  regime: "new" | "old";
  salaryIncome: number;
  otherIncome: number;
  stcg111A: number;
  ltcg112A: number;
  deductions: number;
  employerNps80CCD2: number;
  governmentEmployer: boolean;
  housePropertyLoss: number;
  housePropertyType?: "selfOccupied" | "letOut" | undefined;
  ageBand: "below60" | "senior" | "superSenior";
}): TaxInput {
  return {
    regime: args.regime,
    salaryIncome: args.salaryIncome,
    otherIncome: args.otherIncome,
    stcg111A: args.stcg111A,
    ltcg112A: args.ltcg112A,
    deductions: args.deductions,
    employerNps80CCD2: args.employerNps80CCD2,
    governmentEmployer: args.governmentEmployer,
    housePropertyLoss: args.housePropertyLoss,
    ...(args.housePropertyType
      ? { housePropertyType: args.housePropertyType }
      : {}),
    ageBand: args.ageBand,
  };
}

type TaxArgs = Omit<Parameters<typeof toTaxInput>[0], "regime"> & {
  houses?: z.infer<typeof houseItem>[] | undefined;
  presumptiveBusiness?: z.infer<typeof presumptiveBusinessShape> | undefined;
};

/** The flat presumptiveBusiness input as the engine's per-scheme union. The
 * flat shape keeps the JSON schema simple for clients; this names the field a
 * scheme is missing. */
function toPresumptiveInput(
  p: z.infer<typeof presumptiveBusinessShape>,
): PresumptiveInput {
  const declared =
    p.declaredProfit !== undefined ? { declaredProfit: p.declaredProfit } : {};
  switch (p.scheme) {
    case "44AD":
      if (p.digitalTurnover === undefined && p.otherTurnover === undefined) {
        throw new Error(
          "presumptiveBusiness 44AD needs digitalTurnover and/or otherTurnover",
        );
      }
      return {
        scheme: "44AD",
        digitalTurnover: p.digitalTurnover ?? 0,
        otherTurnover: p.otherTurnover ?? 0,
        ...(p.cashReceiptsWithin5Pct !== undefined
          ? { cashReceiptsWithin5Pct: p.cashReceiptsWithin5Pct }
          : {}),
        ...declared,
      };
    case "44ADA":
      if (
        p.grossReceipts === undefined ||
        p.cashReceiptsWithin5Pct === undefined
      ) {
        throw new Error(
          "presumptiveBusiness 44ADA needs grossReceipts and cashReceiptsWithin5Pct (whether cash receipts were within the limit, which decides the ceiling)",
        );
      }
      return {
        scheme: "44ADA",
        grossReceipts: p.grossReceipts,
        cashReceiptsWithin5Pct: p.cashReceiptsWithin5Pct,
        ...declared,
      };
    case "44AE":
      if (!p.carriages || p.carriages.length === 0) {
        throw new Error(
          "presumptiveBusiness 44AE needs carriages: one entry per goods carriage owned in the year",
        );
      }
      return {
        scheme: "44AE",
        carriages: p.carriages.map((c) => ({
          type: c.type,
          monthsOwned: c.monthsOwned,
          ...(c.grossWeightTons !== undefined
            ? { grossWeightTons: c.grossWeightTons }
            : {}),
        })),
        ...(p.maxCarriagesAtAnyTime !== undefined
          ? { maxCarriagesAtAnyTime: p.maxCarriagesAtAnyTime }
          : {}),
        ...declared,
      };
  }
}

interface ResolvedTax {
  input: TaxInput;
  houseProperty?: HousePropertyResult;
  presumptive?: PresumptiveResult;
}

/** compute_tax's input for one regime, with `houses` and `presumptiveBusiness`
 * worked out in code and folded in. House-property income depends on the
 * regime (self-occupied interest is nil under s.115BAC(2)(i)), so this runs
 * once per regime. The head loss goes in as letOut because the s.24(b) caps are
 * already applied: selfOccupied would make compute_tax cap it a second time. */
function resolveTaxInput(
  args: TaxArgs,
  pack: RulePack,
  regime: Regime,
): ResolvedTax {
  const input = toTaxInput({ ...args, regime });
  const resolved: ResolvedTax = { input };
  if (args.houses) {
    if (args.housePropertyLoss > 0) {
      throw new Error(
        "pass either houses or housePropertyLoss, not both: houses works the house-property figure out itself",
      );
    }
    const hp = computeHouseProperty(args.houses, pack, regime);
    input.otherIncome += hp.forComputeTax.otherIncome;
    input.housePropertyLoss = hp.forComputeTax.housePropertyLoss;
    input.housePropertyType = hp.forComputeTax.housePropertyType;
    resolved.houseProperty = hp;
  }
  if (args.presumptiveBusiness) {
    const pr = computePresumptiveIncome(
      toPresumptiveInput(args.presumptiveBusiness),
      pack,
    );
    // Outside the scheme there is no deemed figure to fold in: computing tax
    // on nil business income would look like an answer and be wrong.
    if (!pr.eligible) {
      throw new Error(
        `presumptiveBusiness: the ${pr.scheme} scheme is not available here (${pr.warnings.join("; ")}). The business income then comes from the books of account: pass it in otherIncome instead.`,
      );
    }
    input.otherIncome += pr.forComputeTax.otherIncome;
    resolved.presumptive = pr;
  }
  return resolved;
}

function withoutRegime(input: TaxInput): Omit<TaxInput, "regime"> {
  const { regime: _regime, ...rest } = input;
  return rest;
}

/** Today's date in India, YYYY-MM-DD. Deadlines are Indian calendar dates, so
 * the machine's own time zone must not decide which day it is. */
function indiaToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** The April-to-March financial year containing an ISO date, as "2026-27". */
function fyContaining(iso: string): string {
  const year = Number(iso.slice(0, 4));
  const start = Number(iso.slice(5, 7)) >= 4 ? year : year - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

/** A house-property loss means something different for a self-occupied home
 * and a let-out property, so the tools refuse to guess which one it is. */
function housePropertyTypeError(args: {
  housePropertyLoss: number;
  housePropertyType?: "selfOccupied" | "letOut" | undefined;
}): string | null {
  if (args.housePropertyLoss > 0 && !args.housePropertyType) {
    return "housePropertyLoss needs housePropertyType: 'selfOccupied' for the home you live in (interest capped under s.24(b) in the old regime, not deductible in the new regime) or 'letOut' for a rented-out property (no cap; the part not set off is carried forward). Ask the taxpayer which it is.";
  }
  return null;
}

// Compact JSON: the text copy exists for clients that do not read
// structuredContent (the MCP spec asks for both), and indentation made it about
// a third larger for nothing a model needs.
function ok(structured: unknown, pack?: RulePack) {
  const body = withStatuteNote(structured, pack);
  return {
    content: [{ type: "text" as const, text: JSON.stringify(body) }],
    structuredContent: body as Record<string, unknown>,
  };
}

/** A pack under the Income-tax Act 2025 says so on every result computed with
 * it: the figures are that Act's, the engine's notes still cite 1961 numbers. */
function withStatuteNote(structured: unknown, pack?: RulePack): unknown {
  const note = pack?.statute.note;
  if (!note || typeof structured !== "object" || structured === null) {
    return structured;
  }
  const { disclaimers } = structured as { disclaimers?: unknown };
  return {
    ...structured,
    disclaimers: [...(Array.isArray(disclaimers) ? disclaimers : []), note],
  };
}

function fail(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true as const,
  };
}

/** Mask a PAN as ABCXXXXXXF: first three and last character kept, six X's in
 * between so the masked string stays 10 characters like the original. Both
 * parsers use this so the text mirrors agree. */
function maskPan(pan: string): string {
  return `${pan.slice(0, 3)}XXXXXX${pan.slice(-1)}`;
}

/** Read and parse a TRACES 26AS text export. Shared by parse_form26as and
 * reconcile_documents, so reconcile can take the file itself instead of the
 * model copying every parsed row back into its arguments. */
async function load26AS(
  path: string,
): Promise<{ parsed: Form26AS } | { error: string }> {
  const read = await readDocument(
    path,
    "Provide the absolute path to the TRACES Text export (.txt).",
    [".txt"],
  );
  if ("error" in read) return read;
  return { parsed: parseForm26AS(read.text) };
}

/** Read, decrypt and parse an AIS JSON export. Shared by parse_ais and
 * reconcile_documents. */
async function loadAis(
  path: string,
  creds: {
    pan?: string | undefined;
    dob?: string | undefined;
    password?: string | undefined;
  },
): Promise<{ parsed: AisParsed } | { error: string }> {
  const read = await readDocument(
    path,
    "Provide the absolute path to the AIS JSON download.",
    [".json", ".txt"],
  );
  if ("error" in read) return read;
  try {
    const doc = decryptAis(read.text, {
      ...(creds.pan ? { pan: creds.pan } : {}),
      ...(creds.dob ? { dob: creds.dob } : {}),
      ...(creds.password ? { password: creds.password } : {}),
    });
    return { parsed: parseAisDocument(doc) };
  } catch (err) {
    if (err instanceof AisDecryptError) return { error: err.message };
    return {
      error: `AIS parse failed: ${err instanceof Error ? err.message : err}`,
    };
  }
}

/** The regex in ISO_DATE accepts 2026-02-30; this rejects impossible dates
 * with a message the tool can return. */
function datesError(...values: (string | undefined)[]): string | null {
  for (const v of values) {
    if (v !== undefined && !parseIsoDate(v)) {
      return `"${v}" is not a real date; dates are YYYY-MM-DD.`;
    }
  }
  return null;
}

export function createServer(): McpServer {
  const server = new McpServer({
    name: "itr-agent",
    version: packageVersion(),
  });

  server.registerTool(
    "compute_tax",
    {
      title: "Compute Indian income tax",
      description: `Deterministic Indian income tax computation for a fiscal year. Handles new/old regime slabs, standard deduction, 87A rebate with marginal relief (threshold tested on TOTAL income per the statute; rebate never offsets 111A/112A tax under the new regime), employer NPS under 80CCD(2) in both regimes, house-property loss (self-occupied interest capped by s.24(b), not deductible under 115BAC; set-off capped by s.71(3A); none under 115BAC), 111A/112A capital gains rates with the basic-exemption set-off, surcharge (with the ${pct(P.surcharge.capitalGainsAndDividendCap)} cap on gains and marginal relief), and ${pct(P.cess)} cess (FY ${P.fy} figures). All arithmetic is done in code from a versioned rule pack -- never estimated.`,
      inputSchema: z.object(taxInputShape),
      annotations: READ_ONLY,
    },
    async (args) => {
      try {
        const hpError = housePropertyTypeError(args);
        if (hpError) return fail(hpError);
        const pack = loadRulePack(args.fy);
        const r = resolveTaxInput(args, pack, args.regime);
        return ok(
          {
            ...computeTax(r.input, pack),
            ...(r.houseProperty ? { houseProperty: r.houseProperty } : {}),
            ...(r.presumptive ? { presumptiveIncome: r.presumptive } : {}),
          },
          pack,
        );
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
        "Compute tax under BOTH regimes for the same income and return a side-by-side comparison with the recommended regime and the savings amount. Pass the old-regime deductions you could actually claim; the new regime ignores them. `breakeven` says, from code, the smallest old-regime deductions at which the old regime costs no more than the new one and how much more that is than what was passed (null when no amount gets there). Quote it rather than estimating.",
      inputSchema: (() => {
        const { regime: _regime, ...rest } = taxInputShape;
        return z.object(rest);
      })(),
      annotations: READ_ONLY,
    },
    async (args) => {
      try {
        const hpError = housePropertyTypeError(args);
        if (hpError) return fail(hpError);
        const pack = loadRulePack(args.fy);
        const newR = resolveTaxInput(args, pack, "new");
        const oldR = resolveTaxInput(args, pack, "old");
        const newTax = computeTax(newR.input, pack);
        const oldTax = computeTax(oldR.input, pack);
        const winner = newTax.totalTax <= oldTax.totalTax ? "new" : "old";
        return ok(
          {
            fy: pack.fy,
            newRegime: newTax,
            oldRegime: oldTax,
            recommended: winner,
            savings: Math.abs(newTax.totalTax - oldTax.totalTax),
            breakeven: regimeBreakeven(
              withoutRegime(oldR.input),
              pack,
              withoutRegime(newR.input),
            ),
            ...(newR.houseProperty && oldR.houseProperty
              ? {
                  houseProperty: {
                    new: newR.houseProperty,
                    old: oldR.houseProperty,
                  },
                }
              : {}),
            ...(newR.presumptive
              ? { presumptiveIncome: newR.presumptive }
              : {}),
            disclaimers: newTax.disclaimers,
          },
          pack,
        );
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "schedule_advance_tax",
    {
      title: "Plan advance tax installments",
      description: `Build the advance tax installment plan (${P.advanceTax.installments.map((i) => `${i.dueDate} at ${pct(i.cumulativePct)}`).join(", ")} cumulative, MM-DD, FY ${P.fy}) for an estimated tax liability net of TDS. Reports per-installment amounts and shortfalls against what has been paid so far.`,
      inputSchema: z.object({
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
          .array(z.number().min(0).max(MAX_RUPEES))
          .max(4)
          .optional()
          .describe("Advance tax already paid per installment, in order"),
        fy: z
          .string()
          .default(DEFAULT_FY)
          .describe("Fiscal year, e.g. '2025-26'"),
      }),
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
          pack,
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
      inputSchema: z.object({
        fy: z
          .string()
          .default(DEFAULT_FY)
          .describe("Fiscal year, e.g. '2025-26'"),
      }),
      annotations: READ_ONLY,
    },
    async (args) => {
      try {
        const pack = loadRulePack(args.fy);
        const c = pack.oldRegime.deductionCaps;
        const cap = (key: string) => rs(c[key] ?? 0);
        return ok(
          {
            fy: pack.fy,
            caps: c,
            hraMetros: pack.hra.metroCities,
            notes: [
              `80C cap ${cap("80C")} covers PPF, ELSS, EPF, life insurance, principal repayment, tuition fees combined.`,
              `80CCD(1B) is an ADDITIONAL ${cap("80CCD1B")} for NPS over the 80C cap.`,
              `80D: self/family ${cap("80D_self")} (${cap("80D_self_senior")} if senior) + parents ${cap("80D_parents")} (${cap("80D_parents_senior")} if senior); preventive checkup ${cap("80D_preventiveCheckup")} sublimit inside the caps.`,
              `HRA exemption = least of (actual HRA, rent - ${pct(pack.hra.rentExcessOfSalaryPct)} salary, ${pct(pack.hra.metroPct)} salary in a metro (${pack.hra.metroCities.join(", ")}) / ${pct(pack.hra.nonMetroPct)} elsewhere).`,
              "None of these apply under the new regime except employer NPS 80CCD(2).",
            ],
            disclaimers: [
              "Not tax advice. Caps are per the FY rule pack; eligibility conditions apply.",
            ],
          },
          pack,
        );
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
        "Parse the caret-delimited Form 26AS TEXT export from TRACES into structured TDS entries (deductor, TAN, section, amounts, booking status) with totals, plus TCS rows (206C*) separated into tcsEntries. Reports creditableTdsDeposited (status F rows only) alongside the raw total. Download the 'Text' format from TRACES (the archive opens with your DOB as DDMMYYYY); PDF exports are not supported.",
      inputSchema: z.object({
        path: z
          .string()
          .describe(
            "Absolute path to the 26AS .txt file downloaded from TRACES",
          ),
      }),
      annotations: READ_ONLY,
    },
    async (args) => {
      const loaded = await load26AS(args.path);
      if ("error" in loaded) return fail(loaded.error);
      const parsed = loaded.parsed;
      // PII hygiene: mask PAN in the text mirror; keep it structured.
      const masked = {
        ...parsed,
        pan: parsed.pan ? maskPan(parsed.pan) : null,
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(masked) }],
        structuredContent: parsed as unknown as Record<string, unknown>,
      };
    },
  );

  server.registerTool(
    "parse_ais",
    {
      title: "Parse AIS (Annual Information Statement)",
      description:
        "Decrypt and parse the AIS JSON export from the income tax portal, entirely on-device. Provide pan + dob (DDMMYYYY) to derive the password, or pass it explicitly. Returns taxpayer info, normalized information rows (TDS entries, SFT transactions) with amounts, dates, and codes extracted by column label, and `totals` summed in code: every section/element/code group with its row count and amount (each group's `key` is what reconcile_documents takes as interestGroups/dividendGroups), and salary per employer TAN from section 192 TDS rows. Never add up rows yourself. The decryption scheme is reverse-engineered from the AIS utility; if it fails, use the portal's CSV export as a fallback and file an issue.",
      inputSchema: z.object({
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
          // The password is derived from the digits with separators stripped, so
          // an ISO date silently derives "19900115" instead of "15011990": all
          // four candidates then fail and the decrypt error blames a rotated
          // export format. Reject the wrong format here, where the message can
          // name it.
          .regex(
            /^\d{2}[-/]?\d{2}[-/]?\d{4}$/,
            "DOB must be DDMMYYYY or DD-MM-YYYY (not ISO YYYY-MM-DD)",
          )
          .optional()
          .describe(
            "Date of birth as DDMMYYYY (or DD-MM-YYYY); date of incorporation for non-individuals. NOT ISO YYYY-MM-DD.",
          ),
        password: z
          .string()
          .optional()
          .describe(
            "Explicit decryption password (overrides pan+dob derivation)",
          ),
      }),
      annotations: READ_ONLY,
    },
    async (args) => {
      const loaded = await loadAis(args.path, args);
      if ("error" in loaded) return fail(loaded.error);
      const parsed = loaded.parsed;
      // PII hygiene: mask PAN-like values in the text mirror.
      // Case-insensitive: the parser preserves whatever case the file carries
      // (`String(v)`, no normalization), so a lowercase PAN anywhere in the
      // payload -- including free-text remarks and deductor names -- would
      // otherwise pass through the mask unchanged.
      const masked = JSON.stringify(parsed).replace(
        /\b([A-Za-z]{5}\d{4}[A-Za-z])\b/g,
        (pan) => maskPan(pan),
      );
      return {
        content: [{ type: "text" as const, text: masked }],
        structuredContent: parsed as unknown as Record<string, unknown>,
      };
    },
  );

  server.registerTool(
    "compute_interest_234",
    {
      title: "Compute 234A/234B/234C interest",
      description: `Deterministic sections 234A, 234B and 234C interest (FY ${P.fy} rates). 234A: ${pct(P.interest.s234A.ratePerMonth)}/month for filing after the due date, on tax outstanding after all prepaid tax. 234B: ${pct(P.interest.ratePerMonth)}/month on assessed-minus-advance when advance < ${pct(P.advanceTax.section234B_paidThresholdPct)} (from 1 April of the AY), reduced by self-assessment payments under s.140A. 234C: per-installment shortfalls with the statutory ${P.interest.s234C.installments
        .filter((i) => i.safeHarborPct !== null)
        .map((i) => pct(i.safeHarborPct ?? 0))
        .join(
          "/",
        )} safe harbors for June/September, measured on tax due on RETURNED income. Rule 119A rounding applied (principal floored to ${rs(P.rounding.interestBase119A)}, part month = full month). Pass dates (filingDate with form, paidOrAssessedDate, payment dates) and the tool counts the months; month counts are still accepted. Each section is computed only when its own inputs are supplied; anything skipped is named in \`skipped\`.`,
      inputSchema: z.object(interest234Shape),
      annotations: READ_ONLY,
    },
    async (args) => {
      try {
        const pack = loadRulePack(args.fy);
        const skipped: string[] = [];

        const badDate = datesError(
          args.filingDate,
          args.dueDate,
          args.paidOrAssessedDate,
          ...(args.selfAssessmentPayments ?? []).map((p) => p.date),
        );
        if (badDate) return fail(badDate);

        // Month counts come from dates in code (Rule 119A, the pack's
        // partMonthIsFullMonth), unless the caller passed a count outright.
        const partFull = pack.interest.partMonthIsFullMonth;
        const from234B = start234B(pack);
        const monthsUsed: Record<string, string> = {};

        let months234B = args.monthsFor234B;
        const end234B = args.paidOrAssessedDate ?? args.filingDate;
        if (months234B !== undefined && args.paidOrAssessedDate) {
          return fail(
            "pass either monthsFor234B or paidOrAssessedDate, not both",
          );
        }
        if (months234B === undefined) {
          if (!end234B) {
            return fail(
              "234B needs monthsFor234B, or paidOrAssessedDate / filingDate so the tool can count the months from 1 April of the AY.",
            );
          }
          months234B = interestMonths(from234B, end234B, partFull);
          monthsUsed.s234B = `${months234B} month(s): ${from234B} to ${end234B}`;
        }

        const payments: SelfAssessmentPayment[] = [];
        for (const p of args.selfAssessmentPayments ?? []) {
          const months =
            p.monthsFromApril ??
            (p.date ? interestMonths(from234B, p.date, partFull) : undefined);
          if (months === undefined) {
            return fail(
              "each selfAssessmentPayments entry needs `date` (or monthsFromApril)",
            );
          }
          payments.push({ monthsFromApril: months, amount: p.amount });
        }

        const b = interest234B(
          {
            assessedTax: args.assessedTax,
            advanceTaxPaid: args.advanceTaxPaid,
            months: months234B,
            ...(payments.length > 0
              ? { selfAssessmentPayments: payments }
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

        let monthsLate = args.monthsLateFiling;
        if (args.filingDate) {
          if (monthsLate > 0) {
            return fail("pass either monthsLateFiling or filingDate, not both");
          }
          const dueKey =
            args.form === "ITR-1" || args.form === "ITR-2"
              ? "itr1_2"
              : "itr3_4_nonAudit";
          const due =
            args.dueDate ?? (args.form ? pack.deadlines[dueKey] : undefined);
          if (!due) {
            return fail(
              "234A from filingDate needs `form` (to take the s.139(1) due date from the rule pack) or an explicit `dueDate`.",
            );
          }
          const from234A = start234A(due, pack);
          monthsLate = interestMonths(from234A, args.filingDate, partFull);
          monthsUsed.s234A =
            monthsLate > 0
              ? `${monthsLate} month(s): ${from234A} to ${args.filingDate} (due date ${due})`
              : `filed on or before the due date ${due}`;
        }

        const a =
          monthsLate > 0
            ? interest234A(
                {
                  taxOnTotalIncomeNetOfPrepaid:
                    args.taxOutstandingFor234A ??
                    args.taxOutstandingForms234A ??
                    Math.max(0, args.assessedTax - args.advanceTaxPaid),
                  months: monthsLate,
                },
                pack,
              )
            : null;
        if (!a) {
          skipped.push(
            args.filingDate
              ? "234A not computed: the filing date is on or before the due date."
              : "234A not computed: the return is treated as filed on time (`monthsLateFiling` is 0 and no filingDate was given).",
          );
        }

        return ok(
          {
            fy: pack.fy,
            section234A: a,
            section234B: b,
            section234C: c,
            totalInterest:
              (a?.interest ?? 0) + b.interest + (c?.totalInterest ?? 0),
            monthsUsed,
            skipped,
            disclaimers: [
              "Not tax advice. Capital-gains/dividend 234C exclusions (first proviso) are not auto-applied: exclude such income from the base for the earlier installments yourself.",
              "Resident seniors (60+) with no business income owe no advance tax, hence no 234B/234C.",
              "234A stops at the date of filing; 234B runs to the date of payment or assessment. Supply the dates you can evidence.",
            ],
          },
          pack,
        );
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "compute_hra",
    {
      title: "Compute HRA exemption (+80GG)",
      description: `HRA exemption per Rule 2A: least of (actual HRA, rent minus ${pct(P.hra.rentExcessOfSalaryPct)} of salary, ${pct(P.hra.metroPct)} metro / ${pct(P.hra.nonMetroPct)} non-metro of salary), computed period-wise. Salary = basic + retirement-forming DA + fixed-percentage turnover commission. Old regime only. Give each period's city: the tool checks it against the fy's rule-pack metro list (FY ${P.fy}: ${P.hra.metroCities.join(", ")}). Also computes the 80GG alternative for rent payers who received no HRA at any time in the year (the two are mutually exclusive).`,
      inputSchema: z.object(hraShape),
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
          return ok(
            {
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
            },
            pack,
          );
        }
        if (!args.periods || args.periods.length === 0) {
          return fail(
            "compute_hra needs `periods` (one per homogeneous stretch of salary/rent/HRA/city) unless `eightyGG` is supplied.",
          );
        }
        // Metro status is a lookup against the fy's own list, not a judgement
        // made from a description written for one year.
        const periods: HraPeriod[] = [];
        const metroBasis: string[] = [];
        for (const [i, p] of args.periods.entries()) {
          const { city, isMetro, daRetirement, turnoverCommission, ...rest } =
            p;
          let metro: boolean;
          if (city !== undefined) {
            metro = isMetroCity(city, pack);
            metroBasis.push(
              `period ${i + 1}: ${city} is ${metro ? "" : "not "}on the FY ${pack.fy} metro list (${pack.hra.metroCities.join(", ")})`,
            );
          } else if (isMetro !== undefined) {
            metro = isMetro;
            metroBasis.push(
              `period ${i + 1}: metro status taken from isMetro (${metro}); pass the city to have it checked`,
            );
          } else {
            return fail(
              `period ${i + 1} needs \`city\` (preferred) or \`isMetro\` to apply the metro limb`,
            );
          }
          periods.push({
            ...rest,
            ...(daRetirement !== undefined ? { daRetirement } : {}),
            ...(turnoverCommission !== undefined ? { turnoverCommission } : {}),
            isMetro: metro,
          });
        }
        const result = computeHra(periods, pack, args.regime);
        return ok(
          {
            ...result,
            notes: [...result.notes, ...metroBasis],
            rulePackVersion: pack.rulePackVersion,
            disclaimers,
          },
          pack,
        );
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
        "Cross-document mismatch report -- the checks that pre-empt 143(1)(a) intimations and 139(9) defect notices: TDS claimed vs 26AS deposited (the ledger of record), missing-employer detection, AIS interest/dividend vs declared, Form 16 vs 26AS per-TAN totals, declared salary below the Form 16 total, and 26AS rows missing the gross amount. Also groups 26AS TDS by income head so each credit can be placed in the right schedule. Prefer the file inputs: form26asPath reads the 26AS export itself, and aisFile decrypts the AIS and sums the groups you name, so no row or total is copied by hand. Pass whichever documents you have; checks needing missing inputs are reported as skipped.",
      inputSchema: z.object({
        form26asPath: z
          .string()
          .optional()
          .describe(
            "Absolute path to the 26AS TRACES Text export (.txt). Parsed here, so the rows never pass through your arguments. Use instead of form26asTds.",
          ),
        aisFile: z
          .object({
            path: z.string().describe("Absolute path to the AIS JSON download"),
            pan: z
              .string()
              .regex(/^[A-Za-z]{5}\d{4}[A-Za-z]$/)
              .optional()
              .describe("PAN, to derive the decryption password"),
            dob: z
              .string()
              .regex(
                /^\d{2}[-/]?\d{2}[-/]?\d{4}$/,
                "DOB must be DDMMYYYY or DD-MM-YYYY (not ISO YYYY-MM-DD)",
              )
              .optional()
              .describe("Date of birth as DDMMYYYY"),
            password: z
              .string()
              .optional()
              .describe("Explicit decryption password"),
            interestGroups: z
              .array(z.string().max(500))
              .max(100)
              .optional()
              .describe(
                "Keys from parse_ais totals.groups to count as interest. Name each source once: a bank can report the same interest as a TDS row and again as an SFT row.",
              ),
            dividendGroups: z
              .array(z.string().max(500))
              .max(100)
              .optional()
              .describe(
                "Keys from parse_ais totals.groups to count as dividend, each source once",
              ),
          })
          .optional()
          .describe(
            "The AIS export itself: salary by TAN is taken from section 192 TDS rows, and interest/dividend are the code-summed totals of the groups you name. Any figure given in `ais` overrides the file's.",
          ),
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
                .min(-MAX_RUPEES)
                .max(MAX_RUPEES)
                .describe(
                  "Amount paid or credited in INR (may be negative on a correction row)",
                ),
              tdsDeposited: z
                .number()
                .min(-MAX_RUPEES)
                .max(MAX_RUPEES)
                .describe(
                  "TDS deposited in INR (may be negative on a correction row)",
                ),
              status: z
                .string()
                .max(2)
                .nullable()
                .optional()
                .describe(
                  "TRACES booking status from parse_form26as: F (final, creditable), P (provisional), U (unmatched), O (overbooked)",
                ),
            }),
          )
          .max(2000)
          .optional()
          .describe(
            "TDS entries from parse_form26as (tdsEntries, not tcsEntries)",
          ),
        form16: z
          .array(
            z.object({
              tan: z.string().describe("Employer TAN from Form 16 Part A"),
              grossSalary: z
                .number()
                .min(0)
                .max(MAX_RUPEES)
                .optional()
                .describe("GROSS salary per Form 16 Part B, before exemptions"),
              tdsDeposited: z
                .number()
                .min(0)
                .max(MAX_RUPEES)
                .describe("Total TDS deposited per Form 16 Part A, in INR"),
            }),
          )
          .max(50)
          .optional()
          .describe("Per-employer Form 16 Part A figures"),
        ais: z
          .object({
            salaryByTan: z
              .record(z.string(), z.number().min(0).max(MAX_RUPEES))
              .optional()
              .describe("AIS gross salary keyed by employer TAN"),
            interestTotal: z
              .number()
              .min(0)
              .max(MAX_RUPEES)
              .optional()
              .describe("Total AIS interest across all banks, in INR"),
            dividendTotal: z
              .number()
              .min(0)
              .max(MAX_RUPEES)
              .optional()
              .describe("Total AIS dividend, in INR"),
          })
          .optional()
          .describe(
            "AIS aggregates, when you have figures rather than the file. Take them from parse_ais `totals` (summed in code), never by adding rows yourself; prefer aisFile.",
          ),
        return: z
          .object({
            tdsClaimed: z
              .number()
              .min(0)
              .max(MAX_RUPEES)
              .optional()
              .describe("Total TDS credit claimed in the draft return"),
            salaryDeclared: z
              .number()
              .min(0)
              .max(MAX_RUPEES)
              .optional()
              .describe("Gross salary declared in the draft return, in INR"),
            interestDeclared: z
              .number()
              .min(0)
              .max(MAX_RUPEES)
              .optional()
              .describe("Interest income declared, GROSS of 80TTA/80TTB"),
            dividendDeclared: z
              .number()
              .min(0)
              .max(MAX_RUPEES)
              .optional()
              .describe("Dividend declared, gross of TDS"),
          })
          .optional()
          .describe("Figures from the draft return"),
        fy: z
          .string()
          .default(DEFAULT_FY)
          .describe("Fiscal year, e.g. '2025-26' (AY 2026-27)"),
      }),
      annotations: READ_ONLY,
    },
    async (args) => {
      try {
        const pack = loadRulePack(args.fy);
        if (args.form26asPath && args.form26asTds) {
          return fail("pass either form26asPath or form26asTds, not both");
        }

        // Documents read here, so neither the 26AS rows nor the AIS totals pass
        // through the model's arguments.
        const fromFiles: Record<string, unknown> = {};
        let tdsRows: TdsSummaryEntry[] | undefined = args.form26asTds;
        if (args.form26asPath) {
          const loaded = await load26AS(args.form26asPath);
          if ("error" in loaded) return fail(loaded.error);
          tdsRows = loaded.parsed.tdsEntries;
          fromFiles.form26as = {
            tdsRows: loaded.parsed.tdsEntries.length,
            tcsRowsIgnored: loaded.parsed.tcsEntries.length,
            warnings: loaded.parsed.warnings,
          };
        }

        let ais: ReconcileInput["ais"] = args.ais;
        if (args.aisFile) {
          const f = args.aisFile;
          const loaded = await loadAis(f.path, f);
          if ("error" in loaded) return fail(loaded.error);
          const groups = loaded.parsed.totals.groups;
          const byKey = new Map(groups.map((g) => [g.key, g]));
          const sumGroups = (keys: string[] | undefined, label: string) => {
            if (!keys) return { total: undefined, error: null };
            const missing = keys.filter((k) => !byKey.has(k));
            if (missing.length > 0) {
              return {
                total: undefined,
                error: `aisFile.${label}: no group with key ${missing.map((k) => JSON.stringify(k)).join(", ")}. Keys come from parse_ais totals.groups; this file has ${groups.length} group(s).`,
              };
            }
            return {
              total: sumRupees(keys.map((k) => byKey.get(k)?.amount ?? 0)),
              error: null,
            };
          };
          const interest = sumGroups(f.interestGroups, "interestGroups");
          if (interest.error) return fail(interest.error);
          const dividend = sumGroups(f.dividendGroups, "dividendGroups");
          if (dividend.error) return fail(dividend.error);
          const salaryByTan = loaded.parsed.totals.salaryByTan;
          ais = {
            ...(Object.keys(salaryByTan).length > 0 ? { salaryByTan } : {}),
            ...(interest.total !== undefined
              ? { interestTotal: interest.total }
              : {}),
            ...(dividend.total !== undefined
              ? { dividendTotal: dividend.total }
              : {}),
            ...(args.ais ?? {}),
          };
          fromFiles.ais = {
            groups: groups.length,
            salaryTans: Object.keys(salaryByTan).length,
            interestGroups: f.interestGroups ?? [],
            dividendGroups: f.dividendGroups ?? [],
            warnings: loaded.parsed.warnings,
          };
        }

        const input: ReconcileInput = {
          ...(tdsRows ? { form26asTds: tdsRows } : {}),
          ...(args.form16 ? { form16: args.form16 } : {}),
          ...(ais ? { ais } : {}),
          ...(args.return ? { return: args.return } : {}),
        };
        return ok({ ...reconcile(input, pack), fromFiles }, pack);
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "recommend_itr_form",
    {
      title: "Recommend the ITR form",
      description: `Recommend ITR-1/2/3/4 for an individual from income heads, residency, losses, and disqualifier flags, with rule-by-rule reasoning. Loss-continuity aware: brought-forward business/speculative losses force ITR-3 even with zero current-year business income (Schedule CFL). Checks the 44AD/44ADA turnover ceilings when presumptiveTurnover is supplied, the 44AE vehicle limit when vehicles44AE is supplied, and the ITR-1/ITR-4 house-property limit (${P.itrEligibility.maxHouseProperties} for AY ${P.ay}). Returns the filing deadline with its statutory citation, the belated and revised deadlines, and the 234F late fee.`,
      inputSchema: z.object({
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
            `Estimated TOTAL income in INR, i.e. after Chapter VI-A deductions -- this is the figure the ${rs(P.itrEligibility.simpleFormIncomeCap)} ITR-1/ITR-4 ceiling tests (AY ${P.ay}). Use the gross figure only if you have no deductions.`,
          ),
        houseProperties: z
          .number()
          .int()
          .min(0)
          .max(1000)
          .default(0)
          .describe(
            `Number of house properties with income or loss (ITR-1/ITR-4 admit up to ${P.itrEligibility.maxHouseProperties} for AY ${P.ay})`,
          ),
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
          .describe(
            `LTCG under 112A in INR before the ${rs(P.capitalGains.ltcg112AExemption)} exemption`,
          ),
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
        presumptiveScheme: z
          .enum(["44AD", "44ADA", "44AE"])
          .optional()
          .describe(
            "Which presumptive section (drives the turnover ceiling check; defaults to 44AD)",
          ),
        presumptiveTurnover: z
          .number()
          .min(0)
          .max(MAX_RUPEES)
          .optional()
          .describe(
            `44AD turnover or 44ADA gross receipts in INR. Above ${rs(P.itrEligibility.presumptive.turnoverCap44AD)} (${rs(P.itrEligibility.presumptive.turnoverCap44ADDigital)} with cash receipts within 5%) / ${rs(P.itrEligibility.presumptive.receiptsCap44ADA)} (${rs(P.itrEligibility.presumptive.receiptsCap44ADADigital)}) the scheme lapses and ITR-3 with audit applies (FY ${P.fy}). Omit to skip the check.`,
          ),
        cashReceiptsWithin5Pct: z
          .boolean()
          .default(false)
          .describe(
            `Cash receipts are at most 5% of turnover/receipts (lifts the 44AD/44ADA ceiling to ${rs(P.itrEligibility.presumptive.turnoverCap44ADDigital)} / ${rs(P.itrEligibility.presumptive.receiptsCap44ADADigital)} for FY ${P.fy})`,
          ),
        hasNonPresumptiveBusiness: z
          .boolean()
          .default(false)
          .describe(
            "Also has business/professional income OUTSIDE the presumptive scheme (ITR-4 cannot carry both)",
          ),
        vehicles44AE: z
          .number()
          .int()
          .min(0)
          .max(10000)
          .optional()
          .describe(
            `44AE only: the most goods carriages owned at any time in the year (the scheme allows up to ${P.itrEligibility.presumptive.maxVehicles44AE}). Omit to skip the check.`,
          ),
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
            `Agricultural income in INR (above ${rs(P.itrEligibility.agriIncomeCap)} rules out ITR-1/ITR-4)`,
          ),
        esopDeferral: z
          .boolean()
          .default(false)
          .describe("Tax deferred on eligible-startup ESOPs (s80-IAC)"),
        hasLotteryOrGamingIncome: z
          .boolean()
          .default(false)
          .describe("Winnings from lottery, online games, or racehorses"),
        tds194N: z
          .boolean()
          .default(false)
          .describe(
            "TDS was deducted under s.194N on cash withdrawals (rules out ITR-1)",
          ),
      }),
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
          ...(args.presumptiveScheme
            ? { presumptiveScheme: args.presumptiveScheme }
            : {}),
          ...(args.presumptiveTurnover !== undefined
            ? { presumptiveTurnover: args.presumptiveTurnover }
            : {}),
          cashReceiptsWithin5Pct: args.cashReceiptsWithin5Pct,
          hasNonPresumptiveBusiness: args.hasNonPresumptiveBusiness,
          ...(args.vehicles44AE !== undefined
            ? { vehicles44AE: args.vehicles44AE }
            : {}),
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
          tds194N: args.tds194N,
        };
        return ok(recommendItrForm(input, pack), pack);
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
      inputSchema: z.object({
        fy: z
          .string()
          .default(DEFAULT_FY)
          .describe("Fiscal year, e.g. '2025-26'"),
        form: z
          .enum(["ITR-1", "ITR-2", "ITR-3", "ITR-4"])
          .describe("The ITR form to file (use recommend_itr_form if unsure)"),
      }),
      annotations: READ_ONLY,
    },
    async (args) => {
      try {
        const pack = loadRulePack(args.fy);
        return ok(filingChecklist(args.form, pack), pack);
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "compute_house_property",
    {
      title: "Compute income from house property",
      description: `Work out the head "Income from house property" per house from rent, municipal tax and home-loan interest: annual value, the ${pct(P.houseProperty.standardDeductionPct)} standard deduction (s.24(a)), interest with the self-occupied cap of ${rs(P.oldRegime.deductionCaps["24b_selfOccupied"] ?? 0)} shared across self-occupied houses (${rs(P.houseProperty.selfOccupiedInterestCapOlder)} for an older loan; nil under the new regime), pre-construction interest in ${P.houseProperty.preConstructionInstallments} instalments, and houses past the ${P.houseProperty.maxSelfOccupied}-house self-occupied limit deemed let out (FY ${P.fy} figures). compute_tax and compare_regimes take the same \`houses\` input and fold the result in themselves; use this tool to show the working.`,
      inputSchema: z.object(houseHeadShape),
      annotations: READ_ONLY,
    },
    async (args) => {
      try {
        const pack = loadRulePack(args.fy);
        return ok(computeHouseProperty(args.houses, pack, args.regime), pack);
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "compute_presumptive_income",
    {
      title: "Compute presumptive business income",
      description: `Deemed profit under the presumptive schemes (FY ${P.fy} figures): 44AD at ${pct(p44.deemedProfit44AD)} of turnover (${pct(p44.deemedProfit44ADDigital)} of digital receipts) up to ${rs(p44.turnoverCap44AD)}, or ${rs(p44.turnoverCap44ADDigital)} where cash is at most ${pct(p44.cashShareLimit)}; 44ADA at ${pct(p44.deemedProfit44ADA)} of professional receipts up to ${rs(p44.receiptsCap44ADA)} / ${rs(p44.receiptsCap44ADADigital)}; 44AE per goods carriage per month for up to ${p44.maxVehicles44AE} vehicles. Reports eligibility, the deemed figure with its working, and the income to report (the higher of deemed and declared). compute_tax takes the same \`presumptiveBusiness\` input and adds the income itself.`,
      inputSchema: z.object(presumptiveToolShape),
      annotations: READ_ONLY,
    },
    async (args) => {
      try {
        const pack = loadRulePack(args.fy);
        return ok(
          computePresumptiveIncome(toPresumptiveInput(args), pack),
          pack,
        );
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "compute_loss_setoff",
    {
      title: "Set off and carry forward losses",
      description: `Apply current-year and brought-forward losses in statutory order (s.70 within a head, s.71 across heads with the ${rs(P.oldRegime.deductionCaps.housePropertyLossSetOff ?? 0)} house-property cap and no business loss against salary, then ss.71B/72/73/74 oldest first) and report each step with its section, income by head after set-off, what is carried forward with the last year it can be used (house property ${P.lossCarryForward.housePropertyYears}, business ${P.lossCarryForward.businessYears}, speculative ${P.lossCarryForward.speculativeYears}, capital ${P.lossCarryForward.capitalYears} years), what expired, what s.80 forfeits on a late return, and Schedule CYLA/BFLA/CFL rows. \`forComputeTax\` goes into compute_tax or tax_summary field for field, with nothing added (do not also pass houses there).`,
      inputSchema: z.object(lossSetoffShape),
      annotations: READ_ONLY,
    },
    async (args) => {
      try {
        const pack = loadRulePack(args.fy);
        const cg = args.capitalGains;
        return ok(
          computeLossSetoff(
            {
              regime: args.regime,
              filedByDueDate: args.filedByDueDate,
              ...(args.salaryIncome !== undefined
                ? { salaryIncome: args.salaryIncome }
                : {}),
              ...(args.houseProperty !== undefined
                ? { houseProperty: args.houseProperty }
                : {}),
              ...(args.housePropertyType
                ? { housePropertyType: args.housePropertyType }
                : {}),
              ...(args.business !== undefined
                ? { business: args.business }
                : {}),
              ...(args.speculative !== undefined
                ? { speculative: args.speculative }
                : {}),
              ...(args.otherSources !== undefined
                ? { otherSources: args.otherSources }
                : {}),
              ...(cg
                ? {
                    capitalGains: Object.fromEntries(
                      Object.entries(cg).filter(([, v]) => v !== undefined),
                    ),
                  }
                : {}),
              broughtForward: args.broughtForward,
            },
            pack,
          ),
          pack,
        );
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "tax_summary",
    {
      title: "What do I owe: tax, interest and fee in one call",
      description: `One computation of what is payable or refundable for the year: tax (compute_tax, with houses and presumptiveBusiness folded in), less TDS and TCS read from the Form 26AS file itself (creditable status F rows), advance tax and self-assessment tax, plus s.234A, s.234B and s.234C interest with every month count taken from the dates, and the s.234F fee (${rs(P.lateFee234F.default)}, ${rs(P.lateFee234F.incomeUpTo5L)} up to ${rs(P.lateFee234F.incomeThreshold)} of income) when filed after the due date. The due date comes from the rule pack by form; the filing date defaults to today in India. Net is rounded under s.288B; negative is a refund. Use this instead of subtracting TDS or counting months yourself.`,
      inputSchema: z.object(taxSummaryShape),
      annotations: READ_ONLY,
    },
    async (args) => {
      try {
        const hpError = housePropertyTypeError(args);
        if (hpError) return fail(hpError);
        const badDate = datesError(
          args.filingDate,
          args.dueDate,
          ...args.advanceTaxPayments.map((p) => p.date),
          ...(args.selfAssessmentPayments ?? []).map((p) => p.date),
        );
        if (badDate) return fail(badDate);
        const pack = loadRulePack(args.fy);

        let tdsCredit: number;
        let tcsCredit: number;
        let form26as: Record<string, unknown> | null = null;
        if (args.form26asPath) {
          if (args.tdsCredit !== undefined || args.tcsCredit !== undefined) {
            return fail(
              "pass form26asPath or tdsCredit/tcsCredit, not both: the file is read for both credits",
            );
          }
          const loaded = await load26AS(args.form26asPath);
          if ("error" in loaded) return fail(loaded.error);
          const f = loaded.parsed;
          if (f.assessmentYear && f.assessmentYear !== pack.ay) {
            return fail(
              `this 26AS is for AY ${f.assessmentYear}, but fy ${pack.fy} is AY ${pack.ay}. Pass the matching fy, or the 26AS for AY ${pack.ay}.`,
            );
          }
          tdsCredit = f.creditableTdsDeposited;
          tcsCredit = sumRupees(
            f.tcsEntries
              .filter((e) => e.status === "F" || e.status === null)
              .map((e) => e.tcsDeposited),
          );
          form26as = {
            assessmentYear: f.assessmentYear,
            creditableTdsDeposited: f.creditableTdsDeposited,
            totalTdsDeposited: f.totalTdsDeposited,
            tcsCredited: tcsCredit,
            totalTcsDeposited: f.totalTcsDeposited,
            warnings: f.warnings,
          };
        } else if (args.tdsCredit === undefined) {
          return fail(
            "tax_summary needs form26asPath (the TRACES Text export, preferred: the tool reads the creditable TDS itself) or tdsCredit (0 when no tax was deducted).",
          );
        } else {
          tdsCredit = args.tdsCredit;
          tcsCredit = args.tcsCredit ?? 0;
        }

        const dueKey =
          args.form === "ITR-1" || args.form === "ITR-2"
            ? "itr1_2"
            : "itr3_4_nonAudit";
        const dueDate =
          args.dueDate ?? (args.form ? pack.deadlines[dueKey] : undefined);
        if (!dueDate) {
          return fail(
            "tax_summary needs `form` (to take the s.139(1) due date from the rule pack) or an explicit `dueDate`, e.g. for an audit case.",
          );
        }
        const filingDate = args.filingDate ?? indiaToday();
        const scheme = args.presumptiveBusiness?.scheme;
        // s.207(2): a resident senior with no business or professional income
        // pays no advance tax. otherIncome can hold business income, so ask.
        let advanceTaxExempt = false;
        if (args.ageBand !== "below60" && !args.presumptiveBusiness) {
          if (args.businessIncome === undefined) {
            return fail(
              "tax_summary for a senior or super senior needs businessIncome (true or false): a resident senior with no business or professional income owes no advance tax under s.207(2), so no s.234B or s.234C interest.",
            );
          }
          advanceTaxExempt = !args.businessIncome;
        }
        const r = resolveTaxInput(args, pack, args.regime);
        const summary = computeTaxSummary(
          {
            tax: r.input,
            tdsCredit,
            tcsCredit,
            advanceTaxPayments: args.advanceTaxPayments,
            ...(args.selfAssessmentPayments
              ? { selfAssessmentPayments: args.selfAssessmentPayments }
              : {}),
            filingDate,
            dueDate,
            // s.211(1)(b): 44AD / 44ADA pay advance tax in one instalment.
            ...(scheme === "44AD" || scheme === "44ADA"
              ? { presumptive: true }
              : {}),
            ...(advanceTaxExempt ? { advanceTaxExempt: true } : {}),
          },
          pack,
        );
        return ok(
          {
            ...summary,
            filingDate,
            dueDate,
            ...(args.filingDate
              ? {}
              : { filingDateNote: "filingDate defaulted to today in India" }),
            ...(form26as ? { form26as } : {}),
            ...(r.houseProperty ? { houseProperty: r.houseProperty } : {}),
            ...(r.presumptive ? { presumptiveIncome: r.presumptive } : {}),
          },
          pack,
        );
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
              "1. Timing, before anything else: call list_tax_years and read `status`, which the server works out from today's date in India (phase per form, days left, the next advance tax instalment); never compare dates yourself. If the due date for the FY has already passed, say plainly that this will be a BELATED return under s.139(4) (last date in `deadlines.belated`), quote the s.234F late fee from the tool output rather than from memory, and flag both consequences up front: s.234A interest runs on the tax still outstanding from the day after the due date, and s.80 forfeits the carry-forward of the current year's business, speculative and capital losses (a house-property loss survives, s.71B). tax_summary charges the interest and fee from the dates once the tax figures exist.",
              "2. Residency and age band for the FY.",
              "3. Income heads, one by one: salary (how many employers; employer NPS under 80CCD(2), which counts in both regimes), house property (for each house: lived in or let out, rent, municipal tax, home-loan interest and any pre-construction interest; pass them as `houses` and let the tools work out the head), capital gains (equity 111A/112A, anything else), business/professional incl. F&O or freelancing (if presumptive: which section and the year's turnover or receipts; compute_presumptive_income checks the ceilings and pass the same figures as `presumptiveBusiness`), other sources (interest, dividend).",
              `4. Disqualifier sweep: foreign assets or RSUs/ESPP of a foreign employer, director role, unlisted shares, agricultural income over ${rs(P.itrEligibility.agriIncomeCap)}, ESOP deferral, lottery/gaming winnings, TDS under s.194N on cash withdrawals.`,
              "5. Losses: brought-forward or current-year business/speculative/capital/house-property losses (this changes the form, and step 1 decides whether the current year's losses can still be carried forward). Call compute_loss_setoff with last year's Schedule CFL and this year's figures, and pass its forComputeTax to the tax tools field for field.",
              "6. Call recommend_itr_form with everything gathered; explain the recommendation and what ruled out simpler forms.",
              "7. Ask for real amounts, then call compare_regimes (and compute_hra / list_deductions when the old regime is in play). Recommend the regime, quoting `breakeven` for how much more in deductions would flip it.",
              "8. If documents are available, parse them (parse_form26as, parse_ais) to show me what they hold, then run reconcile_documents with the files themselves (form26asPath, and aisFile naming which parse_ais totals.groups are interest and which are dividend, each source once). Never add up rows yourself. Walk me through fixing every finding.",
              "9. What I owe: call tax_summary with the 26AS file (form26asPath), the form, each advance tax and self-assessment payment with its date, and the filing date; it returns tax, interest under s.234A/B/C, the s.234F fee and the net payable or refund. Use schedule_advance_tax for the current year's instalments, and compute_interest_234 only to show one section on its own.",
              "10. Finish with filing_checklist for the recommended form and walk me through it step by step, waiting for my confirmation at each portal step.",
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
        "List the fiscal years this server has rule packs for, with filing deadlines for the current assessment year and `status`: computed from today's date in India, which deadlines have passed, the days left, the phase per ITR form (on time, belated with the s.234F fee, or updated return only), the revised-return window, and the next advance tax instalment of the current financial year. Quote `status` instead of comparing dates yourself. `statutes` gives each year's Act and, for tax year 2026-27 under the Income-tax Act 2025, the map from the 1961 section numbers the notes cite.",
      inputSchema: z.object(listTaxYearsShape),
      annotations: READ_ONLY,
    },
    async (args) => {
      try {
        const asOf = args.asOf ?? indiaToday();
        const badDate = datesError(asOf);
        if (badDate) return fail(badDate);
        const pack = loadRulePack(DEFAULT_FY);
        const currentFy = fyContaining(asOf);
        const currentYearPack = availableYears().includes(currentFy)
          ? loadRulePack(currentFy)
          : undefined;
        return ok({
          supported: availableYears(),
          default: DEFAULT_FY,
          asOf,
          status: filingStatus(asOf, pack, currentYearPack),
          deadlines: pack.deadlines,
          deadlineCitations: pack.deadlineCitations,
          rulePackVersion: pack.rulePackVersion,
          sources: pack.sources,
          statutes: Object.fromEntries(
            availableYears().map((fy) => {
              const { act, sectionMap, forms } = loadRulePack(fy).statute;
              return [fy, { act, sectionMap, forms }];
            }),
          ),
        });
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  );

  return server;
}
