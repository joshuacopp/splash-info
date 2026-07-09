"use client";

// Brief 119 — wide-column submissions table (schema-union) + client-side
// per-field filter (Brief 96 follow-up). Payloads are already loaded via
// `?include=payload`, so filtering happens entirely in the browser: pick a
// field, type/select a value, and rows are matched case-insensitively
// (contains) against that field's *displayed* value (option labels resolved,
// not raw codes). No backend round-trip.

import { useMemo, useState } from "react";
import Link from "next/link";

import type { Field } from "@splash/forms-schema";
import type { SubmissionListItem } from "../../../_lib/worker-fetch";
import StatusPill from "./StatusPill";
import AnswerCell from "./AnswerCell";
import WorkflowOutcomeCell from "./WorkflowOutcomeCell";
import { computeSchemaUnion, type AnswerColumn } from "../_lib/schema-union";

// Resolve a payload value to the human-readable text shown in the table —
// mirrors AnswerCell's label resolution so filtering matches what operators
// see, not the underlying option codes / r2 keys.
function toSearchText(field: Field, value: unknown): string {
  if (value == null || value === "") return "";
  switch (field.type) {
    case "dropdown": {
      const opt = field.options.find((o) => o.value === String(value));
      return opt?.label ?? String(value);
    }
    case "multi": {
      if (!Array.isArray(value)) return String(value);
      return value
        .map((v) => {
          const opt = field.options.find((o) => o.value === String(v));
          return opt?.label ?? String(v);
        })
        .join(", ");
    }
    case "file":
    case "signature": {
      if (value && typeof value === "object") {
        const obj = value as Record<string, unknown>;
        if (typeof obj.original_filename === "string") return obj.original_filename;
        if (typeof obj.r2_key === "string") return obj.r2_key;
      }
      return "";
    }
    default:
      return String(value);
  }
}

