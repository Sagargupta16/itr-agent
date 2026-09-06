import type { RulePack } from "./rulepack.js";

export type Residency = "resident" | "rnor" | "nri";
export type ItrForm = "ITR-1" | "ITR-2" | "ITR-3" | "ITR-4";

/** Brought-forward (or current-year, to-be-carried) losses by type.
 * Presence alone changes form eligibility regardless of amounts. */
export interface LossFlags {
  /** Non-speculative business loss (incl. F&O) brought forward or to carry forward. */
  business: boolean;
  /** Speculative business loss (intraday equity). */
  speculative: boolean;
  /** Capital loss (STCL/LTCL) brought forward or to carry forward. */
  capital: boolean;
  /** House property loss to carry forward. */
  houseProperty: boolean;
}

export interface ItrFormInput {
  residency: Residency;
  /** TOTAL income in INR, i.e. AFTER Chapter VI-A deductions: that is the
   * figure the Rs 50 lakh ITR-1/ITR-4 ceiling tests. */
  totalIncome: number;
  /** Count of house properties with income/loss (self-occupied counts). */
  houseProperties: number;
  /** STCG under 111A in INR. Any amount disqualifies ITR-1/ITR-4. */
  stcg111A: number;
  /** LTCG under 112A in INR, BEFORE the 1.25L exemption. */
  ltcg112A: number;
  /** Capital gains other than 111A/112A (debt MF, property, unlisted, foreign). */
  hasOtherCapitalGains: boolean;
  /** Any business or professional income this year (incl. F&O, freelancing). */
  hasBusinessIncome: boolean;
  /** Opting for presumptive taxation (44AD trade / 44ADA profession / 44AE transport). */
  presumptive: boolean;
  /** Partner in a partnership firm (remuneration/interest/share). */
  isPartnerInFirm: boolean;
  losses: LossFlags;
  /** Foreign assets, foreign income, or signing authority abroad (incl. vested RSUs/ESPP of a foreign parent). */
  hasForeignAssetsOrIncome: boolean;
  /** Director in any company at any time during the FY. */
  isDirector: boolean;
  /** Held unlisted equity shares at any time during the FY (incl. foreign startup/pre-IPO). */
  holdsUnlistedShares: boolean;
  /** Agricultural income in INR. */
  agriIncome: number;
  /** Tax deferred on ESOPs from an eligible startup (s80-IAC). */
  esopDeferral: boolean;
  /** Winnings from lottery / online games / racehorses. */
  hasLotteryOrGamingIncome: boolean;
}

export interface FormRuleHit {
  /** The form ruled out (or forced). */
  form: ItrForm;
  /** Human-readable statutory reason. */
  rule: string;
}

export interface ItrFormResult {
  fy: string;
  ay: string;
  recommended: ItrForm;
  /** Why the recommended form, rule by rule. */
  reasons: string[];
  /** Which simpler forms were ruled out and by what. */
  ruledOut: FormRuleHit[];
  /** Filing due date for the recommended form (non-audit). */
  dueDate: string;
  belatedDeadline: string;
  lateFee: { default: number; incomeUpTo5L: number };
  notes: string[];
  disclaimers: string[];
}

const DISCLAIMERS = [
  "Not tax advice. Form applicability per incometax.gov.in; verify in the portal before filing.",
  "Assumes an individual taxpayer (not HUF/firm/company).",
];

/** Rupees in lakh, for reason strings built off rule-pack figures. */
function lakh(n: number): string {
  return `Rs ${(n / 100000).toLocaleString("en-IN")} lakh`;
}

/**
 * Recommend the ITR form (ITR-1/2/3/4) for an individual, with
 * loss-continuity awareness: brought-forward business/speculative losses
 * force ITR-3 even with zero current-year business income, because only
 * ITR-3 carries the Schedule BP/CFL needed to keep the carry-forward alive.
 * Eligibility rules: incometax.gov.in > Which ITR form is applicable (AY 2026-27).
 */
