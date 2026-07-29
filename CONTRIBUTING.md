# Contributing

Thanks for considering a contribution. Tax software has a higher correctness bar than most OSS -- please read this before opening a PR.

## Setup

```bash
git clone https://github.com/Sagargupta16/itr-agent
cd itr-agent
pnpm install
pnpm test
```

## Ground rules

- **Tax constants live in `data/*.json` only, never in code.** Changing a constant requires a CHANGELOG entry citing the source (Finance Act section, CBDT circular, or incometax.gov.in page).
- **Every calculator change ships with a golden test** -- a worked example from a published source with the exact expected rupee amount, cited in a comment.
- **The LLM never does arithmetic.** Tools return numbers computed by pure functions over the rule pack.
- **stdout is the MCP channel.** All logging goes to stderr. One stray `console.log` breaks the protocol.
- **Local-only is the product.** PRs adding network transports, telemetry, or cloud calls will be declined.
- **Parsers are tolerant**: collect `warnings[]`, never throw on layout surprises; error messages must name the fix.
- Never commit real tax documents, PANs, or personal data. Anything checked in must be synthetic; `fixtures/` is gitignored precisely because it is the scratch directory where a real 26AS or AIS export lands while you check a parser locally.
- Conventional commits; `pnpm lint && pnpm typecheck && pnpm test` must pass.

## Adding a fiscal year

New FY = new `data/fyYYYY-YY.json` pack + `availableYears()` update + golden tests for the changed rules. Engine code changes should be rare -- if a rule change needs code, consider whether the rule pack schema should grow instead.

## Reporting parse failures

For AIS/26AS/Form 16 parse issues: describe the document's structure (labels, section names) WITHOUT sharing the document itself. Never attach real tax documents to issues.
