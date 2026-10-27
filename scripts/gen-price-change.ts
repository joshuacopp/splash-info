// Generator for the "Price change approval" form (slug: price-change).
//
// WHAT IT IS FOR. Marketing requests menu and price changes at one or more
// sites in a single request -- repricing, renaming or discontinuing packages,
// adding new packages, lube/detail service prices, plus signage and graphics
// for the whole request; Dan
// Petrelle approves (with a signature) or denies (with a note); the requester
// is emailed the result either way.
//
// IT DOES NOT CHANGE pricing_simple. Approval records the decision and
// nothing else: nothing reaches a customer until someone deliberately applies
// the new prices. Packages are LISTED from pricing_simple, but current prices
// are typed by the requester, because that table is not always current after
// a change.
//
// MULTI-SITE, ONE DECISION. The grid collects its own sites (multiSite), so a
// regional rollout is one request and one signature. All or nothing: Dan
// approves or denies the whole request (operator decision, 2026-10-24).
//
// SITE STAFF CANNOT SEE THESE REQUESTS, on purpose -- they are not part of the
// process. There is no `site_number` field any more, so submissions are not
// location-scoped: only admins and the workflow's own people (requester,
// approver) see them. The forms row keeps scope_location_field_key =
// 'site_number' from the single-site version; LEAVE IT. Clearing it to NULL
// would make the next publish re-inject a site_number field (admin/forms.ts
// handlePublish) and put requests back in front of location admins.
//
// DAN NEEDS NO LOGIN. His email carries {approval.link}, a no-sign-in link
// bound to this submission at the "dan_review" stage (approval-links/). He can
// also act from /admin/approvals if he does sign in.

import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { Field, FormSchema, FormWorkflow } from "@splash/forms-schema";
import { formSchemaSchema, draftFormSchemaSchema } from "@splash/forms-schema";

// Overridable for testing: APPROVER=me@example.com npx tsx ... so a test run
// never emails the real approver. The committed SQL is generated without it.
const APPROVER = process.env.APPROVER || "dpetrelle@splashcarwashes.com";

const fields: Field[] = [];
const push = (f: Field) => fields.push(f);

/** Hashed rather than truncated: truncation collided on an earlier form. */
function idFor(key: string): string {
  return createHash("sha1").update(`price-change:${key}`).digest("hex").slice(0, 8);
}

push({
  key: "packages",
  id: idFor("packages"),
  type: "package_price_grid",
  label: "Sites and changes",
  required: true,
  multiSite: true,
  keyFieldKey: "",
  keyColumn: "pricing_simple.site",
  // The site list is what tells one queued request from another.
  show_in_queue: true,
  helpText:
    "Add each site by its 3-digit number. At each site you can reprice, rename or discontinue a package, add a new package, and add lube and detail service prices. Enter current prices as they are today; leave a new price blank if it isn't changing."
} as Field);

// Signage / graphics for the whole request, not per site (operator decision,
// 2026-10-27). Images and PDFs; the approver sees them from the emailed link
// (approval-links/ serves the request's own uploads) and image thumbnails
// print on the decision PDF.
push({
  key: "signage",
  id: idFor("signage"),
  type: "file",
  label: "Signage & graphics",
  required: false,
  allowMultiple: true,
  allowedMimeTypes: ["image/*", "application/pdf"],
  maxSizeMb: 25,
  helpText: "Optional. Images or PDFs for this request; add as many as needed."
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
      subject_template: "Price change approval needed: {field.packages.sites}",
      body_template: [
        "{submitter.email} has requested a price change at {field.packages.sites}.",
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
      subject_template: "Approved: price change at {field.packages.sites}",
      body_template: [
        "Your price change request for {field.packages.sites} was {outcome.label} by {decision.by}.",
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
      subject_template: "Denied: price change at {field.packages.sites}",
      body_template: [
        "Your price change request for {field.packages.sites} was {outcome.label} by {decision.by}.",
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
