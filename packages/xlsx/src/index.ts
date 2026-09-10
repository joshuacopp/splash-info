// A tiny, dependency-free XLSX writer.
//
// Extracted from apps/damage-worker/src/xlsx.ts (Brief 178) so the inventory
// export can use it too, and generalised from one worksheet to many. The
// single-sheet entry point kept its original signature, so damage-worker's
// claims export calls it unchanged.
//
// Why hand-rolled: the claims export runs inside the Cloudflare Workers
// runtime. The usual xlsx libraries are a poor fit there — SheetJS's free
// build does widths but no cell styling, exceljs drags in Node stream/zlib
// deps that are risky under Workers, and write-excel-file is another
// dependency to vet. What we actually need is small and stable: fixed
// column widths, a bold frozen header, an autofilter, text wrap on two
// columns, and real date typing. That's a few hundred lines of OOXML plus
// a STORE-mode (uncompressed) ZIP container, with zero runtime deps.
//
// STORE mode means no DEFLATE — every part is written verbatim with a
// CRC32. Exports are at most 10k rows, so skipping compression costs a bit
// of bandwidth but removes any dependency on a compressor in the runtime.
// The output validates cleanly with openpyxl / Excel / Numbers.
//
// Scope: inline strings (no sharedStrings table), numbers, and date/datetime
// cells written as Excel serial numbers with a date number-format. One or more
// worksheets, each with its own columns. This is not a general spreadsheet
// engine — no formulas, merges, images or per-cell styling beyond the five
// built-in cell formats below.

export type XlsxColumnKind =
  | "text"
  | "number"
  | "datetime"
  | "date"
  | "wrap";

export interface XlsxColumn {
  header: string;
  /** Column width in Excel "characters" (same unit the UI shows). */
  width: number;
  kind: XlsxColumnKind;
}

/** Cell values as produced upstream: numbers stay numbers, everything
 *  else is a string ("" for blank). Date columns receive the raw ISO
 *  string and are converted to a serial number here. */
export type XlsxCell = string | number;

/** One worksheet: a tab name, its column definitions, and its body rows. */
export interface XlsxSheet {
  /** Tab name. Sanitised on the way out — Excel refuses names that are
   *  blank, over 31 chars, or contain any of : \ / ? * [ ]. Duplicates are
   *  suffixed, because a workbook with two same-named tabs won't open. */
  name: string;
  columns: XlsxColumn[];
  rows: XlsxCell[][];
}

/**
 * Build a complete .xlsx file (a ZIP of OOXML parts) for one worksheet.
 *
 * Original single-sheet entry point, kept so existing callers are unaffected.
 * `columns` defines the header, widths, and per-column typing; `rows` is the
 * body, each row an array of cells in the same order as `columns`.
 */
export function buildXlsxWorkbook(
  columns: XlsxColumn[],
  rows: XlsxCell[][],
  sheetName = "Sheet1"
): Uint8Array {
  return buildXlsxWorkbookMultiSheet([{ name: sheetName, columns, rows }]);
}

/**
 * Build a complete .xlsx file with one worksheet per entry, in order.
 *
 * Throws on an empty array: a workbook with no sheets is not a valid xlsx
 * file, and failing here beats handing the user a download Excel won't open.
 */
export function buildXlsxWorkbookMultiSheet(sheets: XlsxSheet[]): Uint8Array {
  if (sheets.length === 0) {
    throw new Error("buildXlsxWorkbookMultiSheet: at least one sheet is required");
  }

  const names = uniqueSheetNames(sheets.map((s) => s.name));

  const files: ZipEntry[] = [
    { name: "[Content_Types].xml", data: enc(contentTypesXml(sheets.length)) },
    { name: "_rels/.rels", data: enc(ROOT_RELS_XML) },
    { name: "xl/workbook.xml", data: enc(workbookXml(names)) },
    { name: "xl/_rels/workbook.xml.rels", data: enc(workbookRelsXml(sheets.length)) },
    { name: "xl/styles.xml", data: enc(STYLES_XML) }
  ];

  for (let i = 0; i < sheets.length; i++) {
    const sheet = sheets[i]!;
    files.push({
      name: `xl/worksheets/sheet${i + 1}.xml`,
      data: enc(buildSheetXml(sheet.columns, sheet.rows))
    });
  }

  return zipStore(files);
}

