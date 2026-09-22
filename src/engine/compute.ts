import type { Rebate87A, RulePack, Slab } from "./rulepack.js";

export type Regime = "new" | "old";
export type AgeBand = "below60" | "senior" | "superSenior";

export interface TaxInput {
  regime: Regime;
  /** Gross salary income before standard deduction. */
  salaryIncome: number;
  /** Other normal-rate income: interest, rent (net of 30%), etc. */
  otherIncome: number;
  /** STCG taxable under 111A (listed equity, STT paid). */
  stcg111A: number;
  /** LTCG taxable under 112A BEFORE the 1.25L exemption. */
  ltcg112A: number;
  /** Old regime only: total Chapter VI-A deductions actually claimable
   * (already capped by the caller or via the deduction checklist tool).
   * Do NOT include employer NPS here; it has its own field below. */
  deductions: number;
  /** Employer's NPS contribution under s.80CCD(2): the one Chapter VI-A
   * deduction that survives s.115BAC(2), so it reduces income in BOTH regimes.
   * Capped at the rule pack's percentage of salary (14% new regime; 10%
   * private / 14% government old regime, `governmentEmployer` decides). */
  employerNps80CCD2?: number;
  governmentEmployer?: boolean;
  /** Loss under the head house property (s.24(b) interest on a self-occupied
   * home, or a let-out property's net loss) as a POSITIVE number. Set off
   * against other heads up to the s.71(3A) cap; the excess is carried forward
   * under s.71B and is reported, not set off. */
  housePropertyLoss?: number;
  ageBand: AgeBand;
}

export interface TaxBreakdown {
  fy: string;
  regime: Regime;
  rulePackVersion: string;
  grossIncome: number;
  standardDeduction: number;
  deductionsClaimed: number;
  /** s.80CCD(2) actually allowed after the salary-percentage cap. */
  employerNps80CCD2Allowed: number;
  /** House-property loss set off this year (s.71(3A) cap applied). */
  housePropertyLossSetOff: number;
  /** House-property loss above the cap, carried forward under s.71B. */
  housePropertyLossCarriedForward: number;
  taxableNormalIncome: number;
  /** s.288A: total income (all heads) rounded to the nearest ten. */
  totalIncome: number;
  taxableStcg111A: number;
  taxableLtcg112A: number;
  /** Unexhausted basic exemption set off against 111A/112A gains (provisos). */
  basicExemptionSetOff: number;
  slabTax: number;
  rebate87A: number;
  stcgTax: number;
  ltcgTax: number;
  taxBeforeSurcharge: number;
  surcharge: number;
  surchargeRatePct: number;
  cess: number;
  totalTax: number;
  effectiveRatePct: number;
  disclaimers: string[];
}

const DISCLAIMERS = [
  "Not tax advice. Verify against the official income tax utility before filing.",
  "Assumes resident individual. NRI/RNOR rules differ.",
];

/** Added only when special-rate gains are present under the new regime: the
 * s.87A threshold reading changed in pack 1.4.0 and the taxpayer should know
 * which one they are being computed under. */
const DISCLAIMER_87A_TOTAL_INCOME =
  "s.87A (new regime): the Rs 12 lakh threshold is tested on TOTAL income including 111A/112A gains, per the statute's first proviso; the rebate itself never offsets 111A/112A tax (second proviso). Some practitioners read the threshold as slab-rate income only. If your gains push total income past 12 lakh, the portal's figure is the one that counts.";

function round(n: number): number {
  return Math.round(n);
}

/** Round to the nearest multiple of `to`, halves going up. s.288A rounds total
 * income, s.288B rounds the tax payable or refundable. */
export function roundToNearest(n: number, to: number): number {
  if (to <= 0) return Math.round(n);
  return Math.round(n / to) * to;
}

export function slabTax(income: number, slabs: Slab[]): number {
  let tax = 0;
  let prev = 0;
  for (const slab of slabs) {
    const upper = slab.upTo ?? Number.POSITIVE_INFINITY;
    if (income <= prev) break;
    const taxable = Math.min(income, upper) - prev;
    tax += taxable * slab.rate;
    prev = upper;
  }
  return tax;
}

