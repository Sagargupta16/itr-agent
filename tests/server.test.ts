import { createCipheriv, pbkdf2Sync, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";

async function connectedClient() {
  const server = createServer();
  const client = new Client({ name: "test", version: "0.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return client;
}

describe("itr-agent server", () => {
  it("lists all twelve tools", async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "compare_regimes",
      "compute_hra",
      "compute_interest_234",
      "compute_tax",
      "filing_checklist",
      "list_deductions",
      "list_tax_years",
      "parse_ais",
      "parse_form26as",
      "recommend_itr_form",
      "reconcile_documents",
      "schedule_advance_tax",
    ]);
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint).toBe(true);
    }
  });

  it("compute_tax returns structured content", async () => {
    const client = await connectedClient();
    const result = await client.callTool({
      name: "compute_tax",
      arguments: { regime: "new", salaryIncome: 1275000 },
    });
    expect(result.isError).toBeFalsy();
    const sc = result.structuredContent as { totalTax: number; fy: string };
    expect(sc.totalTax).toBe(0);
    expect(sc.fy).toBe("2025-26");
  });

  it("compare_regimes recommends a winner", async () => {
    const client = await connectedClient();
    const result = await client.callTool({
      name: "compare_regimes",
      arguments: { salaryIncome: 1500000, deductions: 200000 },
    });
    const sc = result.structuredContent as {
      recommended: string;
      savings: number;
    };
    expect(["new", "old"]).toContain(sc.recommended);
    expect(sc.savings).toBeGreaterThanOrEqual(0);
  });

  it("compare_regimes honours employer NPS in BOTH regimes (the README example)", async () => {
    // 18L CTC with 50K employer NPS: the new regime used to ignore it.
    const client = await connectedClient();
    const result = await client.callTool({
      name: "compare_regimes",
      arguments: { salaryIncome: 1800000, employerNps80CCD2: 50000 },
    });
    const sc = result.structuredContent as {
      newRegime: {
        employerNps80CCD2Allowed: number;
        taxableNormalIncome: number;
      };
      oldRegime: { employerNps80CCD2Allowed: number };
    };
    expect(sc.newRegime.employerNps80CCD2Allowed).toBe(50000);
    expect(sc.newRegime.taxableNormalIncome).toBe(1675000);
    expect(sc.oldRegime.employerNps80CCD2Allowed).toBe(50000);
  });

  it("recommend_itr_form accepts the presumptive and 194N inputs", async () => {
    const client = await connectedClient();
    const result = await client.callTool({
      name: "recommend_itr_form",
      arguments: {
        totalIncome: 1200000,
        hasBusinessIncome: true,
        presumptive: true,
        presumptiveScheme: "44ADA",
        presumptiveTurnover: 6000000,
      },
    });
    const sc = result.structuredContent as {
      recommended: string;
      dueDateCitation: string;
    };
    expect(sc.recommended).toBe("ITR-3");
    expect(sc.dueDateCitation).toContain("Finance Act 2026");
  });

  it("unknown fiscal year is a tool error, not a crash", async () => {
    const client = await connectedClient();
    const result = await client.callTool({
      name: "compute_tax",
      arguments: { regime: "new", salaryIncome: 100000, fy: "1999-00" },
    });
    expect(result.isError).toBe(true);
  });

  it("parse_form26as fails actionably on a missing file", async () => {
    const client = await connectedClient();
    const result = await client.callTool({
      name: "parse_form26as",
      arguments: { path: "Z:/does/not/exist.txt" },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as { text: string }[])[0]?.text ?? "";
    expect(text).toContain("TRACES Text export");
  });

  it("recommend_itr_form returns structured content with reasoning", async () => {
    const client = await connectedClient();
    const result = await client.callTool({
      name: "recommend_itr_form",
      arguments: { totalIncome: 1800000, hasForeignAssetsOrIncome: true },
    });
    expect(result.isError).toBeFalsy();
    const sc = result.structuredContent as {
      recommended: string;
      ruledOut: { form: string; rule: string }[];
      dueDate: string;
    };
    expect(sc.recommended).toBe("ITR-2");
    expect(sc.ruledOut.length).toBeGreaterThan(0);
    expect(sc.dueDate).toBe("2026-07-31");
  });

  it("filing_checklist returns ordered steps for the form", async () => {
    const client = await connectedClient();
    const result = await client.callTool({
      name: "filing_checklist",
      arguments: { form: "ITR-2" },
    });
    expect(result.isError).toBeFalsy();
    const sc = result.structuredContent as {
      form: string;
      steps: { step: number; phase: string }[];
    };
    expect(sc.form).toBe("ITR-2");
    expect(sc.steps[0]?.step).toBe(1);
    expect(sc.steps.at(-1)?.phase).toBe("verify");
  });

  it("rejects an income above the rupee ceiling instead of returning null tax", async () => {
    // 1e308 used to pass validation and overflow the income sum to Infinity,
    // which JSON.stringify serializes as null -- so the tool reported SUCCESS
    // with every figure (totalTax included) null.
    const client = await connectedClient();
    const result = await client.callTool({
      name: "compute_tax",
      arguments: { regime: "new", salaryIncome: 1e308, otherIncome: 1e308 },
    });
    expect(result.isError).toBeTruthy();
  });

  it("parse_form26as masks PAN in text but not in structuredContent", async () => {
    // The documented PII contract: the human-readable mirror is masked, the
    // structured payload keeps the real PAN because downstream tools need it.
    const dir = await mkdtemp(join(tmpdir(), "itr-26as-"));
    const file = join(dir, "26AS.txt");
    await writeFile(
      file,
      [
        "Permanent Account Number (PAN) of the Assessee: ABCDE1234F",
        "PART I - Details of Tax Deducted at Source",
        "1^ABCD12345E^ACME LTD^",
        "^^^192^31-Mar-2026^F^500000.00^50000.00^50000.00^",
      ].join("\n"),
      "utf8",
    );
    try {
      const client = await connectedClient();
      const result = await client.callTool({
        name: "parse_form26as",
        arguments: { path: file },
      });
      expect(result.isError).toBeFalsy();
      const sc = result.structuredContent as {
        pan: string | null;
        totalTdsDeposited: number;
      };
      expect(sc.pan).toBe("ABCDE1234F");
      expect(sc.totalTdsDeposited).toBe(50000);
      const text = Array.isArray(result.content)
        ? JSON.stringify(result.content)
        : "";
      expect(text).toContain("ABCXXXXXXF");
      expect(text).not.toContain("ABCDE1234F");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("parse_form26as names the problem when handed a directory", async () => {
    // The directory carries a .txt suffix so it clears the extension gate and
    // reaches the stat() branch this test is about.
    const dir = await mkdtemp(join(tmpdir(), "itr-dir-"));
    const asTxt = join(dir, "26AS.txt");
    await mkdir(asTxt);
    try {
      const client = await connectedClient();
      const result = await client.callTool({
        name: "parse_form26as",
        arguments: { path: asTxt },
      });
      expect(result.isError).toBeTruthy();
      expect(JSON.stringify(result.content)).toContain("is a directory");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("parsers refuse paths outside their extension allow-list and dotfiles", async () => {
    const client = await connectedClient();
    for (const path of ["C:/Users/x/.ssh/id_rsa", "/etc/passwd", "C:/x/.env"]) {
      const result = await client.callTool({
        name: "parse_form26as",
        arguments: { path },
      });
      expect(result.isError).toBeTruthy();
      expect(JSON.stringify(result.content)).toContain("refusing to read");
    }
    const ais = await client.callTool({
      name: "parse_ais",
      arguments: { path: "C:/x/AIS.pdf", pan: "ABCDE1234F", dob: "01011990" },
    });
    expect(ais.isError).toBeTruthy();
    expect(JSON.stringify(ais.content)).toContain(".json");
  });

  it("reports the package.json version, not a hardcoded one", async () => {
    const server = createServer();
    const client = new Client({ name: "test", version: "0.0.0" });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(s), client.connect(c)]);
    const pkg = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    expect(client.getServerVersion()?.version).toBe(pkg.version);
  });

  it("list_tax_years reports the supported years and deadlines", async () => {
    const client = await connectedClient();
    const result = await client.callTool({
      name: "list_tax_years",
      arguments: {},
    });
    expect(result.isError).toBeFalsy();
    const sc = result.structuredContent as {
      supported: string[];
      default: string;
      deadlines: Record<string, string>;
      rulePackVersion: string;
    };
    expect(sc.supported).toContain("2025-26");
    expect(sc.default).toBe("2025-26");
    expect(sc.rulePackVersion).toBeTruthy();
    expect(Object.keys(sc.deadlines).length).toBeGreaterThan(0);
  });

  it("parse_ais decrypts on-device and masks PAN in the text mirror", async () => {
    const doc = {
      partA: {
        columnLabel: ["Name", "PAN"],
        columnData: [["Test User", "ABCDE1234F"]],
      },
      partB: {
        sections: [
          {
            title: "TDS/TCS Information",
            elements: [
              {
                title: "Salary (Section 192)",
                l1Src: "EMPLOYER LTD",
                l1: {
                  columnLabel: [
                    "TAN",
                    "Amount Paid/Credited",
                    "Date",
                    "Remark",
                  ],
                  columnData: [
                    [
                      "ABCD12345E",
                      "1500000",
                      "2026-03-31",
                      // Lower case on purpose: the parser does not normalize
                      // case, so an uppercase-only mask would leak this one.
                      "reported against zzzzz9999z",
                    ],
                  ],
                },
              },
            ],
          },
        ],
      },
    };
    const iv = randomBytes(16);
    const salt = randomBytes(16);
    const key = pbkdf2Sync(
      "abcde1234fGQ39%*g01011990",
      salt,
      1000,
      32,
      "sha256",
    );
    const cipher = createCipheriv("aes-256-cbc", key, iv);
    const blob =
      iv.toString("hex") +
      salt.toString("hex") +
      Buffer.concat([
        cipher.update(JSON.stringify(doc), "utf8"),
        cipher.final(),
      ]).toString("base64");

    const dir = await mkdtemp(join(tmpdir(), "itr-ais-"));
    const file = join(dir, "AIS.json");
    await writeFile(file, blob, "utf8");
    try {
      const client = await connectedClient();
      const result = await client.callTool({
        name: "parse_ais",
        arguments: { path: file, pan: "ABCDE1234F", dob: "01011990" },
      });
      expect(result.isError).toBeFalsy();
      const sc = result.structuredContent as {
        taxpayer: Record<string, string>;
        rows: { amount?: number; source: string }[];
      };
      expect(sc.taxpayer.PAN).toBe("ABCDE1234F");
      expect(sc.rows[0]?.amount).toBe(1500000);
      expect(sc.rows[0]?.source).toBe("EMPLOYER LTD");
      const text = JSON.stringify(result.content);
      expect(text).toContain("ABCXXXXXXF");
      expect(text).not.toContain("ABCDE1234F");
      expect(text).toContain("zzzXXXXXXz");
      expect(text).not.toContain("zzzzz9999z");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("parse_ais blames the DOB, not the format, on a wrong password", async () => {
    const dir = await mkdtemp(join(tmpdir(), "itr-ais-bad-"));
    const file = join(dir, "AIS.json");
    // Valid hex IV + salt header so the failure lands on the decrypt step
    // rather than the header sniff.
    await writeFile(
      file,
      "0".repeat(64) + randomBytes(64).toString("base64"),
      "utf8",
    );
    try {
      const client = await connectedClient();
      const result = await client.callTool({
        name: "parse_ais",
        arguments: { path: file, pan: "ABCDE1234F", dob: "01011990" },
      });
      expect(result.isError).toBe(true);
      const text = JSON.stringify(result.content);
      expect(text).not.toContain("format has changed");
      expect(text).toContain("DOB");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // An ISO date strips to "19900115", which derives four wrong passwords and
  // surfaces as "the export format has changed" -- a scheme-rotation report for
  // what is really a format slip. Reject it where the message can name the fix.
  it("parse_ais rejects an ISO date of birth at the tool boundary", async () => {
    const dir = await mkdtemp(join(tmpdir(), "itr-ais-iso-"));
    const file = join(dir, "AIS.json");
    await writeFile(file, "0".repeat(64), "utf8");
    try {
      const client = await connectedClient();
      const result = await client.callTool({
        name: "parse_ais",
        arguments: { path: file, pan: "ABCDE1234F", dob: "1990-01-15" },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("DDMMYYYY");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("list_deductions and schedule_advance_tax round trip", async () => {
    const client = await connectedClient();

    const ded = await client.callTool({
      name: "list_deductions",
      arguments: {},
    });
    expect(ded.isError).toBeFalsy();
    const dedSc = ded.structuredContent as {
      fy: string;
      caps: Record<string, unknown>;
      hraMetros: string[];
    };
    expect(dedSc.fy).toBe("2025-26");
    expect(dedSc.caps["80C"]).toBe(150000);
    expect(dedSc.caps["80CCD1B"]).toBe(50000);
    expect(dedSc.hraMetros.length).toBe(4);

    const plan = await client.callTool({
      name: "schedule_advance_tax",
      arguments: { estimatedTax: 100000, tdsExpected: 0 },
    });
    expect(plan.isError).toBeFalsy();
    const planSc = plan.structuredContent as {
      installments: {
        dueDate: string;
        cumulativePct: number;
        cumulativeDue: number;
        installmentAmount: number;
      }[];
    };
    expect(planSc.installments.length).toBe(4);
    // 15/45/75/100% of the net liability, in absolute rupees.
    expect(planSc.installments.map((i) => i.cumulativeDue)).toEqual([
      15000, 45000, 75000, 100000,
    ]);
    expect(planSc.installments.at(-1)?.cumulativePct).toBe(1);
    // The March installment falls in the NEXT calendar year.
    expect(planSc.installments[0]?.dueDate).toBe("2025-06-15");
    expect(planSc.installments.at(-1)?.dueDate).toBe("2026-03-15");
  });

  it("compute_hra, compute_interest_234 and reconcile_documents round trip", async () => {
    const client = await connectedClient();

    const hra = await client.callTool({
      name: "compute_hra",
      arguments: {
        periods: [
          {
            months: 12,
            basic: 600000,
            hraReceived: 300000,
            rentPaid: 360000,
            isMetro: true,
          },
        ],
      },
    });
    expect(hra.isError).toBeFalsy();
    expect((hra.structuredContent as { totalExempt: number }).totalExempt).toBe(
      300000,
    );

    // 80GG alone: no dummy HRA period needed any more.
    const gg = await client.callTool({
      name: "compute_hra",
      arguments: {
        eightyGG: { rentPaid: 200000, adjustedTotalIncome: 1000000 },
      },
    });
    expect(gg.isError).toBeFalsy();
    expect((gg.structuredContent as { deduction: number }).deduction).toBe(
      60000,
    );
    const neither = await client.callTool({
      name: "compute_hra",
      arguments: {},
    });
    expect(neither.isError).toBeTruthy();

    const interest = await client.callTool({
      name: "compute_interest_234",
      arguments: {
        assessedTax: 100000,
        advanceTaxPaid: 0,
        monthsFor234B: 4,
        monthsLateFiling: 2,
        taxOutstandingFor234A: 50000,
      },
    });
    expect(interest.isError).toBeFalsy();
    const isc = interest.structuredContent as {
      section234A: { interest: number };
      section234B: { interest: number };
    };
    expect(isc.section234B.interest).toBe(4000);
    expect(isc.section234A.interest).toBe(1000);

    // The misspelt legacy name still works.
    const legacy = await client.callTool({
      name: "compute_interest_234",
      arguments: {
        assessedTax: 100000,
        advanceTaxPaid: 0,
        monthsFor234B: 4,
        monthsLateFiling: 2,
        taxOutstandingForms234A: 50000,
      },
    });
    expect(
      (legacy.structuredContent as { section234A: { interest: number } })
        .section234A.interest,
    ).toBe(1000);

    const rec = await client.callTool({
      name: "reconcile_documents",
      arguments: {
        form26asTds: [
          {
            tan: "ABCD12345E",
            section: "192",
            amountPaid: 1000000,
            tdsDeposited: 90000,
          },
        ],
        return: { tdsClaimed: 120000 },
      },
    });
    expect(rec.isError).toBeFalsy();
    const recSc = rec.structuredContent as {
      findings: { id: string; severity: string }[];
    };
    expect(recSc.findings.map((f) => f.id)).toContain("H1");
  });

  it("reconcile_documents rejects an oversized TDS array", async () => {
    // The LLM composes these arrays, so a mis-scaled call is the realistic
    // path to an unbounded O(form16 x tds26) reconcile.
    const client = await connectedClient();
    const result = await client.callTool({
      name: "reconcile_documents",
      arguments: {
        form26asTds: Array.from({ length: 2001 }, () => ({
          tan: "ABCD12345E",
          amountPaid: 1,
          tdsDeposited: 1,
        })),
      },
    });
    expect(result.isError).toBeTruthy();
  });

  it("exposes the file_my_itr guided prompt", async () => {
    const client = await connectedClient();
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toContain("file_my_itr");
    const prompt = await client.getPrompt({
      name: "file_my_itr",
      arguments: {},
    });
    const text =
      prompt.messages[0]?.content.type === "text"
        ? prompt.messages[0].content.text
        : "";
    expect(text).toContain("ONE question at a time");
    expect(text).toContain("never file on my behalf");
  });
});

/** Encrypt a synthetic AIS document the way the portal export is laid out. */
function encryptAis(doc: unknown): string {
  const iv = randomBytes(16);
  const salt = randomBytes(16);
  const key = pbkdf2Sync("abcde1234fGQ39%*g01011990", salt, 1000, 32, "sha256");
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  return (
    iv.toString("hex") +
    salt.toString("hex") +
    Buffer.concat([
      cipher.update(JSON.stringify(doc), "utf8"),
      cipher.final(),
    ]).toString("base64")
  );
}

const SYNTHETIC_AIS = {
  partA: { columnLabel: ["Name", "PAN"], columnData: [["Test", "ABCDE1234F"]] },
  partB: {
    sections: [
      {
        title: "TDS/TCS Information",
        elements: [
          {
            title: "Salary",
            l1: {
              columnLabel: ["TAN", "Section", "Amount Paid/Credited"],
              columnData: [
                ["ABCD12345E", "192", "900000"],
                ["ABCD12345E", "192", "600000"],
                // 192A is EPF withdrawal TDS, not salary.
                ["ABCD12345E", "192A", "50000"],
              ],
            },
          },
        ],
      },
      {
        title: "SFT Information",
        elements: [
          {
            title: "Interest from savings bank",
            l1: {
              columnLabel: ["Information Code", "Amount"],
              columnData: [
                ["SFT-016", "1200.50"],
                ["SFT-016", "800.25"],
              ],
            },
          },
        ],
      },
    ],
  },
};

describe("documents read by the tools, not copied by the model", () => {
  it("parse_ais sums groups and section-192 salary in code", async () => {
    const dir = await mkdtemp(join(tmpdir(), "itr-ais-totals-"));
    try {
      const path = join(dir, "ais.json");
      await writeFile(path, encryptAis(SYNTHETIC_AIS));
      const client = await connectedClient();
      const result = await client.callTool({
        name: "parse_ais",
        arguments: { path, pan: "ABCDE1234F", dob: "01011990" },
      });
      const sc = result.structuredContent as {
        totals: {
          groups: { key: string; rows: number; amount: number }[];
          salaryByTan: Record<string, number>;
        };
      };
      expect(sc.totals.salaryByTan).toEqual({ ABCD12345E: 1500000 });
      const interest = sc.totals.groups.find((g) =>
        g.key.includes("Interest from savings bank"),
      );
      expect(interest).toMatchObject({ rows: 2, amount: 2000.75 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reconcile_documents reads the 26AS and AIS files and sums the named groups", async () => {
    const dir = await mkdtemp(join(tmpdir(), "itr-reconcile-files-"));
    try {
      const ais = join(dir, "ais.json");
      await writeFile(ais, encryptAis(SYNTHETIC_AIS));
      const f26 = join(dir, "26as.txt");
      await writeFile(
        f26,
        [
          "Permanent Account Number (PAN) of the Assessee: ABCDE1234F",
          "PART I - Details of Tax Deducted at Source",
          "1^ABCD12345E^ACME LTD^",
          "^^^192^31-Mar-2026^F^15-Apr-2026^^1500000.00^150000.00^150000.00^",
        ].join("\n"),
      );
      const client = await connectedClient();
      const result = await client.callTool({
        name: "reconcile_documents",
        arguments: {
          form26asPath: f26,
          aisFile: {
            path: ais,
            pan: "ABCDE1234F",
            dob: "01011990",
            interestGroups: [
              "SFT Information | Interest from savings bank | SFT-016",
            ],
          },
          form16: [
            { tan: "ABCD12345E", grossSalary: 1500000, tdsDeposited: 150000 },
          ],
          return: { tdsClaimed: 160000, interestDeclared: 0 },
        },
      });
      expect(result.isError).toBeFalsy();
      const sc = result.structuredContent as {
        findings: { id: string; figures?: { a: number } }[];
        checksRun: string[];
        fromFiles: { form26as: { tdsRows: number } };
      };
      // H1: 1,60,000 claimed against 1,50,000 deposited in the 26AS file.
      expect(sc.findings.find((f) => f.id === "H1")?.figures?.a).toBe(160000);
      // H4: the named AIS interest group (1,200.50 + 800.25) against nil declared.
      expect(sc.findings.find((f) => f.id === "H4")?.figures?.a).toBe(2000.75);
      // M3 ran on the AIS section-192 salary and found it equal to Form 16.
      expect(sc.checksRun).toContain("M3");
      expect(sc.findings.some((f) => f.id === "M3")).toBe(false);
      expect(sc.fromFiles.form26as.tdsRows).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reconcile_documents names an AIS group key that does not exist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "itr-reconcile-badkey-"));
    try {
      const ais = join(dir, "ais.json");
      await writeFile(ais, encryptAis(SYNTHETIC_AIS));
      const client = await connectedClient();
      const result = await client.callTool({
        name: "reconcile_documents",
        arguments: {
          aisFile: {
            path: ais,
            pan: "ABCDE1234F",
            dob: "01011990",
            interestGroups: ["no such group"],
          },
        },
      });
      expect(result.isError).toBeTruthy();
      expect(JSON.stringify(result.content)).toContain("no group with key");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("inputs that used to need the model's own judgement or arithmetic", () => {
  it("compute_tax refuses a house-property loss without its type", async () => {
    const client = await connectedClient();
    const result = await client.callTool({
      name: "compute_tax",
      arguments: {
        regime: "old",
        salaryIncome: 1500000,
        housePropertyLoss: 300000,
      },
    });
    expect(result.isError).toBeTruthy();
    expect(JSON.stringify(result.content)).toContain("housePropertyType");
    const typed = await client.callTool({
      name: "compare_regimes",
      arguments: {
        salaryIncome: 1500000,
        housePropertyLoss: 300000,
        housePropertyType: "selfOccupied",
      },
    });
    const sc = typed.structuredContent as {
      newRegime: { housePropertyLossDisallowed: number };
      oldRegime: { housePropertyLossDisallowed: number };
    };
    expect(sc.newRegime.housePropertyLossDisallowed).toBe(300000);
    expect(sc.oldRegime.housePropertyLossDisallowed).toBe(100000);
  });

  it("compute_interest_234 counts the months from dates", async () => {
    const client = await connectedClient();
    const result = await client.callTool({
      name: "compute_interest_234",
      arguments: {
        assessedTax: 50000,
        filingDate: "2026-09-15",
        form: "ITR-2",
      },
    });
    const sc = result.structuredContent as {
      section234A: { months: number; interest: number };
      section234B: { months: number; interest: number };
      monthsUsed: Record<string, string>;
    };
    // 234A: due 31 July, interest from 1 August to 15 September = 2 months,
    // 1% of 50,000 x 2 = 1,000. 234B: 1 April to 15 September = 6 months,
    // nothing paid in advance, 1% x 50,000 x 6 = 3,000.
    expect(sc.section234A).toMatchObject({ months: 2, interest: 1000 });
    expect(sc.section234B).toMatchObject({ months: 6, interest: 3000 });
    expect(sc.monthsUsed.s234A).toContain("2026-08-01");
  });

  it("compute_interest_234 reads a self-assessment payment date", async () => {
    const client = await connectedClient();
    const result = await client.callTool({
      name: "compute_interest_234",
      arguments: {
        assessedTax: 50000,
        paidOrAssessedDate: "2026-09-15",
        selfAssessmentPayments: [{ date: "2026-06-10", amount: 30000 }],
      },
    });
    const sc = result.structuredContent as {
      section234B: {
        interest: number;
        segments: { months: number; base: number }[];
      };
    };
    // 3 months (Apr-Jun) on 50,000 = 1,500, then 3 months (Jul-Sep) on 20,000 = 600.
    expect(sc.section234B.segments.map((s) => [s.months, s.base])).toEqual([
      [3, 50000],
      [3, 20000],
    ]);
    expect(sc.section234B.interest).toBe(2100);
  });

  it("compute_interest_234 needs a 234B period one way or the other", async () => {
    const client = await connectedClient();
    const result = await client.callTool({
      name: "compute_interest_234",
      arguments: { assessedTax: 50000 },
    });
    expect(result.isError).toBeTruthy();
    expect(JSON.stringify(result.content)).toContain("paidOrAssessedDate");
  });

  it("compute_hra checks the city against the fy's metro list", async () => {
    const client = await connectedClient();
    const period = {
      months: 12,
      basic: 600000,
      hraReceived: 300000,
      rentPaid: 360000,
    };
    const metro = await client.callTool({
      name: "compute_hra",
      arguments: { periods: [{ ...period, city: "Bombay" }] },
    });
    const bengaluru = await client.callTool({
      name: "compute_hra",
      arguments: { periods: [{ ...period, city: "Bangalore" }] },
    });
    const m = metro.structuredContent as { periods: { limbC: number }[] };
    const b = bengaluru.structuredContent as {
      periods: { limbC: number }[];
      notes: string[];
    };
    // FY 2025-26 lists four metros; Bombay is Mumbai, Bengaluru is not on it.
    expect(m.periods[0]?.limbC).toBe(300000);
    expect(b.periods[0]?.limbC).toBe(240000);
    expect(b.notes.some((n) => n.includes("not on the FY 2025-26"))).toBe(true);
    const neither = await client.callTool({
      name: "compute_hra",
      arguments: { periods: [period] },
    });
    expect(neither.isError).toBeTruthy();
  });
});
