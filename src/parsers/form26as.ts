/** Parser for the caret-delimited Form 26AS text export from TRACES.
 * Users should download the "Text" format: it is the most machine-readable of
 * the three export formats. TRACES currently protects it with the date of
 * birth (DDMMYYYY) as the archive password; the extracted .txt itself is plain. */

/** TRACES booking status for a row. F = final (credit given); P = provisional
 * (government deductor, pending PAO verification); U = unmatched (challan not
 * found, no credit); O = overbooked (challan over-consumed, credit at risk).
 * Anything else is passed through verbatim. */
export type BookingStatus = "F" | "P" | "U" | "O" | string;

export interface TdsEntry {
  deductorName: string;
  tan: string;
  section: string;
  amountPaid: number;
  taxDeducted: number;
  tdsDeposited: number;
  /** True for correction/cancellation rows, which carry negative figures. */
  isCorrection: boolean;
  /** Booking status as printed. Only "F" is creditable at CPC. */
  status: BookingStatus | null;
}

/** Part VI rows: tax COLLECTED at source (206C), a separate credit that
 * belongs in Schedule TCS, not Schedule TDS. */
export interface TcsEntry {
  collectorName: string;
  tan: string;
  section: string;
  amountPaid: number;
  taxCollected: number;
  tcsDeposited: number;
  isCorrection: boolean;
  status: BookingStatus | null;
}

export interface Form26AS {
  pan: string | null;
  assessmentYear: string | null;
  /** Part I: TDS on salary and other payments, grouped by deductor. */
  tdsEntries: TdsEntry[];
  /** Part VI: TCS collected on the taxpayer's purchases/remittances. */
  tcsEntries: TcsEntry[];
  totalTdsDeposited: number;
  totalAmountPaid: number;
  totalTcsDeposited: number;
  /** Sum of `tdsDeposited` over rows whose status is "F" (or blank, for
   * exports that omit the column). This is the figure CPC will actually credit. */
  creditableTdsDeposited: number;
  warnings: string[];
}

/** Longest plausible rupee cell ("-1,23,45,67,890.12" is 18). The bound keeps
 * the numeric test linear on pathological input instead of letting a long
 * comma-and-digit run drive quadratic backtracking. */
const MAX_NUMERIC_FIELD = 24;

/** Amounts may be negative (correction rows) either with a leading minus or in
 * accounting parentheses (balanced, one pair). Commas are Indian-grouped. */
const NUMERIC_RE = /^(?:-?[\d,]*\d(?:\.\d{1,3})?|\([\d,]*\d(?:\.\d{1,3})?\))$/;

function isNumericField(field: string): boolean {
  if (!field || field.length > MAX_NUMERIC_FIELD) return false;
  return NUMERIC_RE.test(field);
}

function num(field: string | undefined): number {
  if (!field) return 0;
  const parenthesised = /^\(.*\)$/.test(field.trim());
  const cleaned = field.replace(/[,\s()]/g, "");
  const n = Number.parseFloat(cleaned);
  if (!Number.isFinite(n)) return 0;
  return parenthesised && n > 0 ? -n : n;
}

const TAN_RE = /^[A-Z]{4}\d{5}[A-Z]$/;
const PAN_RE = /\b([A-Z]{5}\d{4}[A-Z])\b/;
const AY_RE = /Assessment Year[:^\s]*(\d{4}-\d{2})/i;

/** Section codes as TRACES emits them: a 3-digit base (192/193/194/195/196/197
 * for TDS, 206 for TCS) with optional letters and an optional sub-clause
 * ("194I(a)"), or the abbreviated form TRACES uses in some exports ("94C",
 * "4IA", "6CE") which always carries at least one letter. */
const SECTION_RE = /^(?:\d{3}[A-Z]{0,3}(?:\([ab]\))?|\d{1,2}[A-Z]{1,3})$/;
/** A purely numeric field is only a section if it is one of these. Without this
 * a 3-digit serial number ("100") in column 1 would be read as the section. */