/** Slabs actually applicable to the taxpayer. Only the OLD regime varies with
 * age: the higher basic exemption for seniors widens the nil band, it is NOT a
 * deduction from income (115BAC has one slab set for every age). */
export function slabsFor(
  regime: Regime,
  ageBand: AgeBand,
  pack: RulePack,
): Slab[] {
  if (regime === "new") return pack.newRegime.slabs;
  if (ageBand === "senior") return pack.oldRegime.slabsSenior;
  if (ageBand === "superSenior") return pack.oldRegime.slabsSuperSenior;
  return pack.oldRegime.slabs;
}

/** The nil band of the applicable slabs, i.e. the basic exemption limit. */
function basicExemptionLimit(slabs: Slab[]): number {
  const first = slabs[0];
  if (first?.rate !== 0) return 0;
  return first.upTo ?? 0;
}

function applyRebate87A(
  normalIncome: number,
  totalIncome: number,
  normalSlabTax: number,
  stcgTax: number,
  ltcgTax: number,
  rebate: Rebate87A,
): number {
  // Old regime: the 5L threshold tests TOTAL income (incl. capital gains).
  // New regime: the statute's first proviso says "total income" in both
  // clause (a) and clause (b), so the 12L threshold tests total income too.
  // `normalIncome` survives as an explicit contrary reading a pack may pick.
  const testIncome =
    rebate.thresholdBasis === "normalIncome" ? normalIncome : totalIncome;

  // The rebate can only ever be applied against these heads (old regime:
  // slab tax + 111A; new regime: slab tax only, per the second proviso).
  const rebatableTax =
    normalSlabTax +
    (rebate.allowAgainst111A ? stcgTax : 0) +
    (rebate.allowAgainst112A ? ltcgTax : 0);

  if (testIncome > rebate.incomeThreshold) {
    if (!rebate.marginalRelief) return 0;
    // Clause (b): rebate = income-tax payable on TOTAL income minus the amount
    // by which total income exceeds the threshold. "Income-tax payable" here is
    // the whole pre-rebate figure, gains tax included, which is what makes the
    // relief vanish faster when gains are present. The second proviso then
    // caps the result at the slab-rate tax (`rebatableTax`).
    const excess = testIncome - rebate.incomeThreshold;
    const taxOnTotal = normalSlabTax + stcgTax + ltcgTax;
    if (taxOnTotal > excess) return Math.min(taxOnTotal - excess, rebatableTax);
    return 0;
  }
  return Math.min(rebatableTax, rebate.maxRebate);
}

/** Income by character. Amounts are the figures that enter TOTAL income, so
 * `ltcg112A` is gross (the 1.25L threshold reduces the tax base, not income). */
interface IncomeMix {
  normal: number;
  stcg111A: number;
  ltcg112A: number;
}

interface PreSurchargeTax {
  taxableStcg111A: number;
  taxableLtcg112A: number;
  basicExemptionSetOff: number;
  slabTax: number;
  rebate87A: number;
  taxOnNormal: number;
  stcgTax: number;
  ltcgTax: number;
  taxBeforeSurcharge: number;
}

/** Everything up to (not including) surcharge, for a given income mix. Called
 * twice: once for the real income and once for the notional income at a
 * surcharge threshold, so marginal relief compares like with like. */
