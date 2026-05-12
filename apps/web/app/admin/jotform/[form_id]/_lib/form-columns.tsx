// Brief 111 — per-form column registry for the JotForm submissions
// list table.
//
// The Brief 109 / Brief 110 list view rendered a generic
// "Submitted at | Site | Status | View →" table on every form. Brief 111
// drops the Status column (every onboarded form emits ACTIVE only) and
// surfaces form-specific columns instead. Each form_id maps to an
// ordered FormColumn[] whose `render` accessor pulls a value out of
// `JotformSubmissionRow`. Forms without an entry fall back to
// DEFAULT_COLUMNS (Submitted + Site only).
//
// Onboarding a new (5th / 6th) JotForm form requires adding an entry
// here ONLY if non-generic columns are wanted; otherwise the default
// `Submitted | Site` columns kick in automatically and the rest of
// the per-form viewer needs zero changes (the detail page already
// renders all answers via the generic alphabetical renderer).
//
// Column header labels for numeric answer keys SHOULD be copied from
// `answers[KEY].text` of a representative sample row in the JotForm
// builder's question-text shape. At commit time the labels below are
// placeholders pending operator confirmation — they're functional but
// generic ("Answer (key 5)") so the operator can grep + replace once
// sample data is in hand. The accessor's `prettyFormat → answer → ''`
// fallback chain keeps the column rendering meaningful regardless.

import type React from "react";
import type { JotformSubmissionRow } from "../../_lib/worker-fetch";
import { formatEst } from "../../_lib/format-est";

export interface FormColumn {
  key: string;
  label: string;
  render: (row: JotformSubmissionRow) => React.ReactNode;
}

function answerEntry(row: JotformSubmissionRow, key: string): unknown {
  const map = row.answers as Record<string, unknown> | undefined;
  if (!map || typeof map !== "object") return undefined;
  return map[key];
}

function readAnswerText(row: JotformSubmissionRow, key: string): string {
  const entry = answerEntry(row, key);
  if (entry == null) return "";
  if (typeof entry === "string") return entry;
  if (typeof entry === "number" || typeof entry === "boolean") {
    return String(entry);
  }
  if (typeof entry === "object") {
    const v = entry as Record<string, unknown>;
    const pretty = v.prettyFormat;
    if (typeof pretty === "string" && pretty.trim()) return pretty.trim();
    const answer = v.answer;
    if (typeof answer === "string" && answer.trim()) return answer.trim();
    if (typeof answer === "number" || typeof answer === "boolean") {
      return String(answer);
    }
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

function muted(): React.ReactNode {
  return <span className="text-splash-navy/50">—</span>;
}

// ---- Reusable column builders --------------------------------------------

export function submittedColumn(): FormColumn {
  return {
    key: "submitted",
    label: "Submitted (EST)",
    render: (row) => {
      const iso = row.jotform_created_at;
      if (!iso) return muted();
      const { absolute, relative } = formatEst(iso);
      return (
        <span title={absolute} className="whitespace-nowrap">
          {relative || absolute}
        </span>
      );
    }
  };
}

export function siteColumn(): FormColumn {
  return {
    key: "site",
    label: "Site",
    render: (row) => {
      const value = row.site ?? row.site_number;
      if (!value) return muted();
      return <span className="whitespace-nowrap">{value}</span>;
    }
  };
}

export function answerColumn(key: string, label: string): FormColumn {
  return {
    key: `answer:${key}`,
    label,
    render: (row) => {
      const value = readAnswerText(row, key);
      if (!value) return muted();
      return <span className="whitespace-pre-wrap break-words">{value}</span>;
    }
  };
}

// ---- Per-form registry ---------------------------------------------------
//
// Keys + labels for numeric-answer columns are placeholder pending sample
// data inspection. The `text` field on each `answers[KEY]` entry in a live
// row carries the JotForm builder's question text; operator/executor
// should copy those values into the labels below.

// Operator-confirmed answer keys (filled in 2026-05-12 from live sample rows).
// Labels match the JotForm builder `answers[KEY].text` values verbatim.
const REWASH_REASON_KEY = "4"; // name: "rewashReason", text: "Rewash Reason"

export const FORM_COLUMN_CONFIG: Record<string, FormColumn[]> = {
  // Rewash
  "250165655616055": [
    submittedColumn(),
    siteColumn(),
    answerColumn(REWASH_REASON_KEY, "Rewash Reason")
  ],
  // Salt log
  "243523811897060": [
    submittedColumn(),
    siteColumn(),
    answerColumn("5", "Pounds of Ice Melt Used"),
    answerColumn("6", "Areas Ice Melt Applied"),
    answerColumn("8", "Name")
  ],
  // Retention
  "250855287972067": [
    submittedColumn(),
    siteColumn(),
    answerColumn("28", "Name"),
    answerColumn("29", "Email"),
    answerColumn("30", "Barcode/License Plate"),
    answerColumn("31", "Action Being Taken")
  ],
  // Time card edit (generic only — no per-form columns at v1)
  "250193775451056": [submittedColumn(), siteColumn()]
};

export const DEFAULT_COLUMNS: FormColumn[] = [submittedColumn(), siteColumn()];

export function columnsFor(formId: string): FormColumn[] {
  return FORM_COLUMN_CONFIG[formId] ?? DEFAULT_COLUMNS;
}