export default function WideSubmissionsTable({
  formId,
  items,
  from,
  to
}: {
  formId: string;
  items: SubmissionListItem[];
  from?: string;
  to?: string;
}) {
  const columns = useMemo(() => computeSchemaUnion(items), [items]);

  const [filterKey, setFilterKey] = useState<string>("");
  const [filterValue, setFilterValue] = useState<string>("");

  const activeColumn = columns.find((c) => c.key === filterKey) ?? null;

  // Aggregate response-report PDF. Same-origin path (forms is path-carved),
  // so we build the URL here rather than importing the server-only
  // worker-fetch helper into this client component. Carries the applied date
  // range plus the current field filter so the export matches the view.
  const reportUrl = useMemo(() => {
    const qs = new URLSearchParams();
    if (from) qs.set("from", from);
    if (to) qs.set("to", to);
    if (activeColumn && filterValue.trim() !== "") {
      qs.set("filter_key", activeColumn.key);
      qs.set("filter_value", filterValue.trim());
    }
    const q = qs.toString();
    return `/forms/admin/api/forms/${encodeURIComponent(formId)}/submissions/report.pdf${
      q ? `?${q}` : ""
    }`;
  }, [formId, from, to, activeColumn, filterValue]);

  // Same report, but with disposition=inline so the browser renders it in a
  // new tab instead of downloading. Powers the "View report" button.
  const viewReportUrl = useMemo(
    () => `${reportUrl}${reportUrl.includes("?") ? "&" : "?"}disposition=inline`,
    [reportUrl]
  );

  // Distinct displayed values for the selected field, to power a datalist of
  // quick-pick suggestions (operator can still free-type a contains match).
  const distinctValues = useMemo(() => {
    if (!activeColumn) return [];
    const set = new Set<string>();
    for (const s of items) {
      const payload = s.payload ?? {};
      const text = toSearchText(activeColumn.field, payload[activeColumn.key]);
      if (text) set.add(text);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [activeColumn, items]);

  const filteredItems = useMemo(() => {
    if (!activeColumn || filterValue.trim() === "") return items;
    const needle = filterValue.trim().toLowerCase();
    return items.filter((s) => {
      const payload = s.payload ?? {};
      const text = toSearchText(activeColumn.field, payload[activeColumn.key]);
      return text.toLowerCase().includes(needle);
    });
  }, [activeColumn, filterValue, items]);

  const stickyHeadBase =
    "sticky top-0 z-20 bg-sudsy-blue-soft/40 px-3 py-2 font-semibold";
  const stickyHeadLeft =
    "sticky left-0 top-0 z-30 bg-sudsy-blue-soft/40 px-3 py-2 font-semibold";
  const stickyCellLeft =
    "sticky left-0 z-10 bg-white px-3 py-2 align-top text-splash-navy";

  if (items.length === 0) {
    return (
      <div className="rounded-splash-md border border-gray-light bg-white px-4 py-6 text-center italic text-splash-navy/60">
        No submissions in the selected range.
      </div>
    );
  }

  return (
    <>
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <div>
          <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-splash-navy/70">
            Filter field
          </label>
          <select
            value={filterKey}
            onChange={(e) => {
              setFilterKey(e.target.value);
              setFilterValue("");
            }}
            className="rounded-splash-sm border border-gray-light bg-white px-3 py-1.5 text-sm text-splash-navy"
          >
            <option value="">None</option>
            {columns.map((col) => (
              <option key={col.key} value={col.key}>
                {col.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-splash-navy/70">
            Value contains
          </label>
          <input
            type="text"
            value={filterValue}
            disabled={!activeColumn}
            onChange={(e) => setFilterValue(e.target.value)}
            list="wide-filter-values"
            placeholder={activeColumn ? "e.g. Johnson City" : "Pick a field first"}
            className="rounded-splash-sm border border-gray-light bg-white px-3 py-1.5 text-sm text-splash-navy disabled:bg-gray-light/30 disabled:text-splash-navy/40"
          />
          <datalist id="wide-filter-values">
            {distinctValues.map((v) => (
              <option key={v} value={v} />
            ))}
          </datalist>
        </div>
        {activeColumn && filterValue.trim() !== "" && (
          <button
            type="button"
            onClick={() => setFilterValue("")}
            className="inline-flex items-center rounded-splash-sm border border-gray-light bg-white px-3 py-1.5 text-sm font-bold text-splash-navy hover:bg-sudsy-blue-soft/40"
          >
            Clear
          </button>
        )}
        <span className="pb-1.5 text-sm text-splash-navy/60">
          {filteredItems.length} of {items.length}
        </span>
        <a
          href={viewReportUrl}
          target="_blank"
          rel="noopener"
          className="ml-auto inline-flex items-center gap-1.5 rounded-splash-sm border border-splash-blue bg-splash-blue px-4 py-1.5 text-sm font-bold text-white hover:bg-splash-blue/90"
          title="Open the response report in a new tab without downloading, honoring the filter and date range"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2.2}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            className="h-4 w-4"
          >
            <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
          View report
        </a>
        <a
          href={reportUrl}
          download
          className="inline-flex items-center gap-1.5 rounded-splash-sm border border-splash-blue bg-white px-4 py-1.5 text-sm font-bold text-splash-blue hover:bg-splash-blue/5"
          title="Percentage breakdown of every dropdown / multiple-choice question, honoring the filter and date range"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2.2}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            className="h-4 w-4"
          >
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
          Export report (PDF)
        </a>
      </div>

      <div className="overflow-x-auto rounded-splash-md border border-gray-light">
        <table className="min-w-full border-collapse text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-splash-navy/70">
            <tr>
              <th className={stickyHeadLeft}>Submitted</th>
              <th className={stickyHeadBase}>Status</th>
              <th className={stickyHeadBase}>Workflow</th>
              <th className={stickyHeadBase}>Submitter</th>
              <th className={stickyHeadBase}>Splash Notes</th>
              <th className={stickyHeadBase}>Version</th>
              {columns.map((col) => (
                <th key={col.key} className={stickyHeadBase}>
                  <span className="block whitespace-nowrap">{col.label}</span>
                  <span className="block font-mono text-[10px] font-normal normal-case text-splash-navy/40">
                    {col.key}
                  </span>
                </th>
              ))}
              <th className={stickyHeadBase} />
            </tr>
          </thead>
          <tbody>
            {filteredItems.length === 0 ? (
              <tr>
                <td
                  colSpan={7 + columns.length}
                  className="px-3 py-6 text-center italic text-splash-navy/60"
                >
                  No submissions match the current filter.
                </td>
              </tr>
            ) : (
              filteredItems.map((s) => (
                <tr
                  key={s.id}
                  className="border-t border-gray-light hover:bg-sudsy-blue-soft/20"
                >
                  <td className={stickyCellLeft}>
                    <span
                      title={s.submitted_at}
                      className="block whitespace-nowrap"
                    >
                      {new Date(s.submitted_at).toLocaleString()}
                    </span>
                  </td>
                  <td className="px-3 py-2 align-top">
                    <StatusPill status={s.status} />
                  </td>
                  <td className="px-3 py-2 align-top">
                    <WorkflowOutcomeCell item={s} />
                  </td>
                  <td className="px-3 py-2 align-top text-splash-navy">
                    {s.submitter_kind === "authenticated" ? (
                      s.submitter_email ?? (
                        <em className="text-splash-navy/50">—</em>
                      )
                    ) : (
                      <em className="text-splash-navy/50">anonymous</em>
                    )}
                  </td>
                  <td
                    className="px-3 py-2 align-top text-splash-navy/80"
                    title={s.splash_notes ?? undefined}
                  >
                    {s.splash_notes_preview ? (
                      <span className="block max-w-[14rem] truncate">
                        {s.splash_notes_preview}
                        {s.splash_notes_truncated && "…"}
                      </span>
                    ) : (
                      <em className="text-splash-navy/40">—</em>
                    )}
                  </td>
                  <td className="px-3 py-2 align-top text-splash-navy/80">
                    {s.version_number != null ? `v${s.version_number}` : "—"}
                  </td>
                  {columns.map((col) => (
                    <AnswerTd key={col.key} column={col} item={s} />
                  ))}
                  <td className="px-3 py-2 align-top">
                    <Link
                      href={`/admin/forms/${encodeURIComponent(formId)}/submissions/${encodeURIComponent(s.id)}`}
                      className="whitespace-nowrap text-splash-blue hover:underline"
                    >
                      View →
                    </Link>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

function AnswerTd({
  column,
  item
}: {
  column: AnswerColumn;
  item: SubmissionListItem;
}) {
  const payload = item.payload ?? {};
  const inSchema =
    item.version?.schema.fields.some((f) => f.key === column.key) ?? false;
  const hasOwn = Object.prototype.hasOwnProperty.call(payload, column.key);
  if (!inSchema && !hasOwn) {
    return (
      <td className="px-3 py-2 align-top text-splash-navy/40">
        <span title={`Not part of v${item.version_number ?? "?"} schema`}>
          —
        </span>
      </td>
    );
  }
  return (
    <td className="px-3 py-2 align-top text-splash-navy">
      <AnswerCell field={column.field} value={payload[column.key]} />
    </td>
  );
}