/** Excel's tab-name rules, applied defensively so a caller can pass a raw
 *  location name through without the workbook silently failing to open. */
function uniqueSheetNames(raw: string[]): string[] {
  const taken = new Set<string>();
  return raw.map((original, i) => {
    let name = (original || "").replace(/[:\\/?*[\]]/g, " ").trim();
    if (name === "") name = `Sheet${i + 1}`;
    if (name.length > 31) name = name.slice(0, 31).trim();

    if (!taken.has(name.toLowerCase())) {
      taken.add(name.toLowerCase());
      return name;
    }
    // Collision — append " (2)", " (3)" …, trimming the stem to stay inside
    // the 31-char ceiling.
    for (let n = 2; ; n++) {
      const suffix = ` (${n})`;
      const stem = name.slice(0, 31 - suffix.length).trim();
      const candidate = `${stem}${suffix}`;
      if (!taken.has(candidate.toLowerCase())) {
        taken.add(candidate.toLowerCase());
        return candidate;
      }
    }
  });
}

/* ------------------------------------------------------------------ *
 * Worksheet XML
 * ------------------------------------------------------------------ */

function buildSheetXml(columns: XlsxColumn[], rows: XlsxCell[][]): string {
  const lastCol = colLetter(columns.length - 1);
  const lastRow = rows.length + 1; // +1 for the header row
  const dimension = `A1:${lastCol}${lastRow}`;

  // <cols> — one entry per column carrying its width.
  const colsXml = columns
    .map(
      (c, i) =>
        `<col min="${i + 1}" max="${i + 1}" width="${c.width}" customWidth="1"/>`
    )
    .join("");

  // Header row — every cell bold (style 1), inline strings.
  const headerCells = columns
    .map((c, i) => inlineStrCell(`${colLetter(i)}1`, c.header, 1))
    .join("");
  const headerRow = `<row r="1">${headerCells}</row>`;

  // Body rows.
  const bodyRows: string[] = [];
  for (let ri = 0; ri < rows.length; ri++) {
    const row = rows[ri]!;
    const rowNum = ri + 2; // 1-based, after header
    const cells: string[] = [];
    for (let ci = 0; ci < columns.length; ci++) {
      const ref = `${colLetter(ci)}${rowNum}`;
      // row may be shorter than columns → treat a missing cell as blank.
      cells.push(renderCell(ref, row[ci] ?? "", columns[ci]!.kind));
    }
    bodyRows.push(`<row r="${rowNum}">${cells.join("")}</row>`);
  }

  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<dimension ref="${dimension}"/>` +
    // Freeze the header row.
    `<sheetViews><sheetView workbookViewId="0">` +
    `<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>` +
    `<selection pane="bottomLeft" activeCell="A2" sqref="A2"/>` +
    `</sheetView></sheetViews>` +
    `<sheetFormatPr defaultRowHeight="15"/>` +
    `<cols>${colsXml}</cols>` +
    `<sheetData>${headerRow}${bodyRows.join("")}</sheetData>` +
    // Autofilter across the whole table.
    `<autoFilter ref="${dimension}"/>` +
    `</worksheet>`
  );
}

/** Render a single body cell based on its column kind. Empty/blank cells
 *  are emitted as a self-closing styled cell so column formatting sticks. */
function renderCell(ref: string, value: XlsxCell, kind: XlsxColumnKind): string {
  const style = STYLE_FOR_KIND[kind];

  if (kind === "number") {
    if (typeof value === "number" && Number.isFinite(value)) {
      return `<c r="${ref}" s="${style}"><v>${value}</v></c>`;
    }
    const n = typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
    if (Number.isFinite(n)) return `<c r="${ref}" s="${style}"><v>${n}</v></c>`;
    return `<c r="${ref}" s="${style}"/>`;
  }

  if (kind === "date" || kind === "datetime") {
    const serial = toExcelSerial(String(value ?? ""));
    if (serial === null) return `<c r="${ref}" s="${style}"/>`;
    return `<c r="${ref}" s="${style}"><v>${serial}</v></c>`;
  }

  // text / wrap → inline string
  const s = value === null || value === undefined ? "" : String(value);
  if (s === "") return `<c r="${ref}" s="${style}"/>`;
  return inlineStrCell(ref, s, style);
}

function inlineStrCell(ref: string, text: string, style: number): string {
  return (
    `<c r="${ref}" s="${style}" t="inlineStr">` +
    `<is><t xml:space="preserve">${escapeXml(text)}</t></is></c>`
  );
}

/* ------------------------------------------------------------------ *
 * Styles — 5 cellXfs referenced by index from renderCell / header
 *   0 general text | 1 bold header | 2 wrap text
 *   3 datetime (numFmt 164) | 4 date (numFmt 165)
 * ------------------------------------------------------------------ */

const STYLE_FOR_KIND: Record<XlsxColumnKind, number> = {
  text: 0,
  number: 0,
  wrap: 2,
  datetime: 3,
  date: 4
};

const STYLES_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
  `<numFmts count="2">` +
  `<numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd\\ hh:mm"/>` +
  `<numFmt numFmtId="165" formatCode="yyyy\\-mm\\-dd"/>` +
  `</numFmts>` +
  `<fonts count="2">` +
  `<font><sz val="11"/><name val="Calibri"/></font>` +
  `<font><b/><sz val="11"/><name val="Calibri"/></font>` +
  `</fonts>` +
  `<fills count="1"><fill><patternFill patternType="none"/></fill></fills>` +
  `<borders count="1"><border/></borders>` +
  `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
  `<cellXfs count="5">` +
  // 0 — general text
  `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
  // 1 — bold header, top-aligned
  `<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="top"/></xf>` +
  // 2 — wrap text, top-aligned
  `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>` +
  // 3 — datetime
  `<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
  // 4 — date
  `<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
  `</cellXfs>` +
  `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
  `</styleSheet>`;

/* ------------------------------------------------------------------ *
 * Static package parts
 * ------------------------------------------------------------------ */

/** Every worksheet part needs its own Override entry, or Excel reports the
 *  workbook as corrupt rather than ignoring the sheet. */
function contentTypesXml(sheetCount: number): string {
  const overrides: string[] = [];
  for (let i = 1; i <= sheetCount; i++) {
    overrides.push(
      `<Override PartName="/xl/worksheets/sheet${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
    );
  }
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    overrides.join("") +
    `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
    `</Types>`
  );
}

const ROOT_RELS_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
  `</Relationships>`;

/** Tab order is array order. Names are already sanitised and de-duplicated by
 *  uniqueSheetNames(); they still need XML-escaping ("R&D" is a legal tab
 *  name and an illegal XML attribute value unescaped). */
function workbookXml(names: string[]): string {
  const sheets = names
    .map(
      (name, i) =>
        `<sheet name="${escapeXmlAttr(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`
    )
    .join("");
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheets>${sheets}</sheets>` +
    `</workbook>`
  );
}

/** Worksheets take rId1..rIdN and styles takes rId(N+1) — the ids must line up
 *  with the r:id values workbookXml() emits. */
function workbookRelsXml(sheetCount: number): string {
  const rels: string[] = [];
  for (let i = 1; i <= sheetCount; i++) {
    rels.push(
      `<Relationship Id="rId${i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i}.xml"/>`
    );
  }
  rels.push(
    `<Relationship Id="rId${sheetCount + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`
  );
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    rels.join("") +
    `</Relationships>`
  );
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/** 0-based column index → spreadsheet letter (0→A, 25→Z, 26→AA). */
function colLetter(index: number): string {
  let n = index;
  let s = "";
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

/**
 * Convert an ISO-ish timestamp ("YYYY-MM-DD" or "YYYY-MM-DD HH:MM:SS",
 * space or 'T' separator, optional trailing Z) to an Excel serial number
 * (days since the 1899-12-30 epoch). Interpreted as UTC with no timezone
 * shift, matching how the DB stores datetime('now'). Returns null for
 * blank or unparseable input.
 */
function toExcelSerial(raw: string): number | null {
  const s = raw.trim();
  if (s === "") return null;
  const m = s.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/
  );
  if (!m) return null;
  const [, y, mo, d, hh, mi, ss] = m;
  const ms = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(hh ?? 0),
    Number(mi ?? 0),
    Number(ss ?? 0)
  );
  // Excel's epoch, and its historical 1900 leap-year bug: dates on/after
  // 1900-03-01 need +1. The 1899-12-30 base already accounts for it for
  // all modern dates, which is everything this export will ever see.
  const EPOCH = Date.UTC(1899, 11, 30);
  const serial = (ms - EPOCH) / 86_400_000;
  // Snap to the nearest whole second (86400 s/day). Every timestamp this
  // export sees has whole-second resolution, so this removes sub-second
  // floating-point noise that would otherwise show up in the serial.
  return Math.round(serial * 86_400) / 86_400;
}

