# fixtures/

Scratch space for your own tax documents when checking the parsers by hand.

Everything in this directory is gitignored except this file. Real Form 26AS
exports and AIS JSON carry your PAN, employer TANs, salary and TDS figures --
they must never reach a commit.

To try a parser against a real file:

```bash
node dist/index.js
# then call parse_form26as / parse_ais with the path
```

Test fixtures that ship with the repo are synthetic and live inline in
`tests/`, so a clean clone never contains anyone's tax data.
