// Builds the one-click Claude Desktop bundle: build/itr-agent-<version>.mcpb.
//
// The npm build keeps @modelcontextprotocol/sdk and zod external because npm
// installs them. A .mcpb has no install step, so this build inlines every
// dependency into one file, stages it next to data/ and a minimal
// package.json (rulepack.ts resolves both relative to the entry), generates
// manifest.json from package.json plus the server's own tools/list and
// prompts/list, validates it with the official mcpb CLI, and packs it.
//
// The stage lives in the OS temp dir, not under the repo, so when the script
// boots the staged server to read its tools and compute one figure, there is
// no node_modules above it to resolve from: a dependency the bundle failed to
// inline fails here instead of on a user's machine.
//
//   node scripts/build-mcpb.mjs
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { build } from "tsup";

// Pinned: the CLI is fetched on demand rather than added as a devDependency,
// because its interactive `init` pulls in a prompt library tree that carries
// open advisories, and this script only needs `validate` and `pack`.
const MCPB_CLI = "@anthropic-ai/mcpb@2.1.2";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const outDir = join(root, "build");
const stage = mkdtempSync(join(tmpdir(), "itr-agent-mcpb-"));
const bundlePath = join(outDir, `itr-agent-${pkg.version}.mcpb`);

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

await build({
  entry: { index: join(root, "src", "index.ts") },
  outDir: join(stage, "server"),
  format: ["esm"],
  target: "node22",
  platform: "node",
  noExternal: [/.*/],
  // CommonJS dependencies (ajv, via the SDK) call require() on Node builtins;
  // an ESM bundle has no require unless one is created.
  banner: {
    js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
  },
  clean: true,
  dts: false,
  silent: true,
  config: false,
});

cpSync(join(root, "data"), join(stage, "data"), { recursive: true });
cpSync(join(root, "LICENSE"), join(stage, "LICENSE"));
writeFileSync(
  join(stage, "package.json"),
  `${JSON.stringify(
    { name: pkg.name, version: pkg.version, type: "module", private: true },
    null,
    2,
  )}\n`,
);

// Ask the staged server what it exposes, so the manifest can never list a tool
// that does not exist (or miss one that does).
const client = new Client({ name: "itr-agent-mcpb", version: "0" });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [join(stage, "server", "index.js")],
    cwd: stage,
    stderr: "ignore",
  }),
);
const { tools } = await client.listTools();
const { prompts } = await client.listPrompts();
const promptEntries = [];
for (const p of prompts) {
  const got = await client.getPrompt({ name: p.name });
  const text = got.messages
    .map((m) => (m.content.type === "text" ? m.content.text : ""))
    .join("\n");
  promptEntries.push({ name: p.name, description: p.description, text });
}
const smoke = await client.callTool({
  name: "compute_tax",
  arguments: { regime: "new", otherIncome: 1500000 },
});
await client.close();
if (smoke.structuredContent?.totalTax !== 109200) {
  throw new Error(
    `bundled server computed ${smoke.structuredContent?.totalTax}, expected 109200`,
  );
}

const firstSentence = (s) => {
  const end = s.search(/\.(\s|$)/);
  return end === -1 ? s : s.slice(0, end + 1);
};
const repo = "https://github.com/Sagargupta16/itr-agent";
const manifest = {
  $schema:
    "https://raw.githubusercontent.com/modelcontextprotocol/mcpb/main/dist/mcpb-manifest-v0.2.schema.json",
  manifest_version: "0.2",
  name: pkg.name,
  display_name: "itr-agent: Indian income tax",
  version: pkg.version,
  description: pkg.description,
  long_description:
    "Claude interviews you one question at a time, picks your ITR form, computes FY 2025-26 tax with deterministic code over a versioned rule pack, parses Form 26AS and AIS, and reconciles them before you file. Runs entirely on your machine over stdio: no network calls, no accounts, no telemetry. It never files anything; you submit the return on incometax.gov.in. Not tax advice.",
  author: { name: "Sagar Gupta", url: "https://github.com/Sagargupta16" },
  repository: { type: "git", url: repo },
  homepage: repo,
  documentation: `${repo}#readme`,
  support: `${repo}/issues`,
  license: pkg.license,
  keywords: pkg.keywords,
  server: {
    type: "node",
    entry_point: "server/index.js",
    mcp_config: {
      command: "node",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: mcpb substitutes ${__dirname} at install time
      args: ["${__dirname}/server/index.js"],
    },
  },
  compatibility: {
    platforms: ["darwin", "win32", "linux"],
    runtimes: { node: pkg.engines.node },
  },
  tools: tools.map((t) => ({
    name: t.name,
    description: firstSentence(t.description ?? ""),
  })),
  prompts: promptEntries,
};
writeFileSync(
  join(stage, "manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);

const mcpb = (...args) => {
  // One command string through the shell: pnpm is a .cmd shim on Windows,
  // which Node only spawns via a shell. Every argument is a path this script
  // built, so quoting them is enough.
  const cmd = ["pnpm", "dlx", MCPB_CLI, ...args.map((a) => `"${a}"`)].join(" ");
  const r = spawnSync(cmd, { cwd: root, stdio: "inherit", shell: true });
  if (r.status !== 0) {
    throw new Error(`mcpb ${args[0]} failed with exit code ${r.status}`);
  }
};
mcpb("validate", join(stage, "manifest.json"));
mcpb("pack", stage, bundlePath);
rmSync(stage, { recursive: true, force: true });

console.log(
  `built ${bundlePath} (${tools.length} tools, ${promptEntries.length} prompt; bundled server computes 1,09,200 on 15L)`,
);
