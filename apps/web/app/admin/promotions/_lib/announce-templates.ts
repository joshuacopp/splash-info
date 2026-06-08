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

/**
 * Brief 166 item 4 — minimal projection of a recent promo, scoped to the
 * fields the compose modal's autofill picker needs. The detail page
 * fetches these via `listPromos({ limit: 10 })` and passes them in as
 * a prop on `AnnouncementComposeModal`.
 *
 * Defined here (the client-safe module) so the modal can import the type
 * without dragging the SSR-only worker-fetch surface into the bundle.
 */
export interface RecentPromoForAutofill {
  id: string;
  title: string;
  /** Stored value (e.g. "Same", "BOGO"); display labels are computed by
   *  the picker. Drives the offerings-text preset in the modal. */
  promoType: string;
  /** ISO YYYY-MM-DD. */
  proposedStartDate: string;
  /** ISO YYYY-MM-DD. */
  proposedEndDate: string;
  /** ISO timestamp; rendered with formatEst for the option label. */
  createdAt: string;
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

/**
 * Brief 166 items 5 & 6 — client mirror of the worker's
 * `computeMaterialsPtpCopy` in `apps/promo-worker/src/announce/templates.ts`.
 * Used by the compose modal's inline `<pre>` live preview so what the
 * operator sees in the preview pane matches what the worker computes at
 * send / iframe-preview time. Keep wording identical to the worker — the
 * authoritative iframe preview comes from `/announce/preview`, so any
 * drift between the two would surface as a confusing mismatch between
 * the inline preview and the iframe.
 */
export function computeMaterialsPtpCopy(opts: {
  hasMaterials: boolean;
  includePtp: boolean;
}): { materialsPtpNote: string; materialsPtpBody: string } {
  const { hasMaterials, includePtp } = opts;
  let materialsPtpNote: string;
  if (hasMaterials && includePtp) {
    materialsPtpNote =
      "Please see the attached materials, and the PTP included below.";
  } else if (hasMaterials) {
    materialsPtpNote = "Please see the attached materials.";
  } else if (includePtp) {
    materialsPtpNote = "The PTP is included below.";
  } else {
    materialsPtpNote =
      "There will be an announcement with more details, materials, and the PTP coming your way shortly!";
  }
  let materialsPtpBody: string;
  if (hasMaterials && includePtp) {
    materialsPtpBody =
      "Attached you'll find the marketing materials and the Purpose/Tools/Process document for this special.";
  } else if (hasMaterials) {
    materialsPtpBody =
      "Attached you'll find the marketing materials for this special.";
  } else if (includePtp) {
    materialsPtpBody =
      "Below you'll find the Purpose/Tools/Process document for this special.";
  } else {
    materialsPtpBody = "Materials and the PTP will follow shortly.";
  }
  return { materialsPtpNote, materialsPtpBody };
}
