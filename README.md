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

## Why

Every Indian tax tool wants your data on their servers. itr-agent flips it: your documents stay local, the LLM never does arithmetic, and every number comes from a versioned rule pack you can audit. The agent layer drives the interview; the deterministic engine does the math.

**What it will never do:** submit the return for you. India has no public filing API -- returns are filed by you on [incometax.gov.in](https://www.incometax.gov.in) (or by an authorized ERI/CA). The agent takes you to that button with every number verified; you press it.

## The agent

`file_my_itr` (MCP prompt) runs the guided interview:

1. Residency, age band -- one question at a time
2. Income heads: salary, house property, capital gains, business/F&O, other sources
3. Disqualifier sweep: foreign RSUs/ESPP, director role, unlisted shares, ESOP deferral
4. Losses, current and brought-forward (they change the form)
5. `recommend_itr_form` -> the form, with rule-by-rule reasoning
6. `compare_regimes` -> the regime, with real numbers
7. `parse_ais` / `parse_form26as` / `reconcile_documents` -> fix mismatches BEFORE filing
8. `schedule_advance_tax` / `compute_interest_234` if applicable
9. `filing_checklist` -> schedule-by-schedule portal walkthrough, ending at e-verification

## Tools (v0.4)

| Tool | What it does |
| --- | --- |
| `recommend_itr_form` | ITR-1/2/3/4 selection with rule-by-rule reasoning and loss-continuity awareness: brought-forward business losses force ITR-3 even with zero current-year business income (Schedule CFL) |
| `filing_checklist` | Ordered, form-specific walkthrough: documents, reconciliation, computation, portal steps schedule by schedule, e-verification |
| `compute_tax` | Full FY 2025-26 (AY 2026-27) computation: new/old regime slabs (incl. the senior and super-senior slab sets), standard deduction, 87A rebate (new regime: Rs 60,000 up to Rs 12L with marginal relief, never offsetting 111A/112A tax; old regime: Rs 12,500 on total income up to Rs 5L, no marginal relief, offsets 111A), 111A (20%) / 112A (12.5% above 1.25L) capital gains with the unexhausted-basic-exemption set-off, surcharge with the 15% gains cap and its own marginal relief, 4% cess, s.288A/288B rounding |
| `compare_regimes` | Old vs new side by side, recommended regime, savings amount |
| `schedule_advance_tax` | Jun/Sep/Dec/Mar installment plan (15/45/75/100%) with shortfall tracking |
| `compute_interest_234` | Sections 234A/234B/234C interest with the statutory 12%/36% safe harbors, the s.234B(2) self-assessment payment ladder, and Rule 119A rounding (principal floored to Rs 100, part month = full month). Reports which sections it skipped and why |
| `compute_hra` | HRA exemption per Rule 2A, period-wise (least of three limbs; FY 2025-26 metros: Delhi/Mumbai/Kolkata/Chennai) + the 80GG alternative, with its Rs 5,000-per-month cap and the bars under the new regime and alongside HRA |
| `list_deductions` | Old-regime deduction checklist with statutory caps (80C, 80CCD(1B), 80D tiers, HRA metros) |
| `parse_form26as` | Parse the caret-delimited Form 26AS Text export from TRACES into structured TDS entries |
| `parse_ais` | Decrypt + parse the AIS JSON export on-device (AES-256-CBC/PBKDF2 with the password derived from PAN + DOB); normalized rows with label-matched amounts/dates/codes |
| `reconcile_documents` | Form 16 vs AIS vs 26AS mismatch report -- the checks that pre-empt 143(1)(a) intimations and 139(9) defect notices (TDS over-claim, missing employer, undeclared AIS interest/dividend) |
| `list_tax_years` | Supported fiscal years + AY 2026-27 filing deadlines |

All tools are read-only (`readOnlyHint: true`), take zod-validated inputs, and return `structuredContent` alongside the human-readable text.

## Install

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

### From source

```bash
git clone https://github.com/Sagargupta16/itr-agent
cd itr-agent && pnpm install && pnpm build
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

## Filing after the due date

The s.139(1) due date for FY 2025-26 is in `deadlines` (`list_tax_years` prints them). Once it has passed, the return is **belated under s.139(4)** and four things change. `file_my_itr` now asks about timing before anything else, because two of them are cheaper to know up front.

- **You can still file**, up to `deadlines.belated` (2026-12-31 for AY 2026-27) or before the assessment is completed, whichever is earlier. A revised return remains open until `deadlines.revised`.
- **s.234F fee**: Rs 5,000, or Rs 1,000 where total income does not exceed Rs 5 lakh. Both figures come from the rule pack (`lateFee234F`) and are returned by `recommend_itr_form` and `filing_checklist`.
- **s.234A interest**: 1% per month, or part of a month, on the tax still outstanding after TDS/TCS, advance tax and reliefs, running from the day after the due date to the date of filing. Call `compute_interest_234` with `monthsLateFiling` (part month = full month, Rule 119A).
- **s.80 forfeits this year's loss carry-forward.** Business, speculative and capital losses of the current year cannot be carried forward in a belated return. Set-off of losses already determined in an earlier year survives, and so does the house-property loss carry-forward (s.71B). `recommend_itr_form` says this in `notes` whenever a loss flag is set, so its ITR-3 recommendation is not read as an unconditional carry-forward.

Not modeled, deliberately: whether a belated business filer keeps the old-regime election (s.115BAC(6) / Form 10-IEA is due on or before the s.139(1) date). Read that one off the portal or ask a CA before relying on either answer.

## Scope and limitations

Honest boundaries, so you know before you rely on it. [`docs/v0.2-spec.md`](docs/v0.2-spec.md) carries the statutory citations behind each rule, the per-section implementation status, and the register of claims that were researched and refuted.

- **Resident individuals, FY 2025-26 (AY 2026-27).** NRI/RNOR computation differs (the form recommendation accounts for residency, the tax engine assumes resident).
- **No filing.** There is no public API to submit an ITR; only you or an authorized ERI can file. The agent prepares and verifies everything, then hands over.
- **You supply the income figures.** `compute_tax` computes tax on the heads you give it: salary, other income, 111A STCG, 112A LTCG, and old-regime deductions as a single total. It does not itself compute house property (30% standard deduction, 24(b) interest), other capital-gains heads (112 debt/property, 115BBH crypto, slab-rate debt MF under 50AA), or business P&L -- work those out separately, or with `list_deductions` for the Chapter VI-A caps, and pass the totals in.
- **Not yet modeled:** house property and business P&L computation (a `presumptive` flag exists, but only to pick the single-installment 234C schedule and to steer the form recommendation -- 44AD/44ADA income itself is not computed), crypto/VDA (115BBH), non-equity capital gains, loss set-off arithmetic ([#4](https://github.com/Sagargupta16/itr-agent/issues/4)), Schedule FA valuation ([#5](https://github.com/Sagargupta16/itr-agent/issues/5)), Form 16 PDF parsing (`reconcile_documents` takes Form 16 figures as input, it does not read the PDF), broker capital-gains statements ([#7](https://github.com/Sagargupta16/itr-agent/issues/7)).
- **Dividend is ordinary income for surcharge purposes.** There is no dividend input: it goes in `otherIncome`. The First Schedule keeps dividend out of the 25%/37% surcharge bands and caps its surcharge at 15%, and `compute_tax` does neither for dividend (it does both for 111A/112A gains). Only bites above Rs 2 crore of total income; below that every band rate is already at or under 15%.
- **Transaction-date rules not yet split.** The engine applies FY 2025-26 rates uniformly; the 23-Jul-2024 capital-gains rate flip and the 1-Oct-2024 buyback change matter for FY 2024-25 returns, which this pack does not cover.
- **The encrypted AIS file is not a safe place to store your data.** Its password is your PAN plus your date of birth, stretched with only 1,000 PBKDF2-SHA256 iterations. Once someone knows your PAN, every plausible DOB can be tried in about 4 seconds single-threaded (measured on a laptop: 0.11 ms per key derivation over a ~36,600-date space). That is the portal's scheme, not this tool's choice, and nothing here can strengthen it -- treat a downloaded AIS export as effectively unencrypted and delete it when you are done.
- **`parse_ais` decryption is unproven on a live export.** The AIS password scheme is reverse-engineered from open-source utilities and verified against this repo's synthetic round-trip, never against a file the portal actually produced. If it fails, the error tells you to pass `password` explicitly or use the portal's CSV export, and [an issue report](https://github.com/Sagargupta16/itr-agent/issues) with your download date helps fix it. Every other tool is unaffected.
- **Not tax advice.** Complex cases belong with a CA. Every output says so.

## Design principles

- **Local-only.** stdio transport, no network calls, no telemetry, no accounts. Your documents are read from disk by this process and never uploaded anywhere. AIS decryption happens entirely on-device with Node's crypto -- the reverse-engineered password scheme has un-peppered fallbacks and an explicit `password` override in case the format rotates.
- **What your MCP client still sees.** Parsed output is returned to whatever client you connected, so if that client is a hosted LLM, the parsed contents reach that provider like any other message. PAN is masked in the human-readable text mirror, but the `structuredContent` payload carries the full parsed document (PAN, TANs, deductor names, amounts) because downstream tools need it. Local-only describes this server, not your whole stack -- for maximum privacy, run it against a local model.
- **The LLM never does math.** Every rupee is computed by pure functions over `data/fy2025-26.json`. 114 tests pin the engine to published worked examples and to statute: the 12L zero-tax case, the 12,10,000 marginal-relief case, the 12,70,588 relief exhaustion point on both sides, the surcharge bands with the First Schedule exclusion of capital-gains income, all three old-regime age bands, and the 234A/234B/234C/HRA/80GG golden cases.
- **The agent drives, the engine decides.** The interview sequencing is a prompt; every number and every form rule is deterministic code. Nothing is estimated.
- **Year-parameterized.** Rules live in per-FY JSON packs. FY 2026-27 (Budget 2026: Form 16 renamed to Form 130, 8 HRA metros, buyback reversion) lands as a new pack, not code changes.
- **Not tax advice.** Every tool that computes a rupee figure returns a `disclaimers` array and the fiscal year it applied; `compute_tax`, `compute_hra` and `list_tax_years` also return the exact `rulePackVersion`. Verify against the official utility before filing.

## Roadmap

- [x] **v0.1** -- tax engine (both regimes + CG + surcharge + cess), regime comparison, advance tax, deduction checklist, 26AS text parser
- [x] **v0.2** -- `parse_ais` (encrypted AIS JSON, on-device decrypt), `reconcile_documents` (the #1-notice-trigger checks), 234B/234C interest with golden-case tests, HRA + 80GG calculators, old-regime 87A semantics fix
- [x] **v0.3** -- renamed to **itr-agent**; `recommend_itr_form` with loss-continuity awareness ([#3](https://github.com/Sagargupta16/itr-agent/issues/3)), `filing_checklist`, the `file_my_itr` guided interview prompt
- [x] **v0.4** -- engine correctness pass (senior/super-senior slab sets, surcharge marginal relief on tax + surcharge, the s.111A/112A basic-exemption set-off, s.288A/288B rounding), positional 26AS amount extraction, s.234A + the s.234B(2) payment ladder, reconcile M4/M5, belated-filing guidance, security pins on the SDK's transitives, npm publishing via OIDC with provenance, and an MCP registry manifest ([`server.json`](server.json))
- [ ] **v0.5** (priorities validated against a real AY 2026-27 filing) -- `compute_loss_setoff` (BFLA/CFL engine, [#4](https://github.com/Sagargupta16/itr-agent/issues/4)), `parse_form16` (TRACES PDF), broker capital-gains parsers -- Groww first, then Zerodha ([#7](https://github.com/Sagargupta16/itr-agent/issues/7))
- [ ] **v0.6** -- `compute_schedule_fa` (foreign assets/RSU, Rule 115 rates, [#5](https://github.com/Sagargupta16/itr-agent/issues/5)), portal quirks playbook ([#6](https://github.com/Sagargupta16/itr-agent/issues/6)), mutual fund CAS via casparser, draft ITR JSON export, `.mcpb` one-click Claude Desktop bundle

## Development

```bash
pnpm install
pnpm test          # vitest: engine golden files + in-memory MCP client tests
pnpm build
pnpm inspect       # MCP inspector against dist/index.js
```

## Contributing

Tax software has a higher correctness bar than most OSS, so the ground rules are written down: [CONTRIBUTING.md](CONTRIBUTING.md) (tax constants live in `data/*.json` with a cited source, every calculator change ships a golden test, never commit a real tax document). Version history and every constant that moved: [CHANGELOG.md](CHANGELOG.md). Found a vulnerability? [SECURITY.md](SECURITY.md) has the private reporting path -- please do not open a public issue for it.

## More AI Developer Tools

| Project | What it does |
| --- | --- |
| [mcp-toolkit](https://github.com/Sagargupta16/mcp-toolkit) | TypeScript middleware toolkit for MCP servers: authentication, caching, rate limiting, CORS, logging (beta) |
| [ai-git-hooks](https://github.com/Sagargupta16/ai-git-hooks) | AI-powered git hooks: auto-review diffs, generate commit messages, scan for secrets. Claude, OpenAI, and Ollama |
| [claude-cost-optimizer](https://github.com/Sagargupta16/claude-cost-optimizer) | Strategies, benchmarks, and copy-paste configs for cutting Claude Code costs |

## Disclaimer

itr-agent is an open-source calculator, document parser, and filing guide. It is not a substitute for professional tax advice, and it never files anything -- output is meant to be verified against the official income tax utility, and the return is always submitted by you on the portal.

## License

[MIT](LICENSE)
