import { isUtf8 } from "node:buffer";
import { createDecipheriv, pbkdf2Sync } from "node:crypto";

/** AIS (Annual Information Statement) JSON parser.
 *
 * The portal's "Download AIS-JSON" export is AES-256-CBC encrypted:
 *   bytes[0:32]  hex-encoded 16-byte IV
 *   bytes[32:64] hex-encoded 16-byte PBKDF2 salt
 *   rest         base64 (or hex) ciphertext
 *   key          PBKDF2-HMAC-SHA256(password, salt, 1000 iters, 32 bytes)
 *
 * The password embeds a fixed app pepper between PAN and DOB. The pepper is
 * reverse-engineered from the AIS utility (verified across 4 independent OSS
 * implementations), NOT ITD-documented -- it can rotate. Un-peppered variants
 * stay in the try-list as a fallback, and `password` overrides everything.
 */

const AIS_PEPPER = "GQ39%*g";

export class AisDecryptError extends Error {}

function passwordCandidates(pan: string, dob: string): string[] {
  const dob8 = dob.replace(/[-/]/g, "");
  return [
    pan.toLowerCase() + AIS_PEPPER + dob8,
    pan.toLowerCase() + dob8,
    pan.toUpperCase() + dob8,
    pan.toUpperCase() + AIS_PEPPER + dob8,
  ];
}

/** Decrypt an AIS JSON export. Throws AisDecryptError with an actionable
 * message when every candidate fails. */
