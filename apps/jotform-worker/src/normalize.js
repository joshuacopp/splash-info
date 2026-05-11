// Normalize a JotForm submission payload into a `jotform_submissions` row
// (Brief 107).
//
// JotForm's API returns the submission as:
//   { id, form_id, status, created_at, updated_at, answers: { <qid>: {...} }, ... }
//
// where each entry under `answers` carries a `name` field (the question
// key authored in the JotForm builder), a `type` field (e.g. `control_textbox`,
// `control_widget`, `control_head`), and — for actual answer-bearing
// fields — an `answer` or `prettyFormat` value. Form-definition entries
// (`control_head` headings, `control_pagebreak` page breaks,
// `control_button` buttons, `control_text` text blocks) carry no
// `answer` — strip them before storing to keep the JSONB compact.
//
// Three exported helpers:
//
//   stripAnswers(rawAnswers)
//     Drop noise types from the answers map. Keep everything else
//     (signature widgets without a captured signature are still
//     meaningful as "awaiting signature" state).
//
//   extractCommonFields(rawAnswers)
//     Walk the answers to find `site_number` / `site` / `site_email`
//     using the JotForm field-`name` convention agreed across the four
//     onboarded forms (rewash / salt-log / retention / time-card-edit):
//       - name === "typeA"                  → site_number (widget)
//       - name === "site"                   → site (textbox)
//       - name === "siteEmail" | "siteEmail56" → site_email
//                                           (retention has both; prefer
//                                           the email-typed one)
//
//   normalizeSubmission(raw)
//     Produce the canonical insert row.
//
// All fail-soft: missing → null.

const NOISE_TYPES = new Set([
  "control_head",
  "control_pagebreak",
  "control_button",
  "control_text"
]);

/**
 * Drop entries whose `type` is form-definition noise. Returns a new object;
 * does not mutate the input.
 */
export function stripAnswers(rawAnswers) {
  if (!rawAnswers || typeof rawAnswers !== "object") return {};
  const out = {};
  for (const key of Object.keys(rawAnswers)) {
    const entry = rawAnswers[key];
    if (!entry || typeof entry !== "object") continue;
    const type = typeof entry.type === "string" ? entry.type : "";
    if (NOISE_TYPES.has(type)) continue;
    out[key] = entry;
  }
  return out;
}

/**
 * Resolve the three common columns. Walks the answers object once,
 * preferring email-typed `siteEmail` over text-typed `siteEmail56` when
 * both are present (retention only). Returns `{ site_number, site,
 * site_email }` with nulls on miss.
 */
export function extractCommonFields(rawAnswers) {
  let siteNumber = null;
  let site = null;
  let siteEmailFromTyped = null;
  let siteEmailFromAny = null;

  if (!rawAnswers || typeof rawAnswers !== "object") {
    return { site_number: null, site: null, site_email: null };
  }

  for (const key of Object.keys(rawAnswers)) {
    const entry = rawAnswers[key];
    if (!entry || typeof entry !== "object") continue;
    const name = typeof entry.name === "string" ? entry.name : "";
    if (!name) continue;

    if (name === "typeA" && siteNumber == null) {
      siteNumber = stringValueOf(entry);
    } else if (name === "site" && site == null) {
      site = stringValueOf(entry);
    } else if (name === "siteEmail" || name === "siteEmail56") {
      const value = stringValueOf(entry);
      if (!value) continue;
      const type = typeof entry.type === "string" ? entry.type : "";
      // `control_email` is the typed control; prefer it when present so
      // retention's two-fields case lands on the email-shape answer.
      if (type === "control_email" && siteEmailFromTyped == null) {
        siteEmailFromTyped = value;
      } else if (siteEmailFromAny == null) {
        siteEmailFromAny = value;
      }
    }
  }

  return {
    site_number: siteNumber,
    site: site,
    site_email: siteEmailFromTyped ?? siteEmailFromAny
  };
}

/**
 * Build the canonical `jotform_submissions` insert row from a raw
 * JotForm submission payload. Returns an object whose keys match the
 * table columns one-for-one; the answers JSONB is the stripped map.
 *
 * `parseJotformDate` treats JotForm's `"YYYY-MM-DD HH:MM:SS"` format as
 * UTC (no timezone offset is present in the payload; if the operator
 * later confirms the timestamps are local, that's a v2 cleanup). Returns
 * an ISO 8601 string suitable for a Supabase `timestamptz` column.
 */
export function normalizeSubmission(raw) {
  if (!raw || typeof raw !== "object") {
    throw new Error("normalizeSubmission: raw payload missing");
  }
  const id = typeof raw.id === "string" ? raw.id : "";
  const formId = typeof raw.form_id === "string" ? raw.form_id : "";
  if (!id || !formId) {
    throw new Error("normalizeSubmission: id / form_id missing");
  }

  const stripped = stripAnswers(raw.answers);
  const common = extractCommonFields(raw.answers);

  return {
    id,
    form_id: formId,
    site_number: common.site_number,
    site: common.site,
    site_email: common.site_email,
    jotform_created_at: parseJotformDate(raw.created_at),
    jotform_updated_at: raw.updated_at ? parseJotformDate(raw.updated_at) : null,
    jotform_status: typeof raw.status === "string" ? raw.status : null,
    answers: stripped
  };
}

/**
 * Parse JotForm's `"YYYY-MM-DD HH:MM:SS"` timestamp into an ISO 8601
 * string. Treats the input as UTC for v1 — the operator's sample
 * payloads carry no timezone offset and JotForm Enterprise's default is
 * to render created_at in the account's local time, which is a v2 fix.
 *
 * Falls back to the input as-is when parsing fails; Supabase will reject
 * a malformed timestamptz at insert time so a downstream error surfaces.
 */
export function parseJotformDate(input) {
  if (!input) return null;
  if (typeof input !== "string") return null;
  // JotForm format: "2026-05-11 14:40:05"  → treat as UTC.
  const match = input.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/);
  if (match) return `${match[1]}T${match[2]}Z`;
  // Fallback for already-ISO timestamps; let Supabase validate.
  return input;
}

/**
 * Read the textual value of a single JotForm `answers` entry. Prefers the
 * `prettyFormat` field (human-readable, e.g., "Yes" for radio choices)
 * over `answer` (machine-shaped, e.g., raw widget id). Both can be
 * absent on form-definition entries.
 */
function stringValueOf(entry) {
  const pretty = entry.prettyFormat;
  if (typeof pretty === "string" && pretty.trim()) return pretty.trim();
  const answer = entry.answer;
  if (typeof answer === "string" && answer.trim()) return answer.trim();
  if (typeof answer === "number") return String(answer);
  return null;
}
