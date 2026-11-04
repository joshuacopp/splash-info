// Generator for the "Cancellation Request" form (slug: cancellation-request).
//
// WHAT IT IS FOR. A customer wants to cancel their MaxPass. Whoever takes the
// request records it here; the SITE then works it as a ticket -- try to save
// the customer, and mark the ticket Saved or Cancelled with a note saying what
// happened.
//
// STATUSES ARE WORKFLOW STAGES. New / Saved / Cancelled map onto one approval
// stage labelled "New" and two outcomes. Both actions OFFER a note but do not
// require one (operator decision, 2026-11-04); ongoing back-and-forth goes in
// the submission's comment thread (Brief 174), which moves nothing.
//
// LINK-ONLY, not internal (operator decision): the slug is the gate, so it can
// be filled without signing in. Still location-scoped on first publish.
//
// THE SITE IS THE APPROVER, via the site_email lookup. The lookup has already
// resolved to an address by submit time, so its payload value IS the email and
// payload_field is the right source -- site_role would make the resolver hunt
// for a location field this form does not have (the Brief 131/132 bug class).
//
// NO PER-SUBMISSION EMAIL, on purpose (operator decision, 2026-11-04). The site
// hears about new tickets from the existing daily "waiting on you" digest
// (cron/approval-digest.ts, 12:00 UTC), which counts every open item per form
// for each approver email, and works them from /admin/approvals.
//
// LOCATION-SCOPED. The site field is keyed `site_number`, so first publish
// designates it as the scope field instead of injecting a second one, and
// location admins see their own sites' tickets.
//
// "OTHER" NEEDS AN EXPLANATION. reason_other is visible_if reason = other and
// required; the submit path re-evaluates visibility server-side, so it blocks
// only when Other is chosen.

import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { Field, FormSchema, FormWorkflow } from "@splash/forms-schema";
import { formSchemaSchema, draftFormSchemaSchema } from "@splash/forms-schema";

const SITE_KEY = "site_number"; // handlePublish finds the scope field by THIS key

function idFor(key: string): string {
  return createHash("sha1").update(`cancellation-request:${key}`).digest("hex").slice(0, 8);
}

const fields: Field[] = [];
function push(f: Omit<Field, "id"> & { id?: string }) {
  fields.push({ ...f, id: f.id ?? idFor(f.key) } as Field);
}

push({
  key: SITE_KEY,
  type: "short_text",
  label: "Site number",
  helpText: "3-digit site number (leading zeros optional).",
  required: true,
  maxLength: 10
});
const SITE_ID = idFor(SITE_KEY);

function lookup(key: string, label: string, sourceColumn: string, extra: Partial<Field> = {}) {
  push({
    key,
    type: "lookup",
    label,
    required: false,
    sourceTable: "pricing_simple",
    sourceColumn,
    keyColumn: "pricing_simple.site",
    keyFieldId: SITE_ID,
    resolutionMode: "prefill_visible",
    // An unknown site number is a typo; refuse it rather than file a ticket
    // against no site.
    nullBehavior: "block_submit",
    ...extra
  } as Field);
}
lookup("site_name", "Site", "location_pretty", { show_in_queue: true });
// allow_empty, NOT block_submit: a site with no site_email (Brockport, today)
// must still be able to record a cancellation. The ticket then has no approver
// and shows as "No approver resolved" on the admin All Approvals view.
lookup("site_email", "Site email", "site_email", { nullBehavior: "allow_empty" });

push({
  key: "customer_name",
  type: "name",
  label: "Customer name",
  required: true,
  maxLength: 120,
  show_in_queue: true
});

push({
  key: "account_id",
  type: "short_text",
  label: "Account barcode or plate",
  helpText: "The barcode on the customer's account, or the license plate on it.",
  required: true,
  maxLength: 40,
  show_in_queue: true
});

push({
  key: "customer_phone",
  type: "phone",
  label: "Customer phone",
  required: true,
  show_in_queue: true
});

push({
  key: "reason",
  type: "radio",
  label: "Reason for cancellation",
  required: true,
  layout: "vertical",
  options: [
    { label: "Not using", value: "not_using" },
    { label: "Price/value", value: "price_value" },
    { label: "Moving", value: "moving" },
    { label: "Competitor better", value: "competitor_better" },
    { label: "Other", value: "other" }
  ],
  show_in_queue: true
});

push({
  key: "reason_other",
  type: "long_text",
  label: "Other reason (explain)",
  required: true,
  maxLength: 1000,
  rows: 3,
  visible_if: { field_key: "reason", equals: ["other"] }
});

// ---------------------------------------------------------------------------
// site_review ("New") -> saved | cancelled
// ---------------------------------------------------------------------------
const workflow: FormWorkflow = {
  default_stage: "site_review",
  stages: [
    {
      id: "site_review",
      label: "New",
      kind: "approval",
      approver_source: { type: "payload_field", field_key: "site_email" },
      transitions: [
        { to: "saved", label: "Saved" },
        { to: "cancelled", label: "Cancelled" }
      ]
    },
    { id: "saved", label: "Saved", kind: "outcome", tint: "success", transitions: [] },
    { id: "cancelled", label: "Cancelled", kind: "outcome", tint: "danger", transitions: [] }
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
const queued = fields.filter((f) => f.show_in_queue).length;
if (queued > 5) throw new Error(`show_in_queue on ${queued} fields; the queue shows 5`);

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

const out = process.argv[2] ?? "cancellation-request.json";
writeFileSync(out, JSON.stringify(schema));
console.log(`ok  fields=${fields.length} stages=${workflow.stages.length}  -> ${out}`);