export function recommendItrForm(
  input: ItrFormInput,
  pack: RulePack,
): ItrFormResult {
  const ruledOut: FormRuleHit[] = [];
  const reasons: string[] = [];
  const notes: string[] = [];

  const businessContinuity = input.losses.business || input.losses.speculative;
  // `presumptive` counts as a business side even without hasBusinessIncome:
  // 44AD/44ADA income IS business income, and without this a presumptive filer
  // who forgot to also tick hasBusinessIncome would be routed to ITR-1.
  const hasBusinessSide =
    input.hasBusinessIncome ||
    input.presumptive ||
    input.isPartnerInFirm ||
    businessContinuity;

  const caps = pack.itrEligibility;

  // Shared ITR-1 AND ITR-4 disqualifiers (the "simple form" gates).
  const simpleFormBlocks: string[] = [];
  if (input.residency !== "resident")
    simpleFormBlocks.push(
      "only ordinarily-resident individuals may file ITR-1/ITR-4 (NRI/RNOR excluded)",
    );
  if (input.totalIncome > caps.simpleFormIncomeCap)
    simpleFormBlocks.push(
      `total income exceeds ${lakh(caps.simpleFormIncomeCap)}`,
    );
  if (input.stcg111A > 0)
    simpleFormBlocks.push(
      "STCG under 111A cannot be reported in ITR-1/ITR-4 (only LTCG 112A up to Rs 1.25L is allowed)",
    );
  if (input.ltcg112A > caps.ltcg112ASimpleFormCap)
    simpleFormBlocks.push(
      `LTCG under 112A exceeds the Rs ${caps.ltcg112ASimpleFormCap.toLocaleString("en-IN")} ITR-1/ITR-4 ceiling`,
    );
  if (input.hasOtherCapitalGains)
    simpleFormBlocks.push(
      "capital gains outside 111A/112A (property, debt MF, unlisted, foreign) need Schedule CG",
    );
  if (input.houseProperties > 1)
    simpleFormBlocks.push("more than one house property");
  if (input.losses.capital || input.losses.houseProperty)
    simpleFormBlocks.push(
      "loss carry-forward needs Schedule CFL/BFLA (not present in ITR-1/ITR-4)",
    );
  if (input.hasForeignAssetsOrIncome)
    simpleFormBlocks.push(
      "foreign assets/income require Schedule FA (vested foreign RSUs/ESPP count)",
    );
  if (input.isDirector) simpleFormBlocks.push("director in a company");
  if (input.holdsUnlistedShares)
    simpleFormBlocks.push("held unlisted equity shares during the year");
  if (input.agriIncome > caps.agriIncomeCap)
    simpleFormBlocks.push(
      `agricultural income exceeds Rs ${caps.agriIncomeCap.toLocaleString("en-IN")}`,
    );
  if (input.esopDeferral)
    simpleFormBlocks.push("tax deferred on startup ESOPs (s80-IAC)");
  if (input.hasLotteryOrGamingIncome)
    simpleFormBlocks.push(
      "lottery/online-gaming/racehorse winnings are outside ITR-1",
    );

  let recommended: ItrForm;

  if (hasBusinessSide) {
    for (const rule of simpleFormBlocks) {
      ruledOut.push({ form: "ITR-4", rule });
    }
    ruledOut.push({
      form: "ITR-1",
      rule: "any business/professional income (or its loss continuity) is outside ITR-1",
    });
    ruledOut.push({
      form: "ITR-2",
      rule: "ITR-2 has no Schedule BP: business/professional income or business-loss carry-forward cannot be reported",
    });

    const presumptiveOk =
      input.presumptive &&
      !input.isPartnerInFirm &&
      !businessContinuity &&
      simpleFormBlocks.length === 0;

    if (presumptiveOk) {
      recommended = "ITR-4";
      reasons.push(
        `presumptive scheme (44AD/44ADA/44AE) with income up to ${lakh(caps.simpleFormIncomeCap)} and no ITR-4 disqualifier`,
      );
    } else {
      recommended = "ITR-3";
      if (input.hasBusinessIncome)
        reasons.push("business/professional income needs Schedule BP (ITR-3)");
      if (input.isPartnerInFirm)
        reasons.push("partner in a firm must file ITR-3");
      if (businessContinuity && !input.hasBusinessIncome)
        reasons.push(
          "brought-forward business/speculative loss forces ITR-3 even with zero current-year business income: only ITR-3's Schedule CFL keeps the carry-forward alive",
        );
      if (input.presumptive && businessContinuity)
        reasons.push(
          "presumptive ITR-4 would abandon the business-loss carry-forward; ITR-3 preserves it",
        );
      if (businessContinuity && !input.hasBusinessIncome) {
        notes.push(
          "Nil-business ITR-3 mechanics: tick 'No Account Case' in the Balance Sheet with zeros, file nil Trading & P&L, and a zero Schedule BP. These schedules are mandatory even with no business activity.",
        );
      }
    }
  } else if (simpleFormBlocks.length > 0) {
    recommended = "ITR-2";
    for (const rule of simpleFormBlocks) {
      ruledOut.push({ form: "ITR-1", rule });
    }
    reasons.push(
      "no business income, but ITR-1 conditions are not met; ITR-2 covers salary + capital gains + foreign assets + multiple properties with no income ceiling",
    );
  } else {
    recommended = "ITR-1";
    reasons.push(
      `resident individual, income up to ${lakh(caps.simpleFormIncomeCap)} from salary/one house property/other sources, LTCG 112A within Rs ${caps.ltcg112ASimpleFormCap.toLocaleString("en-IN")}, no disqualifier`,
    );
  }

  if (
    input.ltcg112A > 0 &&
    input.ltcg112A <= caps.ltcg112ASimpleFormCap &&
    (recommended === "ITR-1" || recommended === "ITR-4")
  ) {
    notes.push(
      "LTCG under 112A up to Rs 1.25L is reportable in ITR-1/ITR-4 since AY 2025-26 (earlier it forced ITR-2).",
    );
  }

  const nonAuditDue =
    (recommended === "ITR-1" || recommended === "ITR-2"
      ? pack.deadlines.itr1_2
      : pack.deadlines.itr3_4_nonAudit) ?? "";

  // s.80: only a return furnished within the s.139(1) due date carries THIS
  // year's losses forward. The form recommendation is unaffected -- Schedule
  // CFL/BFLA is still what sets off losses already determined in an earlier
  // year -- but without this note the ITR-3 reason string ("keeps the
  // carry-forward alive") reads as unconditional, and filing_checklist's own
  // "belated returns lose most loss carry-forwards" note then contradicts it.
  // houseProperty is deliberately NOT in this set: s.71B carries a
  // house-property loss forward from a belated return too, so a filer whose
  // only loss is house property has nothing at stake here and must not be
  // handed a deadline warning about losses they do not have.
  const anyForfeitableLoss =
    input.losses.business || input.losses.speculative || input.losses.capital;
  if (anyForfeitableLoss) {
    notes.push(
      "Loss carry-forward is date-sensitive (s.80): only a return furnished by the s.139(1) due date carries THIS year's business, speculative and capital losses forward. A belated return under s.139(4) still sets off brought-forward losses already determined in an earlier year, and still carries a house-property loss forward (s.71B), but the current year's other losses are forfeited. Confirm the due date that applies to you on the portal before relying on the reported one.",
    );
  }

  // `dueDate` is always a non-audit date: this function takes no audit/44AB
  // input, so it cannot select `deadlines.audit`. Say so on every response,
  // exactly as filingChecklist does, rather than only when a loss note fires.
  notes.push(
    "Deadlines are the non-audit dates from the rule pack; audit cases differ.",
  );

  return {
    fy: pack.fy,
    ay: pack.ay,
    recommended,
    reasons,
    ruledOut,
    dueDate: nonAuditDue,
    belatedDeadline: pack.deadlines.belated ?? "",
    lateFee: pack.lateFee234F,
    notes,
    disclaimers: DISCLAIMERS,
  };
}

