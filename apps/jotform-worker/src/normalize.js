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
 * America/New_York wall-clock (the Splash JotForm Enterprise account's
 * local zone) and converts to a true UTC ISO 8601 string suitable for
 * a Supabase `timestamptz` column. See Brief 114.
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
 * Parse JotForm's `"YYYY-MM-DD HH:MM:SS"` timestamp into a true UTC
 * ISO 8601 string. JotForm Enterprise's API returns submission
 * timestamps in the account's local timezone (America/New_York for
 * Splash) WITHOUT an explicit offset; this helper attaches the
 * correct DST-aware offset and converts to UTC.
 *
 * Brief 111 originally chose option (a) (display-only conversion,
 * treating the input as already-UTC) based on a sample row whose
 * `+00:00` suffix was actually this function's PRIOR buggy output,
 * not JotForm input. Brief 114 corrected this — option (b): parse
 * as Eastern local, convert to true UTC at ingest, let
 * `formatEst()` continue to convert back to Eastern for display.
 *
 * Falls back to returning the input verbatim if the shape doesn't
 * match — Supabase will reject a malformed timestamptz at insert
 * so downstream errors surface.
 */
export function parseJotformDate(input) {
  if (!input) return null;
  if (typeof input !== "string") return null;
  const match = input.match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/
  );
  if (!match) {
    // Already-ISO (or malformed) — pass through.
    return input;
  }
  const [, yyyy, mm, dd, hh, mi, ss] = match;
  const y = Number.parseInt(yyyy, 10);
  const mo = Number.parseInt(mm, 10);
  const d = Number.parseInt(dd, 10);
  const h = Number.parseInt(hh, 10);
  const mins = Number.parseInt(mi, 10);
  const s = Number.parseInt(ss, 10);
  const offsetMinutes = easternOffsetMinutesForWallClock(y, mo, d, h, mins, s);
  // offsetMinutes is negative (e.g., -240 for EDT, -300 for EST)
  // because America/New_York is behind UTC. To convert the wall
  // clock to UTC we subtract the offset (i.e., add |offset|).
  const wallAsIfUtc = Date.UTC(y, mo - 1, d, h, mins, s);
  const realUtc = wallAsIfUtc - offsetMinutes * 60_000;
  return new Date(realUtc).toISOString();
}

/**
 * Return the offset (in minutes) of America/New_York at the given
 * wall-clock moment. Negative because NY is behind UTC; -240 in
 * EDT, -300 in EST.
 *
 * Approach: pretend the wall-clock components describe a UTC moment,
 * then ask Intl what NY's offset is at that moment. For all wall-
 * clocks outside the DST-ambiguous hour (2-3 AM on spring-forward
 * Sundays), this matches the offset Eastern users would expect.
 * The ambiguous hour resolves to whichever side `Intl` reports —
 * safe enough for JotForm timestamps where ambiguity is rare and
 * a 1-hour drift on those edge rows is acceptable.
 */
function easternOffsetMinutesForWallClock(y, mo, d, h, mi, s) {
  const probe = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  // Use Intl to format the probe Date in NY, then read the
  // `shortOffset` token (e.g., "GMT-4" or "GMT-5"). Parse to minutes.
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    timeZoneName: "shortOffset"
  });
  const parts = formatter.formatToParts(probe);
  const tz = parts.find((p) => p.type === "timeZoneName")?.value;
  if (!tz) return -300; // safe default: EST
  // Match "GMT-4" / "GMT-5" / "GMT+0" / "GMT-04:30" etc.
  const m = tz.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  if (!m) return -300;
  const sign = m[1] === "+" ? 1 : -1;
  const hours = Number.parseInt(m[2], 10);
  const mins = m[3] ? Number.parseInt(m[3], 10) : 0;
  return sign * (hours * 60 + mins);
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
