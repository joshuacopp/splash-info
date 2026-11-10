// JotForm submissions (jotform_submissions), one report per onboarded form.
//
// The DATE RANGE is shared by every form (`jotformReport`): the worker and the
// /admin/jotform/{form_id} page both parse the URL through it, so "today" means
// the same Eastern day on both sides. Default is today (Brief 115).
//
// The COLUMNS differ per form: `jotformReportFor(formId)` adds that form's
// answer columns (the registry below, moved here from apps/web's Brief 111
// form-columns.tsx) after Submitted + Site. A form with no entry gets just
// Submitted + Site. Onboarding a 5th form needs no change here unless it wants
// answer columns in the table.
//
// The EXPORT is a schema union -- every answer key present in any exported row
// becomes a column, headed by the question text -- so it is built from the rows
// by `jotformExportReport(rows)`. Column order and headers are the pre-kit
// export's. Changes from the old export: CRLF, a UTF-8 BOM and the kit's
// formula guard.
//
// Scoping is NOT in here: the jotform worker still decides which sites a caller
// may read (accessibleSiteNumbersForSession + the RD/RM/Location filters).

import { defineReport, type ReportColumn, type ReportDef } from "../define";

export interface JotformReportRow {
  id: string;
  form_id?: string;
  site_number: string | null;
  site: string | null;
  site_email?: string | null;
  jotform_created_at: string | null;
  jotform_updated_at?: string | null;
  jotform_status?: string | null;
  answers?: Record<string, unknown> | null;
}

/**
 * One answer as display text: prettyFormat, then answer, then JSON. "" when
 * absent. Shared by the table, the export and anything else that shows an
 * answer in one line.
 */
export function jotformAnswerText(row: JotformReportRow, key: string): string {
  const map = row.answers;
  if (!map || typeof map !== "object") return "";
  const entry = map[key];
  if (entry == null) return "";
  if (typeof entry === "string") return entry;
  if (typeof entry === "number" || typeof entry === "boolean") return String(entry);
  if (typeof entry === "object") {
    const v = entry as Record<string, unknown>;
    if (typeof v.prettyFormat === "string" && v.prettyFormat.trim()) return v.prettyFormat.trim();
    const answer = v.answer;
    if (typeof answer === "string") return answer.trim();
    if (typeof answer === "number" || typeof answer === "boolean") return String(answer);
    if (answer != null) {
      try {
        return JSON.stringify(answer);
      } catch {
        return "";
      }
    }
  }
  return "";
}

/**
 * Per-form answer columns for the table, keyed by form_id. Keys are JotForm
 * answer keys; labels are the builder's `answers[KEY].text`, operator-confirmed
 * against live rows 2026-05-12.
 */
export const JOTFORM_FORM_COLUMNS: Readonly<Record<string, ReadonlyArray<{ key: string; label: string }>>> = {
  // Rewash
  "250165655616055": [{ key: "4", label: "Rewash Reason" }],
  // Salt log
  "243523811897060": [
    { key: "5", label: "Pounds of Ice Melt Used" },
    { key: "6", label: "Areas Ice Melt Applied" },
    { key: "8", label: "Name" }
  ],
  // Retention
  "250855287972067": [
    { key: "28", label: "Name" },
    { key: "29", label: "Email" },
    { key: "30", label: "Barcode/License Plate" },
    { key: "31", label: "Action Being Taken" }
  ],
  // Time card edit
  "250193775451056": [
    { key: "4", label: "Employee Name" },
    { key: "5", label: "Reason For Edit" },
    { key: "28", label: "Manager Making Edits" }
  ]
};

const PRESETS = ["today", "yesterday", "last_7", "last_30", "mtd", "past_month", "ytd"] as const;

const TABLE_ONLY = ["table"] as const;

const BASE_TABLE_COLUMNS: ReadonlyArray<ReportColumn<JotformReportRow>> = [
  { id: "jotform_created_at", label: "Submitted", kind: "datetime", in: TABLE_ONLY },
  {
    id: "site",
    label: "Site",
    kind: "text",
    in: TABLE_ONLY,
    get: (r) => r.site || r.site_number || null
  }
];

/** The range half, shared by every form. Use for parseReportParams. */
export const jotformReport = defineReport<JotformReportRow>({
  id: "jotform",
  title: "JotForm submissions",
  defaultRange: "today",
  presets: PRESETS,
  filters: [],
  rowKey: (r) => r.id,
  columns: BASE_TABLE_COLUMNS
});