export interface FilingStep {
  step: number;
  phase: "gather" | "reconcile" | "compute" | "portal" | "verify";
  action: string;
  detail: string;
}

export interface FilingChecklist {
  fy: string;
  ay: string;
  form: ItrForm;
  dueDate: string;
  belatedDeadline: string;
  lateFee: { default: number; incomeUpTo5L: number };
  steps: FilingStep[];
  notes: string[];
  disclaimers: string[];
}

/** Ordered, form-specific walkthrough from documents to e-verification.
 * Guidance only: the final submit happens by the taxpayer on the portal. */
export function filingChecklist(
  form: ItrForm,
  pack: RulePack,
): FilingChecklist {
  const steps: FilingStep[] = [];
  let n = 0;
  const add = (phase: FilingStep["phase"], action: string, detail: string) => {
    n += 1;
    steps.push({ step: n, phase, action, detail });
  };

  add(
    "gather",
    "Collect Form 16",
    "From every employer of the FY. Part A (TDS) and Part B (salary breakup, exemptions).",
  );
  add(
    "gather",
    "Download AIS and Form 26AS",
    "Portal > e-File > Income Tax Returns > View AIS; and TRACES for 26AS Text export. Parse locally with parse_ais / parse_form26as.",
  );
  add(
    "gather",
    "Collect interest certificates",
    "Savings/FD interest from every bank; report GROSS accrued interest, then claim 80TTA/80TTB separately.",
  );
  if (form === "ITR-2" || form === "ITR-3") {
    add(
      "gather",
      "Export broker capital-gains statements",
      "Stocks/MF capital-gains reports for Schedule CG (and Schedule FA inputs for foreign RSUs/ESPP with Rule 115 TT rates).",
    );
  }
  if (form === "ITR-3") {
    add(
      "gather",
      "Assemble business/F&O P&L",
      "Turnover, expenses, and broker F&O statements for Schedule BP; carried-forward loss details by AY for Schedule CFL.",
    );
  }
  if (form === "ITR-4") {
    add(
      "gather",
      "Compute presumptive income",
      "44AD: 6%/8% of turnover; 44ADA: 50% of gross receipts. Keep turnover proof; no books needed below the thresholds.",
    );
  }
  add(
    "reconcile",
    "Reconcile documents before filing",
    "Run reconcile_documents (Form 16 vs AIS vs 26AS). Fix mismatches now: TDS over-claims and undeclared AIS interest are the top 143(1)(a) triggers.",
  );
  add(
    "compute",
    "Compute tax and pick the regime",
    "Run compare_regimes with your real numbers. Pay any self-assessment tax due via e-Pay Tax (challan minor head 300) before submitting.",
  );
  add(
    "portal",
    "Start the return on the portal",
    `Log in at incometax.gov.in > e-File > Income Tax Returns > File Income Tax Return > AY ${pack.ay} > Online > ${form}.`,
  );
  add(
    "portal",
    "Verify pre-filled data schedule by schedule",
    "Check salary against Form 16 Part B, TDS against 26AS, interest against AIS. Correct, never assume, the pre-fill.",
  );
  if (form !== "ITR-1") {
    add(
      "portal",
      "Fill the extra schedules",
      form === "ITR-2"
        ? "Schedule CG (gains), Schedule FA (foreign assets, calendar-year basis), Schedule CFL (capital losses), Schedule AL if income > Rs 50L."
        : form === "ITR-3"
          ? "Schedule BP (business), Trading/P&L/Balance Sheet (No Account Case zeros if nil business), Schedule CFL (loss continuity), Schedule CG/FA as applicable."
          : "Schedule BP presumptive rows (44AD/44ADA gross turnover and deemed profit).",
    );
  }
  add(
    "portal",
    "Match the portal's computed tax to your local numbers",
    "The portal total must equal compute_tax output within rounding. Investigate any gap before submitting; do not accept silently.",
  );
  add(
    "portal",
    "Submit the return yourself",
    "Review the summary and press submit. No tool can or should do this for you; only you (or your authorized ERI/CA) may file.",
  );
  add(
    "verify",
    "E-verify within 30 days",
    "Aadhaar OTP is fastest (also net banking / bank EVC). An unverified return is treated as never filed.",
  );

  return {
    fy: pack.fy,
    ay: pack.ay,
    form,
    dueDate:
      (form === "ITR-1" || form === "ITR-2"
        ? pack.deadlines.itr1_2
        : pack.deadlines.itr3_4_nonAudit) ?? "",
    belatedDeadline: pack.deadlines.belated ?? "",
    lateFee: pack.lateFee234F,
    steps,
    notes: [
      "Belated returns lose most loss carry-forwards (house-property loss survives).",
      "Deadlines are the non-audit dates from the rule pack; audit cases differ.",
    ],
    disclaimers: DISCLAIMERS,
  };
}
