// Digest table as Outlook-safe HTML (inline styles) and as plain text.

import { escapeHtml } from "@splash/email-shell";
import type { TableData } from "./aggregate.js";

const NAVY = "#0b2a4a";
const INK_2 = "#52514e";
const RULE = "#e6e5e1";

function cell(v: string, o: { right?: boolean; bold?: boolean; bg?: string; head?: boolean } = {}): string {
  const tag = o.head ? "th" : "td";
  const style = [
    "padding:6px 8px",
    `border-bottom:1px solid ${RULE}`,
    `text-align:${o.right ? "right" : "left"}`,
    "font-size:13px",
    o.bold || o.head ? "font-weight:bold" : "",
    o.head ? `color:${INK_2}` : "",
    o.bg ? `background:${o.bg}` : ""
  ]
    .filter(Boolean)
    .join(";");
  return `<${tag} style="${style}">${escapeHtml(v)}</${tag}>`;
}

export function renderTableHtml(t: TableData): string {
  const cols = t.columns.length;
  const rows: string[] = [];
  rows.push(`<tr>${t.columns.map((c, i) => cell(c, { head: true, right: i >= t.numericFrom })).join("")}</tr>`);
  for (const s of t.sections) {
    if (s.title) {
      rows.push(`<tr><td colspan="${cols}" style="padding:12px 8px 6px 8px;font-size:14px;font-weight:bold;color:${NAVY};border-bottom:2px solid ${NAVY};">${escapeHtml(s.title)}</td></tr>`);
    }
    for (const r of s.rows) rows.push(`<tr>${r.map((v, i) => cell(v, { right: i >= t.numericFrom })).join("")}</tr>`);
    if (s.total) rows.push(`<tr>${s.total.map((v, i) => cell(v, { right: i >= t.numericFrom, bold: true, bg: "#f6f6f4" })).join("")}</tr>`);
  }
  if (t.grandTotal) rows.push(`<tr>${t.grandTotal.map((v, i) => cell(v, { right: i >= t.numericFrom, bold: true, bg: "#eceae5" })).join("")}</tr>`);
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:20px;border-collapse:collapse;">${rows.join("")}</table>`;
}

export function renderTableText(t: TableData): string[] {
  const out: string[] = [t.columns.join(" | ")];
  for (const s of t.sections) {
    if (s.title) out.push("", s.title);
    for (const r of s.rows) out.push(r.join(" | "));
    if (s.total) out.push(s.total.join(" | "));
  }
  if (t.grandTotal) out.push("", t.grandTotal.join(" | "));
  return out;
}

