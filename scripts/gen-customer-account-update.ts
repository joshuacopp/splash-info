// Generator for the "Customer Account Update" form (slug: customer-account-update).
//
//   npx tsx scripts/gen-customer-account-update.ts
//     (writes supabase/customer-account-update-form-01.sql)
//
// WHAT IT IS FOR. A customer asks for a change to their account (plate,
// barcode, phone, email, plan...). Whoever takes the request records it here;
// the SITE then works it as a ticket from /admin/approvals and marks it
// Updated, or Couldn't update with a note saying why.
//
// MODELLED ON cancellation-request (gen-cancellation-request.ts), same reasons:
//   - LINK-ONLY: filled on the site tablets without signing in.
//   - THE SITE IS THE APPROVER via the site_email lookup. The lookup has
//     resolved to an address by submit time, so payload_field is the right
//     source -- site_role would hunt for a location field this form does not
//     have (the Brief 131/132 bug class).
//   - site_email is allow_empty, not block_submit: a site with no site_email
//     must still be able to record a request. The ticket then shows as
//     "No approver resolved" on the admin All Approvals view.
//   - NO PER-SUBMISSION EMAIL. Sites learn of open tickets from the 12:00 UTC
//     "waiting on you" digest and work them at /admin/approvals.
//   - LOCATION-SCOPED: the site field is keyed `site_number`, so first publish
//     makes it the scope field and site admins see their own sites' tickets.
//
// "SUBMITTED BY" is the employee field (roster of the site typed above) with
// allowTyped, so a name that isn't on the roster can still be entered.
//
// "OTHER" NEEDS AN EXPLANATION. update_other is visible_if update_types
// includes other; visibility matches if ANY ticked box matches (client and
// server), so it shows even when other boxes are ticked too.

import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { Field, FormSchema, FormWorkflow } from "@splash/forms-schema";
import { formSchemaSchema, draftFormSchemaSchema } from "@splash/forms-schema";

const SLUG = "customer-account-update";
const SITE_KEY = "site_number"; // handlePublish finds the scope field by THIS key
const CREATED_BY = "f42882fd-ee5a-433e-b10b-713d5dff8a89";

function idFor(key: string): string {
  return createHash("sha1").update(`${SLUG}:${key}`).digest("hex").slice(0, 8);
}

const fields: Field[] = [];
function push(f: Omit<Field, "id"> & { id?: string }) {
  fields.push({ ...f, id: f.id ?? idFor(f.key) } as Field);
}

// --- Site ----------------------------------------------------------------------
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
    nullBehavior: "block_submit", // an unknown site number is a typo
    ...extra
  } as Field);
}
lookup("site_name", "Site", "location_pretty", { show_in_queue: true });
lookup("site_email", "Site email", "site_email", { nullBehavior: "allow_empty" });

// --- Customer ------------------------------------------------------------------
push({
  key: "account_barcode",
  type: "short_text",
  label: "Account barcode",
  required: true,
  maxLength: 40,
  show_in_queue: true
} as Field);
push({
  key: "customer_phone",
  type: "phone",
  label: "Customer phone",
  required: true,
  show_in_queue: true
} as Field);

// --- Who took it -----------------------------------------------------------------
push({
  key: "submitted_by",
  type: "employee",
  label: "Submitted by",
  helpText: "Start typing your name. Not listed? Type your full name and use it.",
  required: true,
  keyFieldKey: SITE_KEY,
  keyColumn: "pricing_simple.site",
  allowTyped: true
} as Field);

// --- The change ------------------------------------------------------------------
push({
  key: "update_types",
  type: "multi",
  label: "What needs to be updated?",
  helpText: "Tick everything that changes.",
  required: true,
  minSelected: 1,
  options: [
    { label: "License plate", value: "license_plate" },
    { label: "Barcode", value: "barcode" },
    { label: "Phone", value: "phone" },
    { label: "Email", value: "email" },
    { label: "Plan", value: "plan" },
    { label: "Other", value: "other" }
  ],
  show_in_queue: true
} as Field);
push({
  key: "update_other",
  type: "short_text",
  label: "Other - what needs updating?",
  required: true,
  maxLength: 200,
  visible_if: { field_key: "update_types", equals: ["other"] }
} as Field);
push({
  key: "updated_info",
  type: "long_text",
  label: "Updated info",
  helpText: "The new values, e.g. new plate ABC1234, new email name@example.com.",
  required: true,
  maxLength: 2000,
  rows: 4
} as Field);
push({
  key: "notes",
  type: "long_text",
  label: "Notes",
  helpText: "Optional. Anything else that would help the site make the change.",
  required: false,
  maxLength: 2000,
  rows: 3
} as Field);

