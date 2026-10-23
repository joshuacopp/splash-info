// Generator for the "Price change approval" form (slug: price-change).
//
// WHAT IT IS FOR. Marketing requests a package price change at one site; Dan
// Petrelle approves (with a signature) or denies (with a note); the requester
// is emailed the result either way.
//
// IT DOES NOT CHANGE pricing_simple. Approval records the decision and
// nothing else: nothing reaches a customer until someone deliberately applies
// the new prices. Packages are LISTED from pricing_simple, but current prices
// are typed by the requester, because that table is not always current after
// a change.
//
// THE SITE FIELD IS KEYED `site_number` ON PURPOSE. Publishing an internal
// form designates that key as the form's location scope (admin/forms.ts
// handlePublish) and the submit path then rejects any site number that is not
// a real location -- exactly right here. Any other key would make the first
// publish APPEND a second, duplicate "Site number" field.
//
// DAN NEEDS NO LOGIN. His email carries {approval.link}, a no-sign-in link
// bound to this submission at the "dan_review" stage (approval-links/). He can
// also act from /admin/approvals if he does sign in.

import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { Field, FormSchema, FormWorkflow } from "@splash/forms-schema";
import { formSchemaSchema, draftFormSchemaSchema } from "@splash/forms-schema";

const APPROVER = "dpetrelle@splashcarwashes.com";

const fields: Field[] = [];
const push = (f: Field) => fields.push(f);

/** Hashed rather than truncated: truncation collided on an earlier form. */
function idFor(key: string): string {
  return createHash("sha1").update(`price-change:${key}`).digest("hex").slice(0, 8);
}

push({
  key: "site_number",
  id: idFor("site_number"),
  type: "short_text",
  label: "Site number",
  required: true,
  maxLength: 3,
  helpText: "The 3-digit site number, e.g. 019.",
  show_in_queue: true
} as Field);

push({
  key: "site_name",
  id: idFor("site_name"),
  type: "lookup",
  label: "Site",
  required: true,
  keyFieldId: idFor("site_number"),
  keyColumn: "pricing_simple.site",
  sourceTable: "pricing_simple",
  sourceColumn: "location_pretty",
  resolutionMode: "prefill_visible",
  nullBehavior: "block_submit",
  show_in_queue: true
} as Field);

push({
  key: "packages",
  id: idFor("packages"),
  type: "package_price_grid",
  label: "Packages affected",
  required: true,
  keyFieldKey: "site_number",
  keyColumn: "pricing_simple.site",
  helpText:
    "Enter the current single and monthly price as they are today. Leave a new price blank if it isn't changing."
} as Field);

push({
  key: "notes",
  id: idFor("notes"),
  type: "long_text",
  label: "Notes for the approver",
  required: false,
  maxLength: 2000,
  helpText: "Optional: reason for the change, timing, anything Dan should know."
} as Field);

// ---------------------------------------------------------------------------
// notify_dan (email) -> dan_review (approval) -> approved_email | denied_email
//   -> approved | denied (outcomes)
// ---------------------------------------------------------------------------
const toSubmitter = [{ type: "payload_field" as const, field_key: "submitter.email" }];

const workflow: FormWorkflow = {
  default_stage: "notify_dan",
  stages: [
    {
      id: "notify_dan",
      label: "Email Dan",
      kind: "email",
      recipients: [{ type: "static_emails", emails: [APPROVER] }],
      subject_template: "Price change approval needed: {field.site_name} ({field.site_number})",
      body_template: [
        "{submitter.email} has requested a price change at {field.site_name} (site {field.site_number}).",
        "{payload.summary}",
        "{approval.link}",
        "The link works without signing in and expires in 7 days. Approving needs your signature; denying needs a short note."
      ].join("\n\n"),
      transitions: [{ to: "dan_review", label: "Sent" }]
    },
    {
      id: "dan_review",
      label: "Dan's approval",
      kind: "approval",
      approver_source: { type: "static_emails", emails: [APPROVER] },
      transitions: [
        { to: "approved_email", label: "Approve", requires: { signature: true } },
        { to: "denied_email", label: "Deny", requires: { note: true } }
      ]
    },
    {
      id: "approved_email",
      label: "Email approval",
      kind: "email",
      recipients: toSubmitter,
      attach_pdf: true,
      subject_template: "Approved: price change at {field.site_name} ({field.site_number})",
      body_template: [
        "Your price change request for {field.site_name} (site {field.site_number}) was {outcome.label} by {decision.by}.",
        "{payload.summary}",
        "The signed approval is attached. Prices have not been changed yet; this records the approval only.",
        "{submission.url}"
      ].join("\n\n"),
      transitions: [{ to: "approved", label: "Sent" }]
    },
    {
      id: "denied_email",
      label: "Email denial",
      kind: "email",
      recipients: toSubmitter,
      attach_pdf: true,
      subject_template: "Denied: price change at {field.site_name} ({field.site_number})",
      body_template: [
        "Your price change request for {field.site_name} (site {field.site_number}) was {outcome.label} by {decision.by}.",
        "Reason: {decision.note}",
        "{payload.summary}",
        "{submission.url}"
      ].join("\n\n"),
      transitions: [{ to: "denied", label: "Sent" }]
    },
    { id: "approved", label: "Approved", kind: "outcome", tint: "success", transitions: [] },
    { id: "denied", label: "Denied", kind: "outcome", tint: "danger", transitions: [] }
  ]
};

const schema: FormSchema = { fields, workflow };

// ---------------------------------------------------------------------------
const ids = fields.map((f) => f.id);
const keys = fields.map((f) => f.key);
for (const [what, list] of [["id", ids], ["key", keys]] as const) {
  const dup = [...new Set(list.filter((x, i) => list.indexOf(x) !== i))];
  if (dup.length) throw new Error(`duplicate field ${what}s: ${dup.join(", ")}`);
}

for (const [name, v] of [
  ["strict", formSchemaSchema],
  ["draft", draftFormSchemaSchema]
] as const) {
  const r = v.safeParse(schema);
  if (!r.success) {
    console.error(`${name} validation FAILED`);
    console.error(JSON.stringify(r.error.issues.slice(0, 12), null, 2));
    process.exit(1);
  }
}

const out = process.argv[2] ?? "price-change.json";
writeFileSync(out, JSON.stringify(schema));
console.log(`ok  fields=${fields.length} stages=${workflow.stages.length}  -> ${out}`);
