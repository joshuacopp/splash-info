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
  /** Opened from an emailed "continue later" link: the saved answers to put
   *  back, and the draft's token so later saves update the same draft. */
  serverDraft?: { token: string; values: Record<string, unknown>; emailMasked: string; savedAt: string };
}

/** JSON safe inside a <script> element: nothing can close the tag. */
function scriptJson(v: unknown): string {
  return JSON.stringify(v).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}

/** "Save and continue later" (forms.email_drafts). Wired by forms-public.js. */
function renderSaveLater(args: RenderBodyArgs): string {
  if (!args.form.emailDrafts) return "";
  const d = args.serverDraft;
  const data = d
    ? `<script type="application/json" id="forms-server-draft">${scriptJson({ values: d.values, emailMasked: d.emailMasked, savedAt: d.savedAt })}</script>`
    : "";
  return `<div class="forms-save-later" data-forms-save-later="1" style="margin:20px 0 8px 0;padding:14px;border:1px solid #c9d6e8;border-radius:8px;background:#f5f8fc;">
    <input type="hidden" name="_draft_token" value="${d ? escapeHtml(d.token) : ""}" />
    <button type="button" data-save-later-open style="cursor:pointer;padding:9px 14px;border-radius:6px;border:1px solid #1e5fa8;background:#fff;color:#1e5fa8;font-weight:600;font-size:15px;">Save and continue later</button>
    <div data-save-later-panel hidden style="margin-top:12px;">
      <label style="display:block;font-size:14px;font-weight:600;margin-bottom:4px;" for="forms-save-later-email">Your Splash email address</label>
      <input id="forms-save-later-email" type="email" autocomplete="off" inputmode="email" placeholder="name@splashcarwashes.com" style="width:100%;max-width:360px;padding:9px;border:1px solid #c9c9c9;border-radius:6px;font-size:15px;" />
      <button type="button" data-save-later-send style="cursor:pointer;margin-top:8px;padding:9px 14px;border-radius:6px;border:1px solid #1e5fa8;background:#1e5fa8;color:#fff;font-weight:600;font-size:15px;">Email me a link</button>
      <p style="margin:8px 0 0 0;font-size:13px;color:#555;">We'll email you a private link that reopens this form with your answers. It works for 14 days after your last save. Splash email addresses only. Don't forward the link: anyone who has it can open your answers.</p>
    </div>
    <div data-save-later-status role="status" style="margin-top:8px;font-size:14px;color:#0a2240;"></div>
  </div>
  ${data}`;
}

export function renderFormBody(args: RenderBodyArgs): string {
  const fieldsHtml = renderFieldsGrouped(args.version.schema.fields, args);

  const turnstileWidget = args.turnstileSiteKey
    ? `<div class="turnstile-wrap"><div class="cf-turnstile" data-sitekey="${escapeHtml(args.turnstileSiteKey)}"></div></div>`
    : "";

  // Test mode: the filler should know nobody real is being emailed. The test
  // address itself is not shown -- link-only forms are open to anyone with the URL.
  const testBanner = args.form.testMode
    ? `<div role="status" style="margin:0 0 16px 0;padding:10px 14px;border-radius:8px;background:#fff7e6;border:1px solid #eda100;color:#5c3d00;font-size:14px;font-weight:600;">TEST MODE - emails from this form go to a test address, not the usual recipients.</div>`
    : "";

  return `${testBanner}
<form action="/forms/api/submit/${escapeHtml(args.form.publicKey ?? args.form.slug)}" method="post" enctype="multipart/form-data" class="forms-body"${args.form.emailDrafts ? ' data-email-drafts="1"' : ""}>
  <input type="hidden" name="pending_submission_id" value="${escapeHtml(args.pendingSubmissionId)}" />
  ${fieldsHtml}
  ${turnstileWidget}
  ${renderSaveLater(args)}
  <button type="submit" class="submit-btn">Submit</button>
</form>
`;
}