function preSurchargeTax(
  mix: IncomeMix,
  pack: RulePack,
  regime: Regime,
  ageBand: AgeBand,
): PreSurchargeTax {
  const slabs = slabsFor(regime, ageBand, pack);
  const normalSlabTax = slabTax(mix.normal, slabs);

  // s.111A proviso / s.112A(2) proviso: where normal income falls short of the
  // basic exemption, the unexhausted part is set off against the listed-equity
  // gains. Applied to 111A (20%) before 112A (12.5%): the statute lets the
  // assessee choose and the higher-taxed head is always the better choice.
  const setOff = pack.capitalGains.basicExemptionSetOff;
  let unexhausted = Math.max(0, basicExemptionLimit(slabs) - mix.normal);
  const exemptionBudget = unexhausted;

  let taxableStcg = mix.stcg111A;
  if (setOff.against111A) {
    const used = Math.min(unexhausted, taxableStcg);
    taxableStcg -= used;
    unexhausted -= used;
  }

  // The 1.25L threshold applies before any basic-exemption set-off.
  let taxableLtcg = Math.max(
    0,
    mix.ltcg112A - pack.capitalGains.ltcg112AExemption,
  );
  if (setOff.against112A) {
    const used = Math.min(unexhausted, taxableLtcg);
    taxableLtcg -= used;
    unexhausted -= used;
  }

  const grossStcgTax = taxableStcg * pack.capitalGains.stcg111A;
  const ltcgTaxBeforeRebate = taxableLtcg * pack.capitalGains.ltcg112A;

  const rebateRules =
    regime === "new" ? pack.newRegime.rebate87A : pack.oldRegime.rebate87A;
  const totalIncome = mix.normal + mix.stcg111A + mix.ltcg112A;
  const rebate = applyRebate87A(
    mix.normal,
    totalIncome,
    normalSlabTax,
    grossStcgTax,
    ltcgTaxBeforeRebate,
    rebateRules,
  );

  // Rebate consumes slab tax first, then (where allowed) 111A, then 112A.
  const rebateOnNormal = Math.min(rebate, normalSlabTax);
  const rebateOnStcg = rebateRules.allowAgainst111A
    ? Math.min(rebate - rebateOnNormal, grossStcgTax)
    : 0;
  const rebateOnLtcg = rebateRules.allowAgainst112A
    ? Math.min(rebate - rebateOnNormal - rebateOnStcg, ltcgTaxBeforeRebate)
    : 0;

  const taxOnNormal = Math.max(0, normalSlabTax - rebateOnNormal);
  const stcgTax = Math.max(0, grossStcgTax - rebateOnStcg);
  const ltcgTax = Math.max(0, ltcgTaxBeforeRebate - rebateOnLtcg);

  return {
    taxableStcg111A: taxableStcg,
    taxableLtcg112A: taxableLtcg,
    basicExemptionSetOff: exemptionBudget - unexhausted,
    slabTax: normalSlabTax,
    rebate87A: rebate,
    taxOnNormal,
    stcgTax,
    ltcgTax,
    taxBeforeSurcharge: taxOnNormal + stcgTax + ltcgTax,
  };
}

interface SurchargeBand {
  rate: number;
  threshold: number;
  /** The band was tested on income EXCLUDING the 111A/112A gains this engine
   * models. Dividend, which the statute also excludes, has no input here. */
  excludesSpecialRateIncome: boolean;
}

/** First Schedule Part I Paragraph A: the 25% and 37% bands look only at income
 * OTHER than 111A/112/112A/dividend income. A taxpayer past Rs 2 crore purely
 * on such income therefore stays in the 15% band, which is exactly what picking
 * the highest QUALIFYING band yields (the residual 15% clause).
 *
 * Scope limit: `IncomeMix` has no dividend head. Dividend reaches the engine as
 * `otherIncome`, so it is tested in the enhanced bands and surcharged at the
 * full band rate rather than being excluded and capped at 15% the way the
 * statute provides. Only 111A/112A are excluded and capped here. Modelling
 * dividend needs its own input, not a change to this function. */
function pickSurchargeBand(
  mix: IncomeMix,
  pack: RulePack,
  regime: Regime,
): SurchargeBand | undefined {
  const specialRateIncome = mix.stcg111A + mix.ltcg112A;
  const totalIncome = mix.normal + specialRateIncome;
  let picked: SurchargeBand | undefined;

  for (const band of pack.surcharge.slabs) {
    const enhanced =
      pack.surcharge.enhancedBandsExcludeSpecialRateIncome &&
      band.rate >= pack.surcharge.enhancedBandRateFloor;
    const tested = enhanced ? totalIncome - specialRateIncome : totalIncome;
    if (tested > band.above) {
      picked = {
        rate: band.rate,
        threshold: band.above,
        excludesSpecialRateIncome: enhanced,
      };
    }
  }

  if (!picked) return undefined;
  // 115BAC caps the surcharge at 25%: the 37% band never applies in the new
  // regime, but the threshold it was crossed at still drives marginal relief.
  if (regime === "new") {
    return {
      ...picked,
      rate: Math.min(picked.rate, pack.newRegime.surchargeCapRate),
    };
  }
  return picked;
}

