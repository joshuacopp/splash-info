// Brief 163 — promo announcement template registry.
//
// Server-defined library of fillable announcement templates. The compose
// modal renders the per-field inputs in place of the freeform Subject +
// Body textareas; the worker substitutes the operator-supplied values
// into the template strings, then runs the SAME render path
// (`renderAnnouncement`) as a freeform send. Resulting subject + plain
// text + HTML ride the queue exactly as freeform sends do.
//
// Registry is code-defined at v1. Adding a new template is a one-file
// PR on this module. UI-managed templates (operator adds / edits via
// admin UI) are v2 and would require a new `promo_announcement_templates`
// table + admin CRUD + a permission model decision.
//
// Conventions:
//   - Field `key`s match `{key}` placeholders in `subjectTemplate` and
//     `bodyTemplate`. The substitution regex is a literal `{key}` match;
//     unknown placeholders survive in the output (defensive — see
//     `substituteTemplate` below).
//   - Field `key`s use camelCase; templates are English-only.
//   - `type: "date"` field values are operator-supplied YYYY-MM-DD ISO
//     strings (HTML5 `<input type=date>`). The substitute reformats to
//     "MMM D, YYYY" before insertion for legibility in email bodies.
//   - HTML special chars in operator-supplied values are NOT escaped
//     here — escaping happens downstream in `render-html.ts` per the
//     Brief 160 contract (the renderer treats the substituted body as
//     plain text and escapes for HTML output).

export interface TemplateFieldDef {
  /** Matches `{key}` placeholders in subjectTemplate / bodyTemplate. */
  key: string;
  /** Operator-facing label. */
  label: string;
  type: "text" | "textarea" | "date";
  required: boolean;
  placeholder?: string;
  hint?: string;
}

export interface AnnouncementTemplate {
  /** Stable identifier; persisted on `promo_announcements.template_id`. */
  id: string;
  /** Operator-facing dropdown label. */
  name: string;
  /** Muted helper text below the picker. */
  description?: string;
  subjectTemplate: string;
  bodyTemplate: string;
  fields: TemplateFieldDef[];
}

export const ANNOUNCEMENT_TEMPLATES: ReadonlyArray<AnnouncementTemplate> = [
  {
    id: "new_special_heads_up",
    name: "New special — heads up",
    description:
      "Initial heads-up to the field that a new special is coming. Materials and PTP follow later.",
    subjectTemplate: "Coming soon: {specialName}",
    bodyTemplate:
      "We're announcing a new special that will be rolling out at your site soon!\n\n" +
      "The special will be {specialName}, and will offer customers {kioskBehavior}.\n\n" +
      "The special is planned to run from {startDate} to {endDate}.\n\n" +
      // Brief 166 item 5 — `{materialsPtpNote}` is NOT an operator field.
      // The worker fills it via a second `substituteTemplate` pass after
      // resolving materials + PTP. See `computeMaterialsPtpCopy`.
      "{materialsPtpNote}\n\n" +
      "{signature}",
    fields: [
      {
        key: "specialName",
        label: "Special name",
        type: "text",
        required: true,
        placeholder: "e.g. Family Plan BOGO"
      },
      {
        // Brief 166 item 4 — label-only change. Key remains `kioskBehavior`
        // so the body template's `{kioskBehavior}` placeholder is unchanged
        // and existing announcement snapshots referencing the old label
        // continue to resolve.
        key: "kioskBehavior",
        label: "Promo offerings for customers",
        type: "textarea",
        required: true,
        placeholder: "What the customer experiences at the kiosk"
      },
      { key: "startDate", label: "Start date", type: "date", required: true },
      { key: "endDate", label: "End date", type: "date", required: true },
      {
        key: "signature",
        label: "Signature",
        type: "text",
        required: false,
        placeholder: "— The Splash team",
        hint: "Optional. Blank line if omitted."
      }
    ]
  },
  {
    id: "materials_ptp_followup",
    name: "Materials & PTP follow-up",
    description: "The follow-up to a heads-up send. Materials and PTP are now ready.",
    subjectTemplate: "Now available: materials + PTP for {specialName}",
    bodyTemplate:
      "Following up on the {specialName} announcement!\n\n" +
      // Brief 166 item 6 — `{materialsPtpBody}` is NOT an operator field;
      // the worker substitutes it post-resolve. See `computeMaterialsPtpCopy`.
      "{materialsPtpBody}\n\n" +
      "Please review and reach out to your manager with any questions.\n\n" +
      "{signature}",
    fields: [
      { key: "specialName", label: "Special name", type: "text", required: true },
      { key: "signature", label: "Signature", type: "text", required: false }
    ]
  },
  {
    id: "end_of_promo",
    name: "End-of-promo wrap-up",
    description: "Sent at the end of a promo's run.",
    subjectTemplate: "Wrap-up: {specialName} ended {endDate}",
    bodyTemplate:
      "The {specialName} special ended on {endDate}.\n\n" +
      "{recapText}\n\n" +
      "Thanks for everything you did to make this run successful!\n\n" +
      "{signature}",
    fields: [
      { key: "specialName", label: "Special name", type: "text", required: true },
      { key: "endDate", label: "End date", type: "date", required: true },
      {
        key: "recapText",
        label: "Recap notes",
        type: "textarea",
        required: false,
        hint: "Optional. Results, learnings, thank-yous."
      },
      { key: "signature", label: "Signature", type: "text", required: false }
    ]
  }
];