const NUMERIC_SECTIONS = new Set([
  "192",
  "193",
  "194",
  "195",
  "196",
  "197",
  "206",
]);

function isSectionField(field: string): boolean {
  if (!SECTION_RE.test(field)) return false;
  if (/^\d+$/.test(field)) return NUMERIC_SECTIONS.has(field);
  return true;
}

/** 26AS is split into Parts I-X. Part I is TDS; Part II is TDS where Form
 * 15G/15H was filed; Parts IV/VIII are 194IA/IB/M/S property/contract TDS (seller
 * and buyer side, keyed by PAN not TAN); Part VI is TCS; Part VII refunds;
 * Part X defaults. Older statements used letters A-H. A deductor context must
 * not survive a part change, and TCS collectors (who DO carry TANs) must land
 * in a different bucket from TDS deductors. */
const PART_HEADER_RE = /^\s*\^?\s*PART[\s^-]*(?:([IVX]+)|([A-H]))\b/i;

/** TCS sections all begin 206C (206CA ... 206CR). Used as the TCS signal
 * regardless of which part the row was found in, because legacy statements
 * put TCS in a different part than current ones. */
const TCS_SECTION_RE = /^206C/;

/** Booking status cell: a single letter in the recognised set. */
const STATUS_RE = /^[FPUOZG]$/;

/** Sum rupee amounts through paise integers: float addition over dozens of
 * two-decimal figures otherwise drifts and breaks exact 26AS comparisons. */
function sumRupees(values: number[]): number {
  return values.reduce((s, v) => s + Math.round(v * 100), 0) / 100;
}

/** Parse the caret-delimited 26AS text. Tolerant: unknown lines are skipped,
 * structural surprises land in warnings[] instead of throwing. */