/** Escape a string for XML text content, dropping XML-illegal control
 *  chars (notes are free text and can contain anything). */
function escapeXml(s: string): string {
  return s
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, " ")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Escape for an XML *attribute* value. escapeXml() above covers text content,
 *  where a bare quote is legal; inside a double-quoted attribute it is not, so
 *  a sheet named `12" Wands` would otherwise emit malformed XML. */
function escapeXmlAttr(s: string): string {
  return escapeXml(s).replace(/"/g, "&quot;");
}

const textEncoder = new TextEncoder();
function enc(s: string): Uint8Array {
  return textEncoder.encode(s);
}

/* ------------------------------------------------------------------ *
 * Minimal STORE-mode ZIP writer (no compression)
 * ------------------------------------------------------------------ */

interface ZipEntry {
  name: string;
  data: Uint8Array;
}

function zipStore(entries: ZipEntry[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const e of entries) {
    const nameBytes = enc(e.name);
    const crc = crc32(e.data);
    const size = e.data.length;

    // Local file header (30 bytes + name).
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); // signature
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, 0, true); // flags
    lv.setUint16(8, 0, true); // method = store
    lv.setUint16(10, 0, true); // mod time
    lv.setUint16(12, 0x21, true); // mod date (1980-01-01)
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true); // compressed size
    lv.setUint32(22, size, true); // uncompressed size
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true); // extra length
    local.set(nameBytes, 30);

    chunks.push(local, e.data);

    // Central directory header (46 bytes + name).
    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true); // signature
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed
    cv.setUint16(8, 0, true); // flags
    cv.setUint16(10, 0, true); // method
    cv.setUint16(12, 0, true); // mod time
    cv.setUint16(14, 0x21, true); // mod date
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true); // extra length
    cv.setUint16(32, 0, true); // comment length
    cv.setUint16(34, 0, true); // disk number start
    cv.setUint16(36, 0, true); // internal attrs
    cv.setUint32(38, 0, true); // external attrs
    cv.setUint32(42, offset, true); // local header offset
    cd.set(nameBytes, 46);
    central.push(cd);

    offset += local.length + e.data.length;
  }

  const centralStart = offset;
  let centralSize = 0;
  for (const c of central) centralSize += c.length;

  // End of central directory (22 bytes, no comment).
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true); // this disk
  ev.setUint16(6, 0, true); // disk with central dir
  ev.setUint16(8, entries.length, true); // entries this disk
  ev.setUint16(10, entries.length, true); // entries total
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, centralStart, true);
  ev.setUint16(20, 0, true); // comment length

  return concatBytes([...chunks, ...central, eocd]);
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// CRC32 (IEEE 802.3, ZIP), lazily-built lookup table.
let CRC_TABLE: Uint32Array | null = null;
function crcTable(): Uint32Array {
  if (CRC_TABLE) return CRC_TABLE;
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c >>> 0;
  }
  CRC_TABLE = t;
  return t;
}
function crc32(bytes: Uint8Array): number {
  const table = crcTable();
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = table[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
