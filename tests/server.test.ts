import { createCipheriv, pbkdf2Sync, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
      expect(text).toContain("ABCXXXXXF");
      expect(text).not.toContain("ABCDE1234F");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("parse_form26as names the problem when handed a directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "itr-dir-"));
    try {
      const client = await connectedClient();
      const result = await client.callTool({
        name: "parse_form26as",
        arguments: { path: dir },
      });
      expect(result.isError).toBeTruthy();
      expect(JSON.stringify(result.content)).toContain("is a directory");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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

    const interest = await client.callTool({
      name: "compute_interest_234",
      arguments: {
        assessedTax: 100000,
        advanceTaxPaid: 0,
        monthsFor234B: 4,
      },
    });
    expect(interest.isError).toBeFalsy();
    expect(
      (interest.structuredContent as { section234B: { interest: number } })
        .section234B.interest,
    ).toBe(4000);

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