export function parseForm26AS(text: string): Form26AS {
  const warnings: string[] = [];
  const lines = text.split(/\r?\n/);

  const pan = PAN_RE.exec(text)?.[1] ?? null;
  const assessmentYear = AY_RE.exec(text)?.[1] ?? null;
  if (!pan) warnings.push("PAN not found in header");
  if (!assessmentYear) warnings.push("assessment year not found in header");

  const tdsEntries: TdsEntry[] = [];
  const tcsEntries: TcsEntry[] = [];
  let currentDeductor: { name: string; tan: string } | null = null;
  let unparsedRows = 0;
  let nonFinalRows = 0;

  for (const line of lines) {
    // Part boundaries reset the deductor: a collector or deductor in the next
    // part must never inherit the previous part's context.
    if (PART_HEADER_RE.test(line)) {
      currentDeductor = null;
      continue;
    }
    if (!line.includes("^")) continue;
    const fields = line.split("^").map((f) => f.trim());

    // Deductor header rows carry a TAN; transaction rows carry a section code.
    const tanIdx = fields.findIndex((f) => TAN_RE.test(f));
    const sectionIdx = fields.findIndex((f) => isSectionField(f));

    if (tanIdx !== -1) {
      // The name is the longest non-numeric, non-code cell: deductor names are
      // the only free text on the row, and picking the longest beats the first
      // (which can be a status word like "F" or a booking flag).
      const name = fields
        .filter(
          (f, i) =>
            i !== tanIdx &&
            f.length > 3 &&
            !isNumericField(f) &&
            !isSectionField(f) &&
            /[A-Za-z]/.test(f),
        )
        .sort((a, b) => b.length - a.length)[0];
      currentDeductor = {
        name: name ?? "(unknown)",
        tan: fields[tanIdx] ?? "",
      };
      // Deductor summary rows also carry totals; per-transaction rows below
      // are what we aggregate, so nothing else to read here.
      continue;
    }

    if (sectionIdx !== -1 && currentDeductor) {
      // Transaction row layout after the section code: transaction date,
      // status of booking, date of booking, remarks, then amount paid, tax
      // deducted, TDS deposited. Amounts are read POSITIONALLY (last three
      // cells) rather than by filtering for numerics: a blank cell would
      // otherwise shift the window and silently report the tax deducted as the
      // amount paid. The status is the second cell after the section.
      const cells = fields.slice(sectionIdx + 1);
      const statusCell = cells[1] ?? "";
      const status = STATUS_RE.test(statusCell) ? statusCell : null;
      while (cells.length > 0 && cells[cells.length - 1] === "") cells.pop();
      const tail = cells.slice(-3);
      if (tail.length === 3 && tail.some((f) => isNumericField(f))) {
        const [amountPaid, taxDeducted, tdsDeposited] = tail.map((f) =>
          isNumericField(f) ? num(f) : 0,
        );
        const nonNumeric = tail.filter((f) => f !== "" && !isNumericField(f));
        if (nonNumeric.length > 0) {
          warnings.push(
            `non-numeric value in an amount column for TAN ${currentDeductor.tan} (read as 0): ${nonNumeric.join(", ")}`,
          );
        }
        const section = fields[sectionIdx] ?? "";
        const isCorrection = (tdsDeposited ?? 0) < 0 || (amountPaid ?? 0) < 0;
        if (status !== null && status !== "F") nonFinalRows += 1;

        if (TCS_SECTION_RE.test(section)) {
          tcsEntries.push({
            collectorName: currentDeductor.name,
            tan: currentDeductor.tan,
            section,
            amountPaid: amountPaid ?? 0,
            taxCollected: taxDeducted ?? 0,
            tcsDeposited: tdsDeposited ?? 0,
            isCorrection,
            status,
          });
        } else {
          tdsEntries.push({
            deductorName: currentDeductor.name,
            tan: currentDeductor.tan,
            section,
            amountPaid: amountPaid ?? 0,
            taxDeducted: taxDeducted ?? 0,
            tdsDeposited: tdsDeposited ?? 0,
            isCorrection,
            status,
          });
        }
      } else {
        unparsedRows += 1;
      }
    }
  }

  if (unparsedRows > 0) {
    warnings.push(
      `${unparsedRows} row(s) looked like transactions but had no readable amount columns -- compare the totals below against the 26AS footer`,
    );
  }

  if (nonFinalRows > 0) {
    warnings.push(
      `${nonFinalRows} row(s) carry a booking status other than F (P = provisional, U = unmatched, O = overbooked). CPC credits only F rows; ask the deductor to fix their statement before claiming those amounts. \`creditableTdsDeposited\` excludes them.`,
    );
  }

  if (tcsEntries.length > 0) {
    warnings.push(
      `${tcsEntries.length} TCS row(s) (section 206C*) were separated into tcsEntries: TCS is claimed in Schedule TCS, not Schedule TDS, and is excluded from totalTdsDeposited`,
    );
  }

  const corrections =
    tdsEntries.filter((e) => e.isCorrection).length +
    tcsEntries.filter((e) => e.isCorrection).length;
  if (corrections > 0) {
    warnings.push(
      `${corrections} correction/cancellation row(s) with negative amounts were included in the totals -- this is how TRACES reports a reversal, so the net figure is the creditable one`,
    );
  }

  if (tdsEntries.length === 0 && tcsEntries.length === 0) {
    warnings.push(
      "no TDS/TCS transaction rows recognized -- confirm this is the TRACES Text export (not PDF-to-text)",
    );
  }

  return {
    pan,
    assessmentYear,
    tdsEntries,
    tcsEntries,
    totalTdsDeposited: sumRupees(tdsEntries.map((e) => e.tdsDeposited)),
    totalAmountPaid: sumRupees(tdsEntries.map((e) => e.amountPaid)),
    totalTcsDeposited: sumRupees(tcsEntries.map((e) => e.tcsDeposited)),
    creditableTdsDeposited: sumRupees(
      tdsEntries
        .filter((e) => e.status === null || e.status === "F")
        .map((e) => e.tdsDeposited),
    ),
    warnings,
  };
}