// ---------------------------------------------------------------------------------
// site_review ("New") -> updated | not_updated
// ---------------------------------------------------------------------------------
const workflow: FormWorkflow = {
  default_stage: "site_review",
  stages: [
    {
      id: "site_review",
      label: "New",
      kind: "approval",
      approver_source: { type: "payload_field", field_key: "site_email" },
      transitions: [
        { to: "updated", label: "Updated" },
        { to: "not_updated", label: "Couldn't update", requires: { note: true } }
      ]
    },
    { id: "updated", label: "Updated", kind: "outcome", tint: "success", transitions: [] },
    { id: "not_updated", label: "Couldn't update", kind: "outcome", tint: "danger", transitions: [] }
  ]
};

const schema: FormSchema = { fields, workflow };

// --- Checks -------------------------------------------------------------------------
const ids = fields.map((f) => f.id);
const keys = fields.map((f) => f.key);
for (const [what, list] of [["id", ids], ["key", keys]] as const) {
  const dup = [...new Set(list.filter((x, i) => list.indexOf(x) !== i))];
  if (dup.length) throw new Error(`duplicate field ${what}s: ${dup.join(", ")}`);
}
const queued = fields.filter((f) => f.show_in_queue).length;
if (queued > 5) throw new Error(`show_in_queue on ${queued} fields; the queue shows 5`);
for (const f of fields) {
  if (f.visible_if) {
    const ctl = fields.find((c) => c.key === f.visible_if!.field_key);
    if (!ctl) throw new Error(`${f.key}: visible_if names unknown field`);
    if (ctl.visible_if) throw new Error(`${f.key}: chained visible_if via ${ctl.key}`);
  }
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

// --- SQL ------------------------------------------------------------------------------
const TAG = "$cau$";
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
if (JSON.stringify(schema).includes(TAG)) throw new Error("dollar tag collision");
const json = `${TAG}${JSON.stringify(schema)}${TAG}`;

const title = "Customer Account Update";
const description =
  "Record a customer's request to change their account. The site makes the change and marks it Updated.";
const success = "Thanks - the account update request is with the site.";

writeFileSync(
  "supabase/customer-account-update-form-01.sql",
  `-- Generated by scripts/gen-customer-account-update.ts -- edit that, not this file.
-- APPLIED 2026-11-18 via Supabase MCP: form_id 28450fb5-f1e2-4492-82f4-7ca6f94057e0,
--   draft_version_id b078a8a0-f23d-42d6-8c9f-00410dbe9f12.
-- Draft (unpublished). Re-runnable: upserts the forms row, creates a draft
-- version only when there is none, otherwise overwrites the draft schema.
--
--   slug ${SLUG}   audience link-only   ${fields.length} fields
--
-- Workflow: "New" (approver = the site_email lookup) -> Updated | Couldn't
-- update (note required). No per-submission email: sites see open tickets in
-- the 12:00 UTC digest and work them at /admin/approvals.
--
-- After applying, the operator reviews and publishes from /admin/forms.

insert into public.forms
  (slug, title, description, audience, status, notify_webhook,
   turnstile_required, success_message, created_by, last_edited_by)
values
  (${lit(SLUG)}, ${lit(title)}, ${lit(description)}, 'link-only', 'draft', false, false,
   ${lit(success)}, '${CREATED_BY}', '${CREATED_BY}')
on conflict (slug) do update
  set title = excluded.title,
      description = excluded.description,
      audience = excluded.audience,
      notify_webhook = excluded.notify_webhook,
      turnstile_required = excluded.turnstile_required,
      success_message = excluded.success_message,
      last_edited_at = now();

with f as (select id, draft_version_id from public.forms where slug = ${lit(SLUG)}),
ins as (
  insert into public.form_versions (form_id, version_number, is_draft, schema)
  select f.id, 1, true, ${json}::jsonb
    from f where f.draft_version_id is null
  returning id, form_id
)
update public.forms set draft_version_id = ins.id, last_edited_at = now()
  from ins where public.forms.id = ins.form_id;

update public.form_versions v
   set schema = ${json}::jsonb
  from public.forms f
 where f.slug = ${lit(SLUG)} and v.id = f.draft_version_id;

select f.id, f.slug, f.audience, f.status, f.draft_version_id,
       jsonb_array_length(v.schema->'fields') as fields
  from public.forms f join public.form_versions v on v.id = f.draft_version_id
 where f.slug = ${lit(SLUG)};
`
);
console.log(`ok  fields=${fields.length} stages=${workflow.stages.length}  -> supabase/customer-account-update-form-01.sql`);