/**
 * Look up a template by id. Returns undefined for unknown ids — the
 * worker turns that into a 400 `unknown_template`.
 */
export function findTemplate(id: string): AnnouncementTemplate | undefined {
  return ANNOUNCEMENT_TEMPLATES.find((t) => t.id === id);
}

const MONTH_SHORT_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"
];

/**
 * Reformat an ISO YYYY-MM-DD date string into "MMM D, YYYY" for in-body
 * legibility. Returns the input unchanged if it doesn't parse as
 * YYYY-MM-DD — defensive against operator pasting a pre-formatted value.
 */
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
 * Substitute every `{key}` occurrence in `template` with `fields[key]`.
 *
 * Behavior:
 *   - Missing values use empty string ("").
 *   - UNKNOWN placeholders (no matching key in `fields`) are LEFT IN
 *     PLACE — `{thisIsTypo}` survives verbatim. Defensive: future
 *     templates with stale placeholders would otherwise emit empty
 *     strings silently and operators wouldn't notice.
 *   - Date-shaped values (YYYY-MM-DD) get reformatted to "MMM D, YYYY"
 *     before insertion. The substitute function is field-type-agnostic,
 *     but the date reformat is safe to apply unconditionally because
 *     text/textarea inputs aren't YYYY-MM-DD-shaped.
 *   - No HTML escaping — the downstream renderer (render-html.ts)
 *     treats the body as plain text and escapes for HTML output.
 *
 * Keep the regex + substitution shape stable: the apps/web modal
 * duplicates this function client-side for the live preview.
 */
export function substituteTemplate(
  template: string,
  fields: Record<string, string>
): string {
  return template.replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (match, key: string) => {
    if (!Object.prototype.hasOwnProperty.call(fields, key)) {
      // Unknown placeholder — leave in place.
      return match;
    }
    const raw = fields[key] ?? "";
    return formatIsoDate(raw);
  });
}

/**
 * Brief 166 items 5 & 6 — compute the "what's actually attached" copy
 * that gets folded into the heads-up and follow-up templates at SEND
 * time (not at template-author time). The placeholders
 * `{materialsPtpNote}` (heads-up trailing line) and `{materialsPtpBody}`
 * (follow-up body sentence) are NOT operator fields — they survive
 * `substituteTemplate`'s first pass verbatim and get filled by a SECOND
 * `substituteTemplate` pass in `handleSendAnnouncement` /
 * `handlePreviewAnnouncement` once `resolvedMaterials` + `payload.includePtp`
 * are known. The worker is authoritative; the modal mirrors this helper
 * client-side for the inline preview only.
 *
 * Keep this function identically defined in
 * `apps/web/app/admin/promotions/_lib/announce-templates.ts` —
 * same dual-definition pattern as `substituteTemplate`.
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