const byForm = new Map<string, ReportDef<JotformReportRow>>();

/** The table definition for one form: Submitted, Site, then its answer columns. */
export function jotformReportFor(formId: string): ReportDef<JotformReportRow> {
  const cached = byForm.get(formId);
  if (cached) return cached;
  const answers = JOTFORM_FORM_COLUMNS[formId] ?? [];
  const def = defineReport<JotformReportRow>({
    ...jotformReport,
    columns: [
      ...BASE_TABLE_COLUMNS,
      ...answers.map(
        (a): ReportColumn<JotformReportRow> => ({
          id: `answer:${a.key}`,
          label: a.label,
          kind: "text",
          in: TABLE_ONLY,
          get: (r) => jotformAnswerText(r, a.key) || null
        })
      )
    ]
  });
  byForm.set(formId, def);
  return def;
}

const EXPORT_ONLY = ["export"] as const;

/** Fixed leading export columns, in the pre-kit order with the pre-kit headers. */
const EXPORT_BASE = [
  "site",
  "id",
  "jotform_created_at",
  "jotform_updated_at",
  "site_number",
  "site_email",
  "jotform_status"
] as const;

// The kit's formula guard prefixes any TEXT cell starting with "-", which would
// turn a typed "-5" into '-5. A plain negative number goes out as a number.
const PLAIN_NEGATIVE = /^-\d+(\.\d+)?$/;

/**
 * Export definition for a set of rows: the fixed columns, then one column per
 * answer key present in any row (sorted by key), headed by the question text,
 * falling back to the field name, then the key. A label two questions share
 * gets the key appended so both stay distinct.
 */
export function jotformExportReport(rows: ReadonlyArray<JotformReportRow>): ReportDef<JotformReportRow> {
  const keyLabel = new Map<string, string>();
  for (const r of rows) {
    const a = r.answers;
    if (!a || typeof a !== "object") continue;
    for (const k of Object.keys(a)) {
      if (keyLabel.get(k)) continue;
      const entry = a[k];
      let label = "";
      if (entry && typeof entry === "object") {
        const e = entry as Record<string, unknown>;
        if (typeof e.text === "string" && e.text.trim()) label = e.text.trim();
        else if (typeof e.name === "string" && e.name.trim()) label = e.name.trim();
      }
      keyLabel.set(k, label);
    }
  }
  const keys = [...keyLabel.keys()].sort();
  const counts = new Map<string, number>();
  for (const k of keys) {
    const label = keyLabel.get(k) || k;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }

  const columns: ReportColumn<JotformReportRow>[] = [
    ...EXPORT_BASE.map(
      (id): ReportColumn<JotformReportRow> => ({ id, label: id, kind: "text", in: EXPORT_ONLY })
    ),
    ...keys.map((k): ReportColumn<JotformReportRow> => {
      const label = keyLabel.get(k) || k;
      return {
        id: `answer:${k}`,
        label,
        csvLabel: (counts.get(label) ?? 0) > 1 ? `${label} (${k})` : label,
        kind: "text",
        in: EXPORT_ONLY,
        get: (r) => {
          const text = jotformAnswerText(r, k);
          if (!text) return null;
          return PLAIN_NEGATIVE.test(text) ? Number(text) : text;
        }
      };
    })
  ];
  return defineReport<JotformReportRow>({ ...jotformReport, columns });
}

/**
 * Export row order: grouped by site A-Z (blank site last), oldest first within
 * a site. Returns a new array.
 */
export function sortJotformExportRows<Row extends JotformReportRow>(rows: ReadonlyArray<Row>): Row[] {
  return [...rows].sort((a, b) => {
    const sa = (a.site ?? "").toString();
    const sb = (b.site ?? "").toString();
    if (sa === "" && sb !== "") return 1;
    if (sb === "" && sa !== "") return -1;
    const c = sa.localeCompare(sb, undefined, { sensitivity: "base" });
    if (c !== 0) return c;
    return (a.jotform_created_at ?? "").localeCompare(b.jotform_created_at ?? "");
  });
}

/** `{slug}-{from}-to-{to}.csv`, the pre-kit filename with Eastern dates. */
export function jotformCsvFilename(slug: string, fromYmd: string, toYmd: string): string {
  return `${slug}-${fromYmd}-to-${toYmd}.csv`;
}