export function decryptAis(
  fileText: string,
  opts: { pan?: string; dob?: string; password?: string },
): unknown {
  let k = fileText.trim();
  // Some exports wrap the payload as a JSON string literal.
  if (k.startsWith('"')) {
    try {
      k = JSON.parse(k) as string;
    } catch {
      // leave as-is
    }
  }

  if (k.length < 96) {
    throw new AisDecryptError(
      "file too short to be an encrypted AIS JSON export (expected hex IV + hex salt + ciphertext)",
    );
  }

  if (!/^[0-9a-fA-F]{64}/.test(k)) {
    throw new AisDecryptError(
      "the file does not start with a 64-character hex IV + salt header. This is not the encrypted AIS JSON: download it from the portal via AIS > Download > JSON (not the PDF or the CSV).",
    );
  }

  const iv = Buffer.from(k.slice(0, 32), "hex");
  const salt = Buffer.from(k.slice(32, 64), "hex");
  const tail = k.slice(64);
  if (iv.length !== 16 || salt.length !== 16) {
    throw new AisDecryptError(
      "IV/salt header is not 16 bytes each after hex decoding -- the export looks truncated; download it again.",
    );
  }

  // A pure-hex string also passes the base64 charset test -- try both decodings.
  const ctCandidates: Buffer[] = [];
  if (/^[A-Za-z0-9+/\r\n]+=*$/.test(tail)) {
    ctCandidates.push(Buffer.from(tail.replace(/[\r\n]/g, ""), "base64"));
  }
  if (/^[0-9a-fA-F\r\n]+$/.test(tail)) {
    ctCandidates.push(Buffer.from(tail.replace(/[\r\n]/g, ""), "hex"));
  }
  if (ctCandidates.length === 0) {
    throw new AisDecryptError(
      "ciphertext is neither base64 nor hex -- is this the AIS JSON download?",
    );
  }

  const passwords = opts.password
    ? [opts.password]
    : opts.pan && opts.dob
      ? passwordCandidates(opts.pan, opts.dob)
      : null;
  if (!passwords) {
    throw new AisDecryptError(
      "provide either `password`, or `pan` + `dob` (DDMMYYYY) to derive it",
    );
  }

  // Distinguish the two failure modes: a bad password fails the AES padding
  // check, whereas a good password that yields non-JSON means the payload
  // format moved. The remedies are completely different, so do not collapse
  // them into one message.
  let decryptedButNotJson = false;
  for (const pw of passwords) {
    const key = pbkdf2Sync(pw, salt, 1000, 32, "sha256");
    for (const ct of ctCandidates) {
      let plainBytes: Buffer;
      try {
        const d = createDecipheriv("aes-256-cbc", key, iv);
        plainBytes = Buffer.concat([d.update(ct), d.final()]);
      } catch {
        continue; // wrong key or wrong ciphertext encoding
      }
      const plaintext = plainBytes.toString("utf8");
      try {
        return JSON.parse(plaintext) as unknown;
      } catch {
        // AES-CBC accepts a wrong key whenever the trailing bytes happen to
        // form valid PKCS#7 padding (~1 in 255 per candidate), and ~2 in 256
        // of those garbage plaintexts still open with '{' or '[' -- so the
        // first-character sniff alone misreported a wrong key as "the format
        // changed" about once per 33k candidates, which a 400-DOB test sweep
        // hit every ~20 runs. Uniform random bytes are almost surely not valid
        // UTF-8, so demand a payload that decodes cleanly end to end AND
        // starts like JSON before claiming the export format moved; anything
        // else is just a wrong key.
        if (/^\s*[[{]/.test(plaintext) && isUtf8(plainBytes)) {
          decryptedButNotJson = true;
        }
      }
    }
  }

  if (decryptedButNotJson) {
    throw new AisDecryptError(
      "the password decrypted the file but the payload is not JSON -- the AIS export format has changed. Use the portal's CSV export for now and file an issue at https://github.com/Sagargupta16/itr-agent/issues with the AIS download date.",
    );
  }
  if (opts.password) {
    throw new AisDecryptError(
      "the supplied `password` did not decrypt the file. The AIS password is your PAN in lower case followed by your date of birth as DDMMYYYY (with no separator); omit `password` and pass `pan` + `dob` to let the tool derive every known variant.",
    );
  }
  throw new AisDecryptError(
    `decryption failed with all ${passwords.length} derived password candidates. Check that the DOB matches the one on the PAN (DDMMYYYY, date of incorporation for non-individuals) and that the file is this PAN's own AIS. If both are right, the password scheme has rotated: pass \`password\` explicitly, or use the CSV export and file an issue.`,
  );
}

// ---------------------------------------------------------------------------
// Decrypted-document normalization
// ---------------------------------------------------------------------------

/** Labels appear both as plain strings and as {name} objects. */
type AisLabel = string | { name?: string };

interface AisColumnTable {
  columnLabel?: AisLabel[];
  columnData?: unknown[][];
}

interface AisElement extends AisColumnTable {
  title?: string;
  l1Src?: string;
  l2Src?: string;
  l1?: AisColumnTable;
  l2?: AisColumnTable;
}

interface AisSection {
  title?: string;
  elements?: AisElement[];
}

export interface AisRow {
  sectionTitle: string;
  elementTitle: string;
  source: string;
  /** Which table level the row came from (l1/l2/element). */
  level: "l1" | "l2" | "element";
  fields: Record<string, string>;
  amount?: number;
  date?: string;
  code?: string;
}

export interface AisParsed {
  taxpayer: Record<string, string>;
  rows: AisRow[];
  warnings: string[];
}

function labelText(l: AisLabel): string {
  return typeof l === "string" ? l : (l.name ?? "");
}

/** Read a column table defensively: the AIS JSON is not schema-validated by
 * anyone, so every field can be absent, null, or the wrong type. Layout
 * surprises must degrade to fewer rows, never to a throw. */
function tableRows(
  table: AisColumnTable | undefined,
): Record<string, string>[] {
  if (!table || typeof table !== "object") return [];
  const rawLabels = table.columnLabel;
  const rawData = table.columnData;
  if (!Array.isArray(rawLabels) || !Array.isArray(rawData)) return [];
  const labels = rawLabels.map((l) =>
    l === null || l === undefined ? "" : labelText(l),
  );
  const out: Record<string, string>[] = [];
  for (const row of rawData) {
    if (!Array.isArray(row)) continue;
    const record: Record<string, string> = {};
    // Walk the ROW, not the label list. A hostile file can declare 200k labels
    // against 200k one-cell rows; iterating labels per row makes that
    // O(labels x rows) and a 3.5 MB file then blocks the single-threaded stdio
    // server for ~97s. Cells beyond the row's own length carry no data anyway.
    const width = Math.min(row.length, labels.length);
    for (let i = 0; i < width; i++) {
      const label = labels[i];
      const v = row[i];
      if (label && v !== null && v !== undefined && v !== "")
        record[label] = String(v);
    }
    if (Object.keys(record).length > 0) out.push(record);
  }
  return out;
}

const AMOUNT_RE = /amount|value/i;
const DATE_RE = /date/i;
const CODE_RE = /information code|sft code|^section$/i;

function enrich(
  row: Record<string, string>,
): Pick<AisRow, "amount" | "date" | "code"> {
  const out: { amount?: number; date?: string; code?: string } = {};
  for (const [label, value] of Object.entries(row)) {
    if (out.amount === undefined && AMOUNT_RE.test(label)) {
      const n = Number.parseFloat(value.replace(/[,\s]/g, ""));
      if (Number.isFinite(n)) out.amount = n;
    }
    if (out.date === undefined && DATE_RE.test(label)) out.date = value;
    if (out.code === undefined && CODE_RE.test(label)) out.code = value;
  }
  return out;
}

/** Normalize a decrypted AIS document into flat rows. Field identity comes
 * from columnLabel strings, matched by regex -- never by position. */
export function parseAisDocument(doc: unknown): AisParsed {
  const warnings: string[] = [];
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    return {
      taxpayer: {},
      rows: [],
      warnings: [
        "decrypted payload is not a JSON object -- nothing to normalize. Check the AIS download, and use the CSV export as a fallback.",
      ],
    };
  }
  const d = doc as {
    partA?: AisColumnTable;
    partB?: { sections?: AisSection[] };
  };

  const taxpayer: Record<string, string> = {};
  const partARows = tableRows(d.partA);
  if (partARows.length === 1 && partARows[0]) {
    Object.assign(taxpayer, partARows[0]);
  } else if (partARows.length > 1) {
    // Some exports transpose partA as Field/Value pairs.
    for (const row of partARows) {
      const values = Object.values(row);
      if (values.length === 2 && values[0] && values[1])
        taxpayer[values[0]] = values[1];
      else Object.assign(taxpayer, row);
    }
  } else {
    warnings.push("partA (taxpayer info) not found or empty");
  }

  const rows: AisRow[] = [];
  const rawSections = d.partB?.sections;
  const sections = Array.isArray(rawSections) ? rawSections : [];
  if (!Array.isArray(rawSections) && rawSections !== undefined) {
    warnings.push("partB.sections is not an array -- unexpected AIS layout");
  }
  if (sections.length === 0)
    warnings.push("partB.sections is empty -- no information rows");

  for (const section of sections) {
    if (!section || typeof section !== "object") continue;
    const elements = Array.isArray(section.elements) ? section.elements : [];
    for (const element of elements) {
      if (!element || typeof element !== "object") continue;
      const levels: [
        "l1" | "l2" | "element",
        AisColumnTable | undefined,
        string,
      ][] = [
        ["l1", element.l1, element.l1Src ?? ""],
        ["l2", element.l2, element.l2Src ?? ""],
        ["element", element.l1 || element.l2 ? undefined : element, ""],
      ];
      for (const [level, table, src] of levels) {
        for (const fields of tableRows(table)) {
          rows.push({
            sectionTitle: section.title ?? "",
            elementTitle: element.title ?? "",
            source: src,
            level,
            fields,
            ...enrich(fields),
          });
        }
      }
    }
  }

  return { taxpayer, rows, warnings };
}
