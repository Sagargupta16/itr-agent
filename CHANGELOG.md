# Changelog

All notable changes to this project will be documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [SemVer](https://semver.org/).

## [Unreleased]

### Fixed

- **Senior / super-senior basic exemption is a slab set, not an income deduction.** The old regime previously subtracted Rs 3,00,000 (senior) or Rs 5,00,000 (super senior) from taxable income before applying the below-60 slabs, which under-taxed every senior return by a whole slab and mis-stated total income on the face of the computation. The engine now selects `oldRegime.slabsSenior` / `slabsSuperSenior` from the rule pack, so income is reported unchanged and only the nil band widens. Source: Finance Act 2025 First Schedule Part I Paragraph A sub-paragraphs (ii) and (iii)
- **Surcharge marginal relief now compares tax AND surcharge at the threshold.** Relief was computed against surcharge alone, leaving the full amount standing just past a band edge. The engine now recomputes tax plus surcharge on a notional income rolled back to the threshold and caps the surcharge so the combined figure never exceeds that plus the income above the threshold. Source: proviso to First Schedule Part I Paragraph A
- **Unexhausted basic exemption is set off against listed-equity gains.** Where normal income falls short of the basic exemption, the shortfall now reduces 111A STCG first and then post-threshold 112A LTCG (the higher-taxed head first, which the statute permits the assessee to choose). Source: proviso to s.111A(1) and proviso to s.112A(2)
- **25% and 37% surcharge bands ignore 111A/112/112A/dividend income.** A taxpayer past Rs 2 crore purely on capital gains now correctly stays in the 15% band via the residual clause instead of being pushed to 25%/37%. Source: Finance Act 2025 First Schedule Part I Paragraph A
- **s.288A/288B rounding applied.** Total income is rounded to the nearest multiple of ten before the slabs are applied, and the tax payable is rounded to the nearest ten. Source: Income-tax Act s.288A and s.288B
- Section 234C was silently omitted from `compute_interest_234` whenever its own inputs were absent; each section is now computed only when its inputs exist and anything skipped is reported in a `skipped[]` array with a reason
- Form 26AS amount extraction read the last three NUMERIC cells, so a blank cell shifted the window and silently mis-assigned amount paid / TDS deducted / TDS deposited. Amounts are now read positionally from the cells following the section code, correction rows are flagged (`isCorrection`), part headers reset the current deductor, and unparsed rows are surfaced in `unparsedRows`
- `compute_hra` ignored the `months` field on each period, so a part-year tenancy was treated as a full year. Periods that do not total 12 months now raise a warning, and 80GG applies its Rs 5,000 **per month** limb rather than a flat annual Rs 60,000
- 80GG was offered under the new regime and alongside HRA, both of which s.80GG bars, and a rent below 10% of adjusted total income returned a bare zero with nothing saying why. It now reports an `eligible: false` flag with an explanatory warning in each of those cases. (The deduction itself was never negative: the rent-excess limb was already clamped at zero, and the tool boundary rejects a negative adjusted total income)
- Reconcile summed rupee floats, so long TDS lists drifted by paise; totals now sum integer paise. A TAN present in Form 16 but entirely absent from 26AS is now a HIGH finding instead of being skipped
- Interest under s.234B now honours the s.234B(2) payment ladder: each self-assessment payment under s.140A reduces the principal from its own month, reported as per-segment output
- Rule-pack loading rejects any FY not in the available-years allow-list, so a caller-supplied year cannot be used to probe the filesystem
- AIS decryption failures now distinguish a rotated export format from a wrong password, and name the fix in each case. AES-CBC accepts a wrong key whenever the trailing bytes happen to form valid PKCS#7 padding (~1 in 256 per candidate), so a one-character DOB typo used to surface as "the export format has changed -- file an issue". Only a payload that actually starts like JSON now counts as evidence of a format change
- Every rupee input is capped at Rs 1 lakh crore. A caller-supplied `1e308` previously passed validation, overflowed the income sum to `Infinity`, and `JSON.stringify` serialized that as `null` -- so the tool reported success with every tax figure null
- Document paths are stat-checked before reading: a directory and an oversized file each get their own message instead of the generic "could not read file", and a multi-gigabyte file no longer surfaces as a bare V8 "Invalid string length"
- The `parse_ais` PAN mask is case-insensitive. The parser preserves whatever case the source file carries, so a lowercase PAN in a remark or deductor name passed through the text mirror unmasked
- Two quadratic paths that a mis-scaled tool call could reach: the AIS column reader iterated the label list per row (a crafted 3.5 MB file blocked the single-threaded stdio server for ~97s; now ~10ms), and reconcile check M1 re-filtered the whole 26AS list per Form 16 entry (now indexed by TAN once). `reconcile_documents` also bounds its arrays at 2,000 TDS rows and 50 Form 16s

### Added

- Section 234A (interest for late filing) via `compute_interest_234`, from the rule pack's `interest.s234A` config
- Reconcile checks M4 (declared salary below the summed Form 16 gross salary, s.143(1)(a)(vi)) and M5 (26AS rows with TDS deposited but no amount paid, s.139(9) defect)
- `tsconfig.test.json` plus a two-config `pnpm typecheck`: the test suite was previously excluded from typechecking, so a stale call signature only surfaced at runtime
- Engine tests pinning surcharge bands, marginal relief on both sides of a band edge, the enhanced-band exclusion, the 15% gains cap, the 25% new-regime cap, all three old-regime age bands, and s.288A/288B rounding. Added a mutation test that fails if `allowAgainst111A` is ever flipped on for the new regime, so the "87A never offsets 111A/112A under the new regime" claim is enforced rather than merely documented
- `.gitattributes` normalizing every text file to LF. With `core.autocrlf=true` a clean clone checked out CRLF and `pnpm lint` failed on unmodified files
- CI now runs a matrix (Ubuntu + Windows, Node 22 + 24 + 26), asserts real computed tax figures over stdio instead of grepping the tool list, asserts that nothing but JSON-RPC reaches stdout, and validates the npm tarball by installing it and running it as a user would
- `publish.yml` verifies the release candidate tarball, publishes with `--provenance`, and fails if the registry does not report attestations afterwards. v0.3.0 was hand-published and carries none
- `fixtures/` is gitignored with a README explaining why: it is where real Form 26AS and AIS documents land during local parser checks, and those carry PAN, salary and TDS data
- Server tests now call all twelve tools through an in-memory MCP client, including the PAN contract on both parsers (masked in the text mirror, real in `structuredContent`), the rupee ceiling, the directory/oversize read branches, and the AIS decrypt round trip
- `src/**/*.js` and `src/**/*.d.ts` are gitignored: `tsc -p tsconfig.test.json` widens `rootDir` to the repo root and emits next to the sources, after which `pnpm lint` fails on 22 generated files
- Tests for s.234A (both published goldens, the nil-when-on-time and nil-when-nothing-outstanding branches, and the Rule 119A(c) principal floor) and for the s.234B(2) payment ladder (segment split, per-segment flooring, unordered payments)

### Changed

- Rule pack 1.2.0: `oldRegime.slabsSenior` / `slabsSuperSenior`, `capitalGains.basicExemptionSetOff`, `surcharge.enhancedBandsExcludeSpecialRateIncome` + `enhancedBandRateFloor`, `itrEligibility` caps (previously hardcoded in `itr-form.ts`), `interest.s234A`, `deduction80GG.capPerMonth`, and explicit `thresholdBasis` / `allowAgainst111A` / `allowAgainst112A` on both regimes' `rebate87A`
- `compute80GG` takes an options object and a regime argument instead of positional numbers (breaking for direct importers; the MCP tool surface is unchanged)
- `TaxBreakdown` gained `basicExemptionSetOff` and `surchargeRatePct`
- `reconcile_documents` reports `tdsByHead`, grouping 26AS TDS by the income head each section implies. The rule pack's `tdsSectionToHead` map had shipped in v0.2 with nothing reading it; sections outside the map surface as `unmapped` rather than being dropped
- Rule-pack config sections (`interest`, `hra`, `deduction80GG`, `reconcile`, `tdsSectionToHead`) are now required rather than optional, and `validatePack()` names the missing section at load time. The optional typing had forced `?? <literal>` fallbacks at every read site, which meant a pack missing a rate silently computed with a hardcoded one
- `docs/v0.2-spec.md` marked up with per-section implementation status. It was written before v0.2 was coded and read as shipped behaviour, while Form 16 PDF parsing, the CSV fallback, the SFT code lookup, four reconcile checks and the whitelist engine were never built
- `recommend_itr_form`'s `totalIncome` now means total income AFTER Chapter VI-A deductions, reversing the previous "gross total income before Chapter VI-A" wording. The Rs 50 lakh ITR-1/ITR-4 ceiling tests total income, so the old description told callers to supply the one figure that would wrongly rule out ITR-1 for anyone whose gross crossed 50L but whose total did not
- `recommend_itr_form` treats `presumptive` as a business side even when `hasBusinessIncome` is false. 44AD/44ADA receipts ARE business income, and without this a presumptive-only filer skipped the business-form branch entirely
- README documents the open AIS ship gate: the reverse-engineered password scheme has never been verified against a live portal export
- `biome.json` migrated to the 2.5.x schema (`biome migrate`); dependencies moved to their latest stable releases (MCP SDK 1.30.0, TypeScript 7.0.2, Biome 2.5.6, Vitest 4.1.10, @types/node 26.1.2) and CI to `pnpm/action-setup@v6` + `actions/setup-node@v7`
- `pnpm-workspace.yaml` pins `postcss >=8.5.18` and `esbuild >=0.28.1` via overrides. Both are dev-only (neither ships in the package `files`), but the transitive resolutions carried GHSA-r28c-9q8g-f849 and GHSA-g7r4-m6w7-qqqr; `pnpm audit` is now clean
- Test suite grown to 109 tests

## [0.3.3] - 2026-09-03

### Security

- `pnpm-workspace.yaml` pins `qs >=6.16.0` (resolves 6.16.0), a runtime transitive of the MCP SDK via express and body-parser, past GHSA-4mjr-xmp4-gh2g (Denial of Service via attacker-controlled isBuffer) and GHSA-x5fp-wj9c-mxmx (array-limit bypass via bracket-key comma parsing), both medium. `pnpm audit` stays clean

## [0.3.2] - 2026-09-03

### Fixed

- AIS decrypt could still misreport a wrong password as "the export format has changed": the format-change classifier only sniffed the first character of the decrypted payload, and a wrong AES-CBC key that survives the PKCS#7 padding check (~1 in 255) produces garbage that opens with `{` or `[` about 2 in 256 times. Measured over 10^6 wrong keys: 3,844 padding survivors, 23 of them bracket-first -- enough to flake the 400-DOB regression sweep in ~3.6% of runs (and one CI matrix job in ~5). Claiming a format change now also requires the entire payload to decode as valid UTF-8 (`node:buffer` `isUtf8`), which uniform random bytes essentially never satisfy (0 of the same 10^6); a genuinely rotated but textual export still classifies as a format change, and the success path is untouched

## [0.3.1] - 2026-09-02

### Security

- `pnpm-workspace.yaml` pins three runtime transitives of the MCP SDK past their Dependabot alerts: `hono >=4.12.34` (resolves 4.13.5; GHSA-f23p-vx2j-j53r, GHSA-54fx-42gc-7vw4, GHSA-8j4g-w8fx-2239, GHSA-79qm-7rj5-m7r9), `fast-uri >=3.1.5 <4` (resolves 3.1.6, capped inside ajv's declared ^3 range; GHSA-7p8r-x3mc-p8w7, high), and `ip-address >=10.3.1` (resolves 10.7.0; GHSA-mwp4-54f8-5fhr high, GHSA-4xrf-jv44-h6hh, GHSA-22jq-vg5j-6vgg)
- `nanoid >=3.3.18 <4` pinned alongside them (dev-only, via postcss; GHSA-2v37-7h3g-55p8, high) -- capped below 4 because nanoid 4+ is ESM-only and postcss requires it as CJS. `pnpm audit` is clean again

## [0.3.0] - 2026-07-21

### Changed

- **Renamed `itr-mcp` -> `itr-agent`** (npm package, bin, GitHub repo, MCP server name). The `itr-mcp` npm package is deprecated and frozen at 0.2.0; update MCP configs to `npx -y itr-agent`. GitHub redirects the old repo URL.
- Positioning: filing agent, not just calculator -- the new prompt + tools guide a filer end to end, while the final submit stays with the taxpayer (no public filing API exists; only authorized ERIs may file on someone's behalf).

### Added

- `recommend_itr_form` ([#3](https://github.com/Sagargupta16/itr-agent/issues/3)): ITR-1/2/3/4 selection for individuals with rule-by-rule reasoning, ruled-out trail, deadlines and 234F late fees from the rule pack. Loss-continuity aware: brought-forward business/speculative losses force ITR-3 even with zero current-year business income (Schedule CFL), including the nil-business ITR-3 mechanics guidance (No Account Case zeros, nil Trading & P&L). Encodes the AY 2025-26 carve-in of 112A LTCG up to Rs 1.25L into ITR-1/ITR-4. Eligibility rules per incometax.gov.in "Which ITR is applicable" (AY 2026-27)
- `filing_checklist`: ordered, form-specific walkthrough (gather -> reconcile -> compute -> portal -> e-verify) with schedule-level portal steps per form and the explicit taxpayer-presses-submit boundary
- `file_my_itr` MCP prompt: the guided interview -- one question at a time, income heads, disqualifier sweep, losses, then form -> regime -> reconciliation -> checklist, all numbers from tools

### Fixed

- Stale test title ("lists all six tools") corrected to the actual twelve-tool surface

## [0.2.0] - 2026-07-07

### Added

- `parse_ais`: on-device decryption (AES-256-CBC, PBKDF2-HMAC-SHA256 x1000, password derived from PAN + DOB with the reverse-engineered pepper + un-peppered fallbacks + explicit override) and normalization of the AIS JSON export -- taxpayer info + flat information rows with label-matched amounts/dates/codes, PAN masked in text output
- `reconcile_documents`: Form 16 vs AIS vs 26AS mismatch report (H1 TDS over-claim vs 26AS, H3 missing-employer TAN, H4/H5 undeclared AIS interest/dividend, M1 Form 16-vs-26AS per TAN, M3 gross-salary-vs-AIS) with tiered tolerances (Rs 10 statutory slack), skipped-check reporting, and notice-section mapping (143(1)(a), 139(9))
- `compute_interest_234`: sections 234B/234C with Rule 119A rounding (interest principal floored to Rs 100, part month = full month), statutory 12%/36% safe harbors measured back from 15%/45% when breached, presumptive single-installment mode -- pinned to 5 published golden cases (Suraj 920, Khushal 93, company 605, ClearTax 2,600, boundary 12%/11.99%)
- `compute_hra`: Rule 2A least-of-three, period-wise, salary = basic + retirement-forming DA + fixed-% turnover commission (Gestetner); FY 2025-26 metro list correctly 4 cities (the 8-city expansion is FY 2026-27); landlord-PAN warning above 1L rent; 80GG companion with its three limbs
- Rule pack 1.1.0: rounding hierarchy (288A/288B/119A), interest config with per-installment safe harbors, HRA + 80GG config, reconcile tolerances, TDS-section-to-income-head map

### Fixed

- Old-regime 87A semantics: the 5L threshold now tests TOTAL income including capital gains (was normal income only), and the rebate can offset 111A STCG tax under the old regime (s.112A(6) continues to bar 112A in both regimes) -- driven by rule-pack flags

### Changed

- Test suite grown to 47 tests including AIS encrypt/decrypt round-trips and all published interest/HRA golden cases

## [0.1.0] - 2026-07-06

### Added

- MCP server (stdio, SDK 1.29) with six read-only tools: `compute_tax`, `compare_regimes`, `schedule_advance_tax`, `list_deductions`, `parse_form26as`, `list_tax_years`
- Deterministic FY 2025-26 (AY 2026-27) tax engine: new/old regime slabs, standard deduction, 87A rebate with marginal relief (new regime), 111A 20% / 112A 12.5% capital gains with the 1.25L exemption, surcharge with 15% gains cap and 25% new-regime cap, 4% cess
- Versioned rule pack (`data/fy2025-26.json`) as the single source of every constant
- Form 26AS caret-delimited text parser with PII masking in text output
- Advance tax installment planner (15/45/75/100% cumulative) with shortfall tracking
- Test suite: 21 tests including golden cases (12L zero tax, 12,10,000 marginal relief, 12,70,588 exhaustion) and in-memory MCP client round trips
