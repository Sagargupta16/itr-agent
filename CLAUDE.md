# CLAUDE.md

> This file stacks on top of the workspace root at `C:\Code\GitHub\`:
> - Root [`CLAUDE.md`](../../CLAUDE.md) -- voice, rules, routing map, references, skills, slash commands, conventions.
> - Root [`MEMORY.md`](../../MEMORY.md) -- live facts across repos.
> - Root [`STATUS.md`](../../STATUS.md) -- live PR/CI/security dashboard.
> - [`.claude/resources/`](../../.claude/resources/README.md) -- deep reference for collaboration, workflow, git, OSS, debugging, voice.
>
> Read those first. The guidance below only adds **repo-specific context** -- it does not override anything in the root.

## Project

Local-first MCP server for Indian income tax (FY 2025-26 / AY 2026-27): deterministic tax engine + document parsers exposed as MCP tools over stdio. Public OSS, npm package `itr-agent`. Positioning: privacy-first -- everything runs on-device, unlike cloud finance MCPs (Fi/INDmoney).

## Stack

- **Language**: TypeScript 6 (strict, ESM, NodeNext)
- **Framework**: @modelcontextprotocol/sdk 1.29 (stdio transport only), zod 4
- **Database**: none -- rule packs are JSON files in `data/`
- **Package manager**: pnpm
- **Deploy target**: npm registry (`npx -y itr-agent`); .mcpb Desktop bundle planned

## Run

```
pnpm install
pnpm build
node dist/index.js        # stdio MCP server
pnpm inspect              # MCP inspector UI
```

## Test

```
pnpm test         # engine golden cases + in-memory MCP client round trips (109 tests)
pnpm lint         # biome
pnpm typecheck    # two configs: tsconfig.json (src) + tsconfig.test.json (src + tests)
```

`pnpm typecheck` runs twice on purpose: `tsconfig.json` carries the build's
`rootDir`/`outDir`/`declaration` settings and excludes `tests/`, so without the
second config the test suite is never typechecked and a stale call signature only
shows up at runtime.

## Entry points

- `src/index.ts` -- stdio bootstrap (banner adds the shebang via tsup)
- `src/server.ts` -- all tool registrations (the MCP surface)

## Key files

- `src/engine/compute.ts` -- the tax engine: slabs (incl. senior/super-senior slab sets), 87A + marginal relief, CG rates with the s.111A/s.112A(2) basic-exemption set-off, surcharge with its own marginal relief, cess, s.288A/288B rounding. Pure functions; the LLM never does arithmetic
- `data/fy2025-26.json` -- rule pack: EVERY tax constant lives here, never inline in code. `validatePack()` in rulepack.ts throws at load time if a pack is missing a section the engine reads, which is why the config fields are required rather than optional-with-a-code-fallback
- `src/parsers/form26as.ts` -- caret-delimited TRACES text parser (tolerant, warnings[] over throws). Amounts are read POSITIONALLY from the cells after the section code, never by filtering for numeric-looking cells: a blank cell shifts that window and silently mis-assigns amount paid / TDS deducted / TDS deposited
- `tests/engine.test.ts` -- golden cases pinned to published worked examples plus statute-pinned surcharge, age-band, and rounding cases
- `docs/v0.2-spec.md` -- researched design + statutory citations, NOT a description of shipped behaviour. It predates the v0.2 code and roughly half of it was never built (Form 16 PDF parsing, the AIS CSV fallback, the SFT lookup, reconcile H2/M2/L1/L2, the whitelist engine). Every section carries a status marker; the table at the top is the index. Update those markers whenever one of those items lands

## Gotchas

- **stdout is the MCP channel** -- all logging must go to stderr (`console.error`). One stray `console.log` breaks the protocol.
- Rules key off TRANSACTION DATES, not just FY: 23-Jul-2024 (CG rate flip), 1-Apr-2023 (debt MF s50AA), 1-Oct-2024 (buyback deemed dividend). Keep date boundaries in the rule pack when those land.
- 87A rebate NEVER offsets 111A/112A tax under the new regime (Finance Act 2025) -- the engine applies it to normal-income slab tax only, driven by `allowAgainst111A` / `allowAgainst112A` in the pack. A mutation test in `tests/engine.test.ts` flips `allowAgainst111A` on and asserts the answer changes, so the claim is enforced and not just documented.
- The senior / super-senior basic exemption is a SLAB SET (`oldRegime.slabsSenior` / `slabsSuperSenior`), never an income deduction. Subtracting it from income under-taxes by a whole slab and mis-states total income; the age-band tests pin `taxableNormalIncome` for exactly this reason.
- Surcharge marginal relief compares tax PLUS surcharge at the band threshold against the actual figure (via a notional recomputation on income rolled back to the threshold). Comparing surcharge alone leaves the full amount standing just past a band edge.
- The 25%/37% surcharge bands exclude 111A/112/112A/dividend income (First Schedule Part I Para A), so a taxpayer past Rs 2 crore purely on gains stays in the 15% band.
- SDK v2 (beta, stable ~2026-07-28) flips `registerTool` input schemas from raw zod shapes to `z.object()`. The multi-field shapes are hoisted to module-level consts in `src/server.ts` (`taxInputShape`, `interest234Shape`, `hraShape`) for that migration; single-purpose tool schemas are still inline at their registration.
- `data/` ships in the npm package (`files` field); `resolveDataDir()` in rulepack.ts probes both dist- and src-relative paths.
- FY 2026-27 pack (Budget 2026): Form 16 becomes Form 130, HRA metros 4 -> 8, buyback reverts to capital gains. New JSON pack + `availableYears()` update, no engine changes expected.

## Repo-specific rules

- Never add a network transport or telemetry -- local-only is the product.
- Tax constants only ever change via `data/*.json` + a CHANGELOG entry citing the source (Finance Act / CBDT circular / incometax.gov.in page).
- Every new tool: `annotations: { readOnlyHint: true, openWorldHint: false }`, zod-described inputs, `structuredContent` output, disclaimers on anything that computes tax.
- Parsers must be tolerant: collect `warnings[]`, never throw on layout surprises; errors must name the fix ("download the Text format from TRACES").
- Text output masks PAN; `structuredContent` does NOT (downstream tools need the real value). So "local-only" describes this server, not the whole stack -- the connected client still sees parsed contents. Say that plainly in docs rather than claiming the PAN never leaves the process.
- Never commit anything to `fixtures/` -- it is gitignored because it is where real 26AS/AIS documents land during manual parser checks.
