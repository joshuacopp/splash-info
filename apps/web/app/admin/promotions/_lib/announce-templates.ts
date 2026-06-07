// Brief 163 — apps/web announcement template types + client-safe helpers.
//
// Mirrors the worker's `AnnouncementTemplate` shape (see
// `apps/promo-worker/src/announce/templates.ts`). This module is
// CLIENT-SAFE — no `next/headers` / `cookies()` / server-only imports
// — so the AnnouncementComposeModal can import the type and
// `substituteTemplate` for the live preview.
//
// The server-side fetcher lives in `worker-fetch.ts` as
// `listAnnouncementTemplates()` and is consumed directly by the
// promo live-view page (`[id]/page.tsx`).

export interface TemplateFieldDef {
  key: string;
  label: string;
  type: "text" | "textarea" | "date";
  required: boolean;
  placeholder?: string;
  hint?: string;
}

export interface AnnouncementTemplate {
  id: string;
  name: string;
  description?: string;
  subjectTemplate: string;
  bodyTemplate: string;
  fields: TemplateFieldDef[];
}

const MONTH_SHORT_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"
];

function formatIsoDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!m) return iso;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return iso;
  return `${MONTH_SHORT_NAMES[month - 1]} ${day}, ${year}`;
}

/**
 * Client-side mirror of the worker's `substituteTemplate`. Used by the
 * compose modal's live preview. Keep the regex + behavior identical to
 * the worker so the preview matches what gets sent.
 *
 * Behavior:
 *   - Replace every `{key}` occurrence in `template` with `fields[key]`.
 *   - Missing values use empty string ("").
 *   - UNKNOWN placeholders (no matching key in `fields`) are LEFT IN
 *     PLACE — `{thisIsTypo}` survives verbatim.
 *   - Date-shaped values (YYYY-MM-DD) get reformatted to "MMM D, YYYY"
 *     before insertion.
 */
export function substituteTemplate(
  template: string,
  fields: Record<string, string>
): string {
  return template.replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (match, key: string) => {
    if (!Object.prototype.hasOwnProperty.call(fields, key)) return match;
    const raw = fields[key] ?? "";
    return formatIsoDate(raw);
  });
}
