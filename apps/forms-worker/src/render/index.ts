// Form body renderer — iterates the schema's fields, dispatches each to its
// per-type render module, wraps the result in a <form> with the submit
// button + (when audience === "public") the Turnstile widget.

import type {
  Field,
  FormMeta,
  FormVersion,
  LocationOption
} from "@splash/forms-schema";
import { renderField } from "./fields/index.js";
import { escapeHtml } from "./util.js";

const HEADING_RANK: Record<string, number> = { h1: 1, h2: 2, h3: 3, h4: 4 };

/**
 * The heading level this form uses for its top-level sections: the most
 * significant level actually present, not a hardcoded guess. A form heading
 * everything h3 (rm-visit) sections on h3; one using h2 for parts and h3 for
 * sub-parts sections on h2 and treats the h3s as sub-headings.
 *
 * Null when the schema has no headings at all, which is most forms.
 */
function sectionHeadingRank(fields: Field[]): number | null {
  const ranks = fields
    .filter((f) => f.type === "heading")
    .map((f) => HEADING_RANK[(f as { level: string }).level])
    .filter((n): n is number => typeof n === "number");
  return ranks.length > 0 ? Math.min(...ranks) : null;
}

/**
 * Group the field list into `<section>` runs, one per top-level heading.
 *
 * THE SECTION WRAPPER IS WHAT MAKES THE STICKY HEADINGS CORRECT, and it is the
 * whole reason this function exists. `position: sticky` is bounded by its
 * containing block, so a heading inside its own section releases the moment
 * that section scrolls past. Sticking headings in the flat list instead -- every
 * field a sibling of every other -- leaves the last sub-heading of a section
 * pinned underneath the NEXT section's heading, with nothing following it to
 * push it out. You would be told you are in "Marketing / Visibility" while
 * answering the Scores.
 *
 * Fields before the first heading (site number, date, the lookups) stay
 * unwrapped: they belong to no section and pinning them would waste the top of
 * every screen.
 */
function renderFieldsGrouped(fields: Field[], args: RenderBodyArgs): string {
  const rank = sectionHeadingRank(fields);
  if (rank === null) {
    return fields.map((field) => renderField(field, args)).join("\n");
  }
  const out: string[] = [];
  let open = false;
  for (const field of fields) {
    const breaksSection =
      field.type === "heading" && HEADING_RANK[field.level] === rank;
    if (breaksSection) {
      if (open) out.push("</section>");
      out.push('<section class="forms-section">');
      open = true;
    }
    out.push(renderField(field, args));
  }
  if (open) out.push("</section>");
  return out.join("\n");
}

export interface RenderBodyArgs {
  form: FormMeta;
  version: FormVersion;
  /** Pre-baked option list for any Location-type fields. Empty when the
   *  schema contains no Location field. */
  locationOptions: LocationOption[];
  /** UUID generated at render time; client uses it as the FormData key
   *  for upload routing in Brief 92 + the submit-idempotency key in
   *  Brief 91. */
  pendingSubmissionId: string;
  /** When set, the Turnstile <div class="cf-turnstile"> is rendered. */
  turnstileSiteKey?: string;
  /** URL search params from the GET; consumed by Hidden fields'
   *  `defaultValueFromUrlParam`. */
  urlParams: URLSearchParams;
}

export function renderFormBody(args: RenderBodyArgs): string {
  const fieldsHtml = renderFieldsGrouped(args.version.schema.fields, args);

  const turnstileWidget = args.turnstileSiteKey
    ? `<div class="turnstile-wrap"><div class="cf-turnstile" data-sitekey="${escapeHtml(args.turnstileSiteKey)}"></div></div>`
    : "";

  return `
<form action="/forms/api/submit/${escapeHtml(args.form.slug)}" method="post" enctype="multipart/form-data" class="forms-body">
  <input type="hidden" name="pending_submission_id" value="${escapeHtml(args.pendingSubmissionId)}" />
  ${fieldsHtml}
  ${turnstileWidget}
  <button type="submit" class="submit-btn">Submit</button>
</form>
`;
}