/** Roll income back to a surcharge threshold. The marginal rupees come out of
 * normal-rate income first, then LTCG, then STCG: the statute prescribes no
 * order, and leaving the higher-taxed heads intact is the reading that does not
 * over-relieve. */
function reduceMix(mix: IncomeMix, by: number): IncomeMix {
  let left = by;
  const normal = Math.max(0, mix.normal - left);
  left -= mix.normal - normal;
  const ltcg112A = Math.max(0, mix.ltcg112A - left);
  left -= mix.ltcg112A - ltcg112A;
  const stcg111A = Math.max(0, mix.stcg111A - left);
  return { normal, stcg111A, ltcg112A };
}

function surchargeOn(
  band: SurchargeBand,
  taxOnNormal: number,
  taxOnSpecialRate: number,
  pack: RulePack,
): number {
  // 111A/112A gains carry a 15% surcharge cap (the statute caps dividend too,
  // but there is no dividend input -- see pickSurchargeBand).
  const gainsRate = Math.min(
    band.rate,
    pack.surcharge.capitalGainsAndDividendCap,
  );
  return taxOnNormal * band.rate + taxOnSpecialRate * gainsRate;
}

interface SurchargeResult {
  amount: number;
  ratePct: number;
}

function computeSurcharge(
  mix: IncomeMix,
  tax: PreSurchargeTax,
  pack: RulePack,
  regime: Regime,
  ageBand: AgeBand,
): SurchargeResult {
  const band = pickSurchargeBand(mix, pack, regime);
  if (!band || band.rate === 0) return { amount: 0, ratePct: 0 };

  const taxOnSpecialRate = tax.stcgTax + tax.ltcgTax;
  const gross = surchargeOn(band, tax.taxOnNormal, taxOnSpecialRate, pack);
  const ratePct = round(band.rate * 10000) / 100;
  if (!pack.surcharge.marginalRelief) return { amount: gross, ratePct };

  // Marginal relief: tax + surcharge on the actual income may not exceed
  // tax + surcharge at the threshold PLUS the income above that threshold.
  const totalIncome = mix.normal + mix.stcg111A + mix.ltcg112A;
  const tested = band.excludesSpecialRateIncome ? mix.normal : totalIncome;
  const excess = tested - band.threshold;
  if (excess <= 0) return { amount: gross, ratePct };

  const notionalMix = reduceMix(mix, excess);
  const notionalTax = preSurchargeTax(notionalMix, pack, regime, ageBand);
  const notionalBand = pickSurchargeBand(notionalMix, pack, regime);
  const notionalSurcharge = notionalBand
    ? surchargeOn(
        notionalBand,
        notionalTax.taxOnNormal,
        notionalTax.stcgTax + notionalTax.ltcgTax,
        pack,
      )
    : 0;
  const extraIncome =
    totalIncome -
    (notionalMix.normal + notionalMix.stcg111A + notionalMix.ltcg112A);

  const ceiling =
    notionalTax.taxBeforeSurcharge +
    notionalSurcharge +
    extraIncome -
    tax.taxBeforeSurcharge;

  return {
    amount: Math.max(0, Math.min(gross, ceiling)),
    ratePct,
  };
}

/** Deterministic FY tax computation. Pure function over the rule pack --
 * the LLM never does arithmetic. */
