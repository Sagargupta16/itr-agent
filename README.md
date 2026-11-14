# itr-agent

[![npm](https://img.shields.io/npm/v/itr-agent?label=npm)](https://www.npmjs.com/package/itr-agent)
[![CI](https://github.com/Sagargupta16/itr-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/Sagargupta16/itr-agent/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-stdio-blueviolet)](https://modelcontextprotocol.io)

Local-first ITR filing agent for Indian income tax. Claude interviews you one question at a time, picks your ITR form, computes your tax deterministically on your machine, reconciles your documents, and walks you to the portal's submit button -- no accounts, no uploads, no cloud.

Works with Claude Desktop, Claude Code, and any MCP client. Formerly published as [`itr-mcp`](https://www.npmjs.com/package/itr-mcp).

```
You:    Help me file my ITR.
Claude: [file_my_itr] One question at a time. First: were you a resident of India
        for all of FY 2025-26?
You:    Yes, salaried, and I have vested US RSUs from my employer.
Claude: [recommend_itr_form] Foreign assets (Schedule FA) rule out ITR-1: you file
        ITR-2, due 2026-07-31. Next: how many employers this year?
```

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/demo-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="docs/demo-light.svg">
  <img width="600" src="docs/demo-dark.svg" alt="Terminal animation of five tool calls against the built server. recommend_itr_form with foreign assets: ITR-2, due 2026-07-31, ITR-1 ruled out because foreign assets need Schedule FA. compare_regimes on 18L salary with 3.75L deductions: new Rs 1,50,800 vs old Rs 2,34,000, new saves Rs 83,200. compute_tax on 12.75L salary: Rs 0 after a Rs 60,000 rebate. The same salary plus 1.25L LTCG: Rs 62,400, because total income of Rs 13,25,000 loses the 87A rebate. schedule_advance_tax on 2.4L tax with 1.8L TDS: Jun Rs 9,000, Sep Rs 18,000, Dec Rs 18,000, Mar Rs 15,000.">
</picture>

Those are the calls Claude makes during the interview, sent to the built server by [`scripts/demo.mjs`](scripts/demo.mjs). Every figure in the animation is one that run printed.

## Why

Every Indian tax tool wants your data on their servers. itr-agent flips it: your documents stay local, the LLM never does arithmetic, and every number comes from a versioned rule pack you can audit. The agent layer drives the interview; the deterministic engine does the math.

**What it will never do:** submit the return for you. India has no public filing API -- returns are filed by you on [incometax.gov.in](https://www.incometax.gov.in) (or by an authorized ERI/CA). The agent takes you to that button with every number verified; you press it.

## The agent

`file_my_itr` (MCP prompt) runs the guided interview:

1. `list_tax_years` -> `status`: worked out from today's date in India, so the agent knows whether the return is on time or belated (and the s.234F fee) before anything else
2. Residency, age band -- one question at a time
3. Income heads: salary, house property (per house, passed as `houses`), capital gains, business/F&O (presumptive schemes via `compute_presumptive_income` and `presumptiveBusiness`), other sources
4. Disqualifier sweep: foreign RSUs/ESPP, director role, unlisted shares, ESOP deferral
5. Losses, current and brought-forward (they change the form): `compute_loss_setoff` applies them in statutory order and hands `forComputeTax` to the tax tools
6. `recommend_itr_form` -> the form, with rule-by-rule reasoning
7. `compare_regimes` -> the regime, with real numbers and the `breakeven` deductions that would flip it
8. `parse_ais` / `parse_form26as` / `reconcile_documents` -> fix mismatches BEFORE filing
9. `tax_summary` -> what you owe: tax less TDS/TCS from the 26AS file and your dated advance and self-assessment payments, with s.234A/B/C interest and the s.234F fee (`schedule_advance_tax` for the current year's instalments)
10. `filing_checklist` -> schedule-by-schedule portal walkthrough, ending at e-verification

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/diagrams/filing-flow-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="docs/diagrams/filing-flow-light.svg">
  <img width="880" src="docs/diagrams/filing-flow-light.svg" alt="The guided filing interview as a numbered flow. Step 1: you answer Claude one question at a time on residency, income and losses. Claude then calls the itr-agent tools in order: step 2 compute_loss_setoff returns the loss set-off and carry-forward, step 3 recommend_itr_form returns the form and deadline, step 4 compare_regimes returns the regime and savings, step 5 parse_form26as and parse_ais return your TDS rows, step 6 reconcile_documents returns the mismatches, step 7 tax_summary returns what you owe, step 8 filing_checklist returns the portal walkthrough. Step 9, drawn dashed because it happens outside the tool: you e-verify and press submit on incometax.gov.in.">
</picture>

## Tools (v0.7)

| Tool | What it does |
| --- | --- |
| `recommend_itr_form` | ITR-1/2/3/4 selection with rule-by-rule reasoning and loss-continuity awareness: brought-forward business losses force ITR-3 even with zero current-year business income (Schedule CFL). Knows the AY 2026-27 two-house-property allowance, the s.194N bar, the 44AD/44ADA turnover ceilings (when you pass the turnover) and the 44AE ten-vehicle limit (when you pass the count). Returns each deadline with its statutory citation |
| `filing_checklist` | Ordered, form-specific walkthrough: documents, reconciliation, computation, portal steps schedule by schedule, e-verification |
| `compute_tax` | Full computation for FY 2025-26 (AY 2026-27, the default) or tax year 2026-27 (`fy`), taking `houses` and `presumptiveBusiness` and adding those heads itself: new/old regime slabs (incl. the senior and super-senior slab sets), standard deduction, employer NPS under 80CCD(2) in both regimes, house-property loss by property type (self-occupied interest capped at Rs 2L under s.24(b) and not deductible under 115BAC; set-off capped at Rs 2L by s.71(3A); none under 115BAC), 87A rebate (new regime: Rs 60,000 where TOTAL income is up to Rs 12L with marginal relief, never offsetting 111A/112A tax; old regime: Rs 12,500 on total income up to Rs 5L, no marginal relief, offsets 111A), 111A (20%) / 112A (12.5% above 1.25L) capital gains with the unexhausted-basic-exemption set-off, surcharge with the 15% gains cap and its own marginal relief, 4% cess, s.288A/288B rounding |
| `compare_regimes` | Old vs new side by side, recommended regime, savings amount, and `breakeven`: the smallest old-regime deductions at which the old regime costs no more than the new one, and how much more that is than what you passed. Takes the same `houses` and `presumptiveBusiness` |
| `schedule_advance_tax` | Jun/Sep/Dec/Mar installment plan (15/45/75/100%) with shortfall tracking |
| `compute_interest_234` | Sections 234A/234B/234C interest with the statutory 12%/36% safe harbors, the s.234B(2) self-assessment payment ladder, and Rule 119A rounding (principal floored to Rs 100, part month = full month). Takes the filing date, the form and payment dates and counts the months itself; month counts are still accepted. Reports which sections it skipped and why |
| `compute_hra` | HRA exemption per Rule 2A, period-wise (least of three limbs) + the 80GG alternative, with its Rs 5,000-per-month cap and the bars under the new regime and alongside HRA. Takes each period's city and checks it against the year's metro list (FY 2025-26: Delhi, Mumbai, Kolkata, Chennai) |
| `compute_house_property` | Income from house property per house: annual value, 30% standard deduction (s.24(a)), interest with the self-occupied cap shared across houses (Rs 2L; Rs 30,000 for an older loan; nil under the new regime), pre-construction interest in five instalments, and houses past the two-house self-occupied limit treated as let out. `compute_tax` takes the same `houses` and does this itself; use this tool to show the working |
| `compute_presumptive_income` | s.44AD (8%, or 6% of digital receipts), s.44ADA (50%) and s.44AE (per goods carriage per month, up to 10 vehicles): eligibility against the turnover and cash-share ceilings, the deemed profit with its working, and the income to report (the higher of deemed and declared) |
| `compute_loss_setoff` | Current-year and brought-forward losses applied in statutory order (s.70 within a head, s.71 across heads with the Rs 2L house-property cap and no business loss against salary, then s.71B/72/73/74 oldest first): each step with its section, income by head after set-off, what carries forward and until which year, what expired, what s.80 forfeits on a late return, and Schedule CYLA/BFLA/CFL rows ([#4](https://github.com/Sagargupta16/itr-agent/issues/4)). Its `forComputeTax` goes into `compute_tax` or `tax_summary` unchanged |
| `tax_summary` | What you owe in one call: tax, less TDS and TCS read from the 26AS file (creditable rows only; it refuses a 26AS for another assessment year), advance and self-assessment tax by date, s.234A/B/C interest with every month counted from the dates, the s.234F fee, and a net rounded under s.288B (negative is a refund) |
| `list_deductions` | Old-regime deduction checklist with statutory caps (80C, 80CCD(1B), 80D tiers, HRA metros) |
| `parse_form26as` | Parse the caret-delimited Form 26AS Text export from TRACES into structured TDS entries with booking status (only F is creditable; the tool reports `creditableTdsDeposited` beside the raw total), and TCS rows separated into `tcsEntries` |
| `parse_ais` | Decrypt + parse the AIS JSON export on-device (AES-256-CBC/PBKDF2 with the password derived from PAN + DOB); normalized rows with label-matched amounts/dates/codes, plus `totals` summed in code: every section/element/code group, and salary per employer TAN from section 192 TDS rows |
| `reconcile_documents` | Form 16 vs AIS vs 26AS mismatch report -- the checks that pre-empt 143(1)(a) intimations and 139(9) defect notices (TDS over-claim against the creditable 26AS total, non-final booking status, missing employer, undeclared AIS interest/dividend). Reads the 26AS and AIS files itself (`form26asPath`, `aisFile` with the AIS groups you count as interest or dividend), so no row or total is copied through the model |
| `list_tax_years` | Supported fiscal years + AY 2026-27 filing deadlines with their statutory citations. `status` is worked out from today's date in India (pass `asOf` to plan ahead): the phase per ITR form group (on time, belated with the s.234F fee, or updated return only), days left, the revised-return window with the s.234-I fee, and the next advance tax instalment. `statutes` gives each year's Act and, for tax year 2026-27, the map from the 1961 section numbers the notes cite to the Income-tax Act 2025 |

That is 16 tools and the `file_my_itr` prompt. All tools are read-only (`readOnlyHint: true`), take zod-validated inputs, and return `structuredContent` alongside the human-readable text.

## Install

`npx -y itr-agent` installs the current release from npm. Releases are published by `publish.yml` through npm trusted publishing, each with a signed provenance attestation; the first was 0.6.0 on 2026-11-13. Before that npm served 0.3.0 from July 2026, so if `npx` ever gives you 0.3.0 from a cache, ask for `itr-agent@latest`.

### Claude Code

```bash
claude mcp add itr-agent -- npx -y itr-agent
```

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "itr-agent": {
      "command": "npx",
      "args": ["-y", "itr-agent"]
    }
  }
}
```

### Claude Desktop, one click

From the v0.5.3 release on, every [GitHub release](https://github.com/Sagargupta16/itr-agent/releases) carries `itr-agent-<version>.mcpb` and its `.sha256`. The bundle inlines the server and its dependencies into one file, so there is no npm or `npx` step: double-click it, or use Settings > Extensions > Install Extension in Claude Desktop. It needs Node 22 or later, like the npm package. `pnpm bundle` builds the same file locally into `build/`.

### From source

```bash
git clone https://github.com/Sagargupta16/itr-agent
cd itr-agent
pnpm install
pnpm build
node dist/index.js   # stdio server
```

### Migrating from itr-mcp

Same server, new name. Replace `itr-mcp` with `itr-agent` in your MCP config; the `itr-mcp` npm package is deprecated and frozen at v0.2.0.

## Example prompts

- "Help me file my ITR." (starts the guided interview)
- "I'm salaried with US RSUs and 2L of equity LTCG -- which ITR form am I supposed to file?"
- "My CTC is 18L with 50K NPS through my employer -- which regime should I pick for FY 2025-26?"
- "My estimated tax is 2.4L and TDS covers 1.8L. Plan my advance tax installments."
- "Parse `C:/tax/26AS.txt` and total the TDS my employer deposited."
- "Here is my 26AS and my advance tax challans. What do I owe, interest and fee included?" (`tax_summary`)
- "I have a 12L business loss from last year and 3L of STCG this year. What carries forward?" (`compute_loss_setoff`)
- "Is it too late to file for FY 2025-26, and what will it cost me?" (`list_tax_years` `status`)

## Filing after the due date

The s.139(1) due date for FY 2025-26 is in `deadlines` (`list_tax_years` prints them, with the statutory basis for each in `deadlineCitations`, and its `status` says from today's date which phase each form group is in). Once it has passed, the return is **belated under s.139(4)** and four things change. `file_my_itr` asks about timing before anything else, because two of them are cheaper to know up front.

The pack's `deadlines.itr1_2` is 2026-07-31 (s.139(1) Explanation 2(c)). `deadlines.itr3_4_nonAudit` is 2026-08-31: Finance Act 2026 moved non-audit assessees with business or professional income to 31 August from AY 2026-27, and CBDT granted no further extension (checked 2026-09-10). Audit cases are later again (`deadlines.audit`, 31 October), and no tool ever selects it because nothing here takes a 44AB input, so `recommend_itr_form` and `filing_checklist` both report the non-audit date and both say so in `notes`.

- **You can still file**, up to `deadlines.belated` (2026-12-31 for AY 2026-27) or before the assessment is completed, whichever is earlier.
- **s.234F fee**: Rs 5,000, or Rs 1,000 where total income does not exceed Rs 5 lakh. Both figures come from the rule pack (`lateFee234F`) and are returned by `recommend_itr_form` and `filing_checklist`.
- **s.234A interest**: 1% per month, or part of a month, on the tax still outstanding after TDS/TCS, advance tax and reliefs, running from the day after the due date to the date of filing. `tax_summary` charges it, with s.234B and s.234C, from the dates; `compute_interest_234` with `filingDate` and the `form` shows one section on its own. Both count the months themselves (part month = full month, Rule 119A).
- **s.80 forfeits this year's loss carry-forward.** Business, speculative and capital losses of the current year cannot be carried forward in a belated return. Set-off of losses already determined in an earlier year survives, and so does the house-property loss carry-forward (s.71B). `recommend_itr_form` says this in `notes` whenever a business, speculative or capital loss flag is set, so its ITR-3 recommendation is not read as an unconditional carry-forward. A house-property-only loss does not trigger it, because s.71B carries that one forward either way.

**Revising a filed return.** Finance Act 2026 substituted s.139(5): a revised return may now be filed any time before the end of the AY (`deadlines.revised`, 2027-03-31), no longer three months before it. A revision filed after `deadlines.revisedWithoutFee234I` (2026-12-31) attracts the new s.234-I fee: the pack's `fee234I` carries it (Rs 1,000 where total income is up to Rs 5 lakh, else Rs 5,000; Finance Act 2026 s.16, from 1 March 2026), and `list_tax_years` `status` quotes it once the date has passed.

Not modeled, deliberately: whether a belated business filer keeps the old-regime election (s.115BAC(6) / Form 10-IEA is due on or before the s.139(1) date). Ask a CA before relying on either answer.

## Validation

[`docs/validation.md`](docs/validation.md) runs 24 cases (66 figures) through the built server and puts each next to its source. Nine come from the Finance Minister's own table in the [Budget Speech 2025-26](https://www.indiabudget.gov.in/doc/bspeech/bs2025_26.pdf) (Annexure to Part-B, printed page 47): slab tax, rebate and tax after rebate from 8 to 50 lakh. The other fifteen are worked by hand from the statute, with the arithmetic in the table: the 87A marginal relief and its crossover, gains that cost the rebate, the old-regime age bands, the 10% surcharge with its own marginal relief, a self-occupied house, 44ADA and 44AE, and a tax year 2026-27 case under the Income-tax Act 2025. All 66 match, and the 58 figures from before 0.7.0 are among them. CI runs `pnpm validate` on every leg and fails if a figure stops matching or the committed table goes stale.

It is not a comparison with the e-Filing portal's own calculator, which refuses automated browsers. A case from a CA-prepared computation is the most useful pull request this repo can get.

## Scope and limitations

Honest boundaries, so you know before you rely on it. [`docs/v0.2-spec.md`](docs/v0.2-spec.md) carries the statutory citations behind each rule, the per-section implementation status, and the register of claims that were researched and refuted.

- **Resident individuals, FY 2025-26 (AY 2026-27, the default) and tax year 2026-27.** The 2026-27 pack takes the 2025-26 figures except the HRA metros, the due dates and the form names. The ITR-1/ITR-4 income cap, the Schedule AL threshold, the agricultural income cap, the HRA rent-receipt waiver, the reconcile tolerances and the 26AS section map are carried from 2025-26 until the tax year 2026-27 return forms are notified; the last entry in the pack's `sources` says so. Its notes cite 1961 Act section numbers, and the map to the Income-tax Act 2025 is in `list_tax_years`. NRI/RNOR computation differs (the form recommendation accounts for residency, the tax engine assumes resident).
- **No filing.** There is no public API to submit an ITR; only you or an authorized ERI can file. The agent prepares and verifies everything, then hands over.
- **You supply the income figures.** `compute_tax` computes tax on the heads you give it: salary, other income, 111A STCG, 112A LTCG, house property (per house as `houses`, which it works out itself, or as a single loss figure with `housePropertyType` saying whether the house is self-occupied or let out), presumptive business income (`presumptiveBusiness`: 44AD, 44ADA, 44AE), employer NPS under 80CCD(2), and old-regime deductions as a single total. It does not compute other capital-gains heads (112 debt/property, 115BBH crypto, slab-rate debt MF under 50AA) or a business P&L outside the presumptive schemes -- work those out separately, or with `list_deductions` for the Chapter VI-A caps, and pass the totals in.
- **s.87A under the new regime tests total income.** The statute's first proviso says "total income" and this engine follows it, so 12 lakh of salary plus any equity gains loses the Rs 60,000 rebate. Some practitioners read the threshold as slab-rate income only; `compute_tax` says which reading it applied whenever gains are present, and the rule pack can encode the other one (`thresholdBasis: "normalIncome"`).
- **Not yet modeled:** a business P&L outside the presumptive schemes, crypto/VDA (115BBH), non-equity capital gains, Schedule FA valuation ([#5](https://github.com/Sagargupta16/itr-agent/issues/5)), Form 16 PDF parsing (`reconcile_documents` takes Form 16 figures as input, it does not read the PDF), broker capital-gains statements ([#7](https://github.com/Sagargupta16/itr-agent/issues/7)).
- **Dividend is ordinary income for surcharge purposes.** There is no dividend input: it goes in `otherIncome`. The First Schedule keeps dividend out of the 25%/37% surcharge bands and caps its surcharge at 15%, and `compute_tax` does neither for dividend (it does both for 111A/112A gains). Only bites above Rs 2 crore of total income; below that every band rate is already at or under 15%.
- **Transaction-date rules not yet split.** The engine applies each year's rates uniformly; the 23-Jul-2024 capital-gains rate flip and the 1-Oct-2024 buyback change matter for FY 2024-25 returns, which this pack does not cover.
- **The encrypted AIS file is not a safe place to store your data.** Its password is your PAN plus your date of birth, stretched with only 1,000 PBKDF2-SHA256 iterations. Once someone knows your PAN, every plausible DOB can be tried in about 4 seconds single-threaded (measured on a laptop: 0.11 ms per key derivation over a ~36,600-date space). That is the portal's scheme, not this tool's choice, and nothing here can strengthen it -- treat a downloaded AIS export as effectively unencrypted and delete it when you are done.
- **`parse_ais` decryption is unproven on a live export.** The AIS password scheme is reverse-engineered from open-source utilities and verified against this repo's synthetic round-trip, never against a file the portal actually produced. If it fails, the error tells you to pass `password` explicitly or use the portal's CSV export, and [an issue report](https://github.com/Sagargupta16/itr-agent/issues) with your download date helps fix it. Every other tool is unaffected.
- **Not tax advice.** Complex cases belong with a CA. Every output says so.

## Architecture

One stdio process, three layers, no network. The prompt sequences the interview, the MCP layer (`@modelcontextprotocol/server` 2.4.0, with zod) validates every input, and pure functions over a versioned JSON rule pack produce every number. The runtime dependency tree is that server, its core package and zod.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/diagrams/architecture-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="docs/diagrams/architecture-light.svg">
  <img width="880" src="docs/diagrams/architecture-light.svg" alt="Architecture of itr-agent. Inside the boundary labelled Your machine: you chat with an MCP client (Claude Desktop or Claude Code), which speaks JSON-RPC over stdio to the itr-agent Node process. Inside that process the stdio transport (src/index.ts) hands requests to the MCP tool surface (16 tools and one prompt, zod-validated inputs), which calls three groups of pure engine functions in src/engine (the tax engine for slabs, 87A, surcharge and cess, with house property, presumptive income, loss set-off and the what-do-I-owe summary; the form picker for ITR-1 to ITR-4 and the checklist; interest, advance tax, HRA, reconcile and the filing status) and two read-only parsers in src/parsers (Form 26AS from the TRACES text export, and AIS with on-device AES decryption). The engine reads every constant from the rule pack for the year asked (data/fy2025-26.json by default, or data/fy2026-27.json), validated at load. The parsers read your 26AS and AIS exports from files on your disk through an extension allow-list. A dashed arrow from you to incometax.gov.in, drawn outside the tool, marks the one step itr-agent never does: you press submit, because no filing API exists.">
</picture>

The spec behind the picture is [`docs/diagrams/architecture.yaml`](docs/diagrams/architecture.yaml), rendered with [orrery](https://github.com/Sagargupta16/orrery); every node names the source file it stands for.

| Decision | Why |
| --- | --- |
| stdio only, no HTTP transport | The documents carry PAN, salary and TDS data. No port means nothing to expose; CONTRIBUTING declines network transports outright |
| Rule pack in JSON, not code | Tax law changes every Finance Act. A new FY is a new `data/fyYYYY-YY.json` plus golden tests; `validatePack()` refuses a pack missing any section the engine reads, so a missing rate fails loudly instead of falling back to a hardcoded one |
| The LLM never computes | A figure a model produced cannot be audited or reproduced. The model asks questions and calls tools; every rupee figure is a deterministic function output, returned with `disclaimers` and the fiscal year it applied |
| `structuredContent` beside text | Downstream tools (`reconcile_documents`) consume the parsed 26AS/AIS directly, while the text mirror masks PAN for the chat transcript |
| CI asserts computed figures | On Ubuntu and Windows across Node 22/24/26, the smoke test boots `dist/index.js`, sends JSON-RPC, and checks 12.75L salary = Rs 0 and 15L other income = Rs 1,09,200. A separate job installs the packed npm tarball and repeats the 1,09,200 check as a user would run it. `pnpm validate` replays all 66 validation figures on every leg, and a third job unpacks the `.mcpb` bundle where no `node_modules` can reach it and repeats the check again |

## Design principles

- **Local-only.** stdio transport, no network calls, no telemetry, no accounts. Your documents are read from disk by this process and never uploaded anywhere. AIS decryption happens entirely on-device with Node's crypto -- the reverse-engineered password scheme has un-peppered fallbacks and an explicit `password` override in case the format rotates.
- **What your MCP client still sees.** Parsed output is returned to whatever client you connected, so if that client is a hosted LLM, the parsed contents reach that provider like any other message. PAN is masked in the human-readable text mirror, but the `structuredContent` payload carries the full parsed document (PAN, TANs, deductor names, amounts) because downstream tools need it. Local-only describes this server, not your whole stack -- for maximum privacy, run it against a local model.
- **The LLM never does math.** Every rupee is computed by pure functions over `data/fy2025-26.json`, and so is every sum and month count a tool needs: reconcile reads the documents itself and the interest tool counts months from dates. 280 tests pin the engine to published worked examples and to statute: the 12L zero-tax case, the 12,10,000 marginal-relief case, the 12,70,588 relief exhaustion point on both sides, the 13,25,000 total-income case that loses the rebate, the surcharge bands with the First Schedule exclusion of capital-gains income, all three old-regime age bands, and the 234A/234B/234C/HRA/80GG golden cases, plus the house-property, presumptive, loss set-off and tax summary cases.
- **The agent drives, the engine decides.** The interview sequencing is a prompt; every number and every form rule is deterministic code. Nothing is estimated.
- **Year-parameterized.** Rules live in per-FY JSON packs. Tax year 2026-27 (Income-tax Act 2025 and Income-tax Rules 2026: Form 16 becomes Form No. 130 under Rule 215, the HRA metros become eight under Rule 279; Finance Act 2026: buyback reverts to capital gains) landed in 0.7.0 as `data/fy2026-27.json`, a new pack and not code changes. Rule 164(14) of the 2026 Rules keeps FY 2025-26 returns on that year's forms, so the default year is still 2025-26. A pack from before 1.6.0 no longer loads.
- **Not tax advice.** Every tool that computes a rupee figure returns a `disclaimers` array and the fiscal year it applied; `compute_tax`, `compute_hra` and `list_tax_years` also return the exact `rulePackVersion`. Verify against the official utility before filing.

## Roadmap

- [x] **v0.1** -- tax engine (both regimes + CG + surcharge + cess), regime comparison, advance tax, deduction checklist, 26AS text parser
- [x] **v0.2** -- `parse_ais` (encrypted AIS JSON, on-device decrypt), `reconcile_documents` (the #1-notice-trigger checks), 234B/234C interest with golden-case tests, HRA + 80GG calculators, old-regime 87A semantics fix
- [x] **v0.3** -- renamed to **itr-agent**; `recommend_itr_form` with loss-continuity awareness ([#3](https://github.com/Sagargupta16/itr-agent/issues/3)), `filing_checklist`, the `file_my_itr` guided interview prompt
- [x] **v0.4** -- engine correctness pass (senior/super-senior slab sets, surcharge marginal relief on tax + surcharge, the s.111A/112A basic-exemption set-off, s.288A/288B rounding), positional 26AS amount extraction, s.234A + the s.234B(2) payment ladder, reconcile M4/M5, belated-filing guidance, security pins on the SDK's transitives, an OIDC-with-provenance publish workflow (it first reached npm with 0.6.0 on 2026-11-13, once the npmjs.com trusted publisher was set up), and an MCP registry manifest ([`server.json`](server.json))
- [x] **v0.5** -- fact-check of every constant against primary sources; s.87A on total income; AY 2026-27 form changes (two house properties, Schedule AL at 1 crore, Finance Act 2026 deadlines with citations); employer NPS and house-property loss inputs; 44AD/44ADA ceilings and s.194N in the form picker; 26AS booking status, TCS separation and reconcile M2; path allow-list on the parsers
- [x] **v0.5.2** -- a validation table against the Budget Speech 2025-26 figures and hand-worked statute cases, enforced in CI; the `.mcpb` one-click Claude Desktop bundle, attached to each release from v0.5.3 on; a README demo rendered from a real stdio session
- [x] **v0.5.3** -- architecture and filing-flow diagrams rendered from [`docs/diagrams/`](docs/diagrams) with orrery (light and dark, reviewed at README width) in place of the mermaid sketch; the Income-tax Rules 2026 citations (Rules 164, 205, 215, 245, 269, 279) recorded for the FY 2026-27 pack; the README says what npm serves today
- [x] **v0.6** -- the model stops doing glue arithmetic: `reconcile_documents` reads the 26AS and AIS files, `parse_ais` sums its groups in code, `compute_interest_234` counts months from dates; self-occupied house-property interest follows s.24(b) and s.115BAC; `compute_hra` takes the city; every FY figure in tool text comes from the rule pack (1.5.0)
- [x] **v0.7** -- `compute_loss_setoff` (BFLA/CFL engine, [#4](https://github.com/Sagargupta16/itr-agent/issues/4)), `compute_house_property`, `compute_presumptive_income`, `tax_summary` (what you owe, from the 26AS file and dated payments), `list_tax_years` `status` from today's date, `compare_regimes` `breakeven`, the tax year 2026-27 rule pack (1.6.0), and the move to the 2.x MCP SDK
- [ ] **v0.8** (priorities validated against a real AY 2026-27 filing) -- `parse_form16` (TRACES PDF), broker capital-gains parsers -- Groww first, then Zerodha ([#7](https://github.com/Sagargupta16/itr-agent/issues/7)), `compute_schedule_fa` (foreign assets/RSU, Rule 115 rates, [#5](https://github.com/Sagargupta16/itr-agent/issues/5)), portal quirks playbook ([#6](https://github.com/Sagargupta16/itr-agent/issues/6)), mutual fund CAS via casparser, draft ITR JSON export

## Development

```bash
pnpm install
pnpm test          # vitest: engine golden files + in-memory MCP client tests
pnpm build
pnpm inspect       # MCP inspector against dist/index.js
pnpm validate      # docs/validation.md cases against the built server; --write regenerates it
pnpm bundle        # build/itr-agent-<version>.mcpb, the Claude Desktop bundle
node scripts/demo.mjs   # the README demo session
```

## Contributing

Tax software has a higher correctness bar than most OSS, so the ground rules are written down: [CONTRIBUTING.md](CONTRIBUTING.md) (tax constants live in `data/*.json` with a cited source, every calculator change ships a golden test, never commit a real tax document). Version history and every constant that moved: [CHANGELOG.md](CHANGELOG.md). Found a vulnerability? [SECURITY.md](SECURITY.md) has the private reporting path -- please do not open a public issue for it.

## Disclaimer

itr-agent is an open-source calculator, document parser, and filing guide. It is not a substitute for professional tax advice, and it never files anything -- output is meant to be verified against the official income tax utility, and the return is always submitted by you on the portal.

## License

[MIT](LICENSE)
