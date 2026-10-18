// A scripted session against the BUILT server over stdio: the same tool calls
// Claude makes during `file_my_itr`, with the figures the engine returns.
//
//   node scripts/demo.mjs                    print the session
//   node scripts/demo.mjs --svg-data FILE    also write the input for the
//                                            README terminal animation
//
// The README's docs/demo-*.svg is rendered from that file, so every number in
// the animation is one this script printed. Run `pnpm build` first. The
// renderer is the `typing` kind of the svg-forge plugin's forge.py
// (github.com/Sagargupta16/svg-forge):
//
//   python forge.py --kind typing --theme both --width 600
//     --title "itr-agent: a scripted tool session over stdio"
//     --data demo.json --out docs/demo.svg
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const client = new Client({ name: "itr-agent-demo", version: "0" });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [join(root, "dist", "index.js")],
    stderr: "ignore",
  }),
);

const call = async (name, args) => {
  const res = await client.callTool({ name, arguments: args });
  if (res.isError || !res.structuredContent) {
    throw new Error(`${name} failed`);
  }
  return res.structuredContent;
};
const rs = (n) => `Rs ${new Intl.NumberFormat("en-IN").format(n)}`;
const month = (iso) =>
  new Date(`${iso}T00:00:00Z`).toLocaleString("en-US", {
    month: "short",
    timeZone: "UTC",
  });
const lines = [];

// 1. Salaried with vested US RSUs: foreign assets rule out ITR-1.
const form = await call("recommend_itr_form", {
  residency: "resident",
  totalIncome: 1800000,
  hasForeignAssetsOrIncome: true,
});
const ruledOut = form.ruledOut.find((r) => r.form === "ITR-1");
lines.push({
  cmd: "recommend_itr_form income=18L foreignAssets=yes",
  out: [
    `${form.recommended}, due ${form.dueDate}`,
    `ITR-1 ruled out: ${ruledOut ? ruledOut.rule.split(/[.;(]/)[0].trim() : "n/a"}`,
  ],
  tone: "ok",
});

// 2. Regime choice with real old-regime deductions (80C 1.5L + 80D 25K +
// 24(b) 2L = 3.75L).
const cmp = await call("compare_regimes", {
  salaryIncome: 1800000,
  deductions: 375000,
});
lines.push({
  cmd: "compare_regimes salary=18L deductions=3.75L",
  out: [
    `new ${rs(cmp.newRegime.totalTax)} vs old ${rs(cmp.oldRegime.totalTax)}`,
    `pick ${cmp.recommended}: saves ${rs(cmp.savings)}`,
  ],
  tone: "ok",
});

// 3. The 87A edge: 12.75L salary pays nothing, 1.25L of exempt LTCG on top
// pushes total income past 12L and the whole rebate goes.
const zero = await call("compute_tax", {
  regime: "new",
  salaryIncome: 1275000,
});
const edge = await call("compute_tax", {
  regime: "new",
  salaryIncome: 1275000,
  ltcg112A: 125000,
});
lines.push({
  cmd: "compute_tax salary=12.75L",
  out: [`tax ${rs(zero.totalTax)} (87A rebate ${rs(zero.rebate87A)})`],
  tone: "ok",
});
lines.push({
  cmd: "compute_tax salary=12.75L ltcg=1.25L",
  out: [
    `tax ${rs(edge.totalTax)}: total income ${rs(edge.totalIncome)} loses 87A`,
  ],
  tone: "warn",
});

// 4. Advance tax on the gap TDS does not cover.
const plan = await call("schedule_advance_tax", {
  estimatedTax: 240000,
  tdsExpected: 180000,
});
lines.push({
  cmd: "schedule_advance_tax tax=2.4L tds=1.8L",
  out: [
    plan.installments
      .map((i) => `${month(i.dueDate)} ${rs(i.installmentAmount)}`)
      .join(" | "),
  ],
  tone: "ok",
});
await client.close();

for (const l of lines) {
  console.log(`> ${l.cmd}`);
  for (const o of l.out) console.log(`  ${o}`);
}

const i = process.argv.indexOf("--svg-data");
if (i !== -1) {
  const file = process.argv[i + 1];
  writeFileSync(
    file,
    `${JSON.stringify({ title: "itr-agent over stdio", prompt: ">", lines }, null, 2)}\n`,
  );
  console.error(`wrote ${file}`);
}