export function computeTax(input: TaxInput, pack: RulePack): TaxBreakdown {
  const regimeRules = input.regime === "new" ? pack.newRegime : pack.oldRegime;

  const standardDeduction =
    input.salaryIncome > 0
      ? Math.min(regimeRules.standardDeduction, input.salaryIncome)
      : 0;

  const deductionsClaimed = input.regime === "old" ? input.deductions : 0;

  // s.80CCD(2) survives 115BAC(2). Cap at the pack's percentage of salary
  // (salary here = the gross salary figure; the statute says basic + DA, which
  // this engine does not split, so the cap is a ceiling not a floor).
  const npsPct =
    input.regime === "new"
      ? pack.newRegime.employerNps80CCD2.pctOfSalary
      : input.governmentEmployer
        ? pack.oldRegime.employerNps80CCD2.pctOfSalaryGovernment
        : pack.oldRegime.employerNps80CCD2.pctOfSalaryPrivate;
  const employerNps80CCD2Allowed = Math.min(
    Math.max(0, input.employerNps80CCD2 ?? 0),
    input.salaryIncome * npsPct,
  );

  // s.71(3A): house-property loss set off against other heads only up to the
  // cap; s.71B carries the rest forward for eight years against HP income.
  // s.115BAC(2)(ii)(b) bars the inter-head set-off outright under the new
  // regime, so there the whole loss is carried forward and nothing is set off.
  const hpLoss = Math.max(0, input.housePropertyLoss ?? 0);
  const hpCap =
    input.regime === "old"
      ? (pack.oldRegime.deductionCaps.housePropertyLossSetOff ?? 0)
      : 0;
  const housePropertyLossSetOff = Math.min(hpLoss, hpCap);
  const housePropertyLossCarriedForward = hpLoss - housePropertyLossSetOff;

  const normalBeforeRounding = Math.max(
    0,
    input.salaryIncome -
      standardDeduction +
      input.otherIncome -
      housePropertyLossSetOff -
      employerNps80CCD2Allowed -
      deductionsClaimed,
  );

  // s.288A rounds TOTAL income (all heads) to the nearest ten. The gains come
  // in as whole rupees from the caller's broker statement, so the rounding is
  // absorbed by the normal head: round the total, then back the gains out.
  const gains = input.stcg111A + input.ltcg112A;
  const totalIncome = roundToNearest(
    normalBeforeRounding + gains,
    pack.rounding.income288A,
  );
  const taxableNormalIncome = Math.max(0, totalIncome - gains);

  const mix: IncomeMix = {
    normal: taxableNormalIncome,
    stcg111A: input.stcg111A,
    ltcg112A: input.ltcg112A,
  };

  const tax = preSurchargeTax(mix, pack, input.regime, input.ageBand);
  const surcharge = computeSurcharge(
    mix,
    tax,
    pack,
    input.regime,
    input.ageBand,
  );

  const cess = (tax.taxBeforeSurcharge + surcharge.amount) * pack.cess;
  // s.288B: the amount payable is rounded to the nearest multiple of ten.
  const totalTax = roundToNearest(
    tax.taxBeforeSurcharge + surcharge.amount + cess,
    pack.rounding.taxPayable288B,
  );
  const grossIncome =
    input.salaryIncome + input.otherIncome + input.stcg111A + input.ltcg112A;

  const disclaimers =
    input.regime === "new" && gains > 0
      ? [...DISCLAIMERS, DISCLAIMER_87A_TOTAL_INCOME]
      : DISCLAIMERS;

  return {
    fy: pack.fy,
    regime: input.regime,
    rulePackVersion: pack.rulePackVersion,
    grossIncome,
    standardDeduction,
    deductionsClaimed,
    employerNps80CCD2Allowed: round(employerNps80CCD2Allowed),
    housePropertyLossSetOff: round(housePropertyLossSetOff),
    housePropertyLossCarriedForward: round(housePropertyLossCarriedForward),
    taxableNormalIncome,
    totalIncome,
    taxableStcg111A: tax.taxableStcg111A,
    taxableLtcg112A: tax.taxableLtcg112A,
    basicExemptionSetOff: round(tax.basicExemptionSetOff),
    slabTax: round(tax.slabTax),
    rebate87A: round(tax.rebate87A),
    stcgTax: round(tax.stcgTax),
    ltcgTax: round(tax.ltcgTax),
    taxBeforeSurcharge: round(tax.taxBeforeSurcharge),
    surcharge: round(surcharge.amount),
    surchargeRatePct: surcharge.ratePct,
    cess: round(cess),
    totalTax,
    effectiveRatePct:
      grossIncome > 0 ? Math.round((totalTax / grossIncome) * 10000) / 100 : 0,
    disclaimers,
  };
}
