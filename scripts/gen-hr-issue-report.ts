// Generator for the "HR Issue Report" form (slug: hr-issue-report), 2026-11-16.
//
// WHAT IT IS FOR. Any employee scans a QR code posted at their site and reports
// an HR concern. Location and the complaint are required; name / email / phone
// are optional, so a report can be anonymous.
//
// RECIPIENTS. Every submission is emailed to HR (HR_TO below; operator:
// slowe@ and melissa.lavranchuk@). They did not have splashcarwashes.info
// logins when this was built -- the EMAIL does not need one, the ticket view
// does (see below). HR_TO=a@x,b@y overrides.
//
// IT IS A TICKET. After the email the submission waits in an "Open" stage with
// HR as its approvers, so once HR have logins it shows on /admin/approvals
// ("Needs your action"), they can comment on it (Brief 174) and close it as
// Resolved or Closed - no action. Approver emails are plain strings
// (static_emails), so nothing breaks before the accounts exist. While a report
// is Open, HR are also counted in the daily "waiting on you" digest.
// Not wanted as tickets? Point the email step straight at the outcome.
//
// LINK-ONLY BEHIND A SECRET LINK (forms.link_key): the QR code encodes
// /forms/{link_key}; change the link on the builder's Settings tab and every
// old QR code stops working at once (print new ones).
//
// CONFIDENTIAL, NOT SITE-SCOPED (scope_location_field_key = 'none:confidential';
// the site field is a `location` field keyed `location`, never `site_number`)
// -- site managers must never see these. Only admins and people given access
// see submissions. Confidential forms also keep no autosaved copy in the
// browser (shared site tablets). notify_webhook = false.
//
// NOT save-and-continue (email_drafts off): anonymous reporters have no Splash
// address to send a resume link to.
//
// IN TEST MODE (forms.test_email_to) until the operator switches it off on the
// Settings tab.
//
// AUTO-DELETE is not built. If HR wants submissions removed after N days it is
// a small scheduled delete on form_submissions for this form (decide first
// whether Resolved tickets should be kept).
//
//   npx tsx scripts/gen-hr-issue-report.ts      (writes supabase/hr-issue-report-01.sql)

import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { Field, FormSchema, FormWorkflow } from "@splash/forms-schema";
import { formSchemaSchema, draftFormSchemaSchema } from "@splash/forms-schema";

const SLUG = "hr-issue-report";
const OPERATOR = "josh.copp@splashcarwashes.com";
const HR_TO = (process.env.HR_TO ?? "slowe@splashcarwashes.com,melissa.lavranchuk@splashcarwashes.com")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const TEST_TO = process.env.TEST_TO || OPERATOR;
const CREATED_BY = "f42882fd-ee5a-433e-b10b-713d5dff8a89"; // operator's auth user id (as in the other gen scripts)

const idFor = (key: string) => createHash("sha1").update(`${SLUG}:${key}`).digest("hex").slice(0, 8);
const fields: Field[] = [];
const push = (f: Omit<Field, "id">) => fields.push({ ...f, id: idFor(f.key) } as Field);

push({
  key: "intro",
  type: "heading",
  label: "About this form",
  text: "Report a concern to Human Resources",
  level: "h3",
  helpText:
    "This report goes only to HR, not to your site's managers. Your name, email and phone are optional: leave them blank to report anonymously. If you'd like HR to follow up with you, include a way to reach you.",
  required: false
} as Field);

push({
  key: "location",
  type: "location",
  label: "Location",
  helpText: "The site this is about.",
  required: true,
  displayFormat: "name"
} as Field);

// The location field stores the slug ("binghamton"); this resolves the display
// name for the email subject and the HR queue column.
push({
  key: "site_name",
  type: "lookup",
  label: "Site",
  required: false,
  sourceTable: "pricing_simple",
  sourceColumn: "location_pretty",
  keyColumn: "pricing_simple.location_code",
  keyFieldId: idFor("location"),
  resolutionMode: "prefill_hidden",
  nullBehavior: "allow_empty",
  show_in_queue: true
} as Field);

push({
  key: "complaint",
  type: "long_text",
  label: "What happened?",
  helpText:
    "Please include all relevant information: what happened, where it happened, and who was involved or saw it. List the date and time of each occurrence, as best you remember. If it has happened more than once, describe each time.",
  required: true,
  maxLength: 5000,
  rows: 8,
  show_in_queue: true
} as Field);

push({
  key: "contact_heading",
  type: "heading",
  label: "Your contact information (optional)",
  text: "Your contact information (optional)",
  level: "h3",
  helpText: "Leave these blank to stay anonymous.",
  required: false
} as Field);

push({ key: "reporter_name", type: "name", label: "Your name", required: false, maxLength: 120, show_in_queue: true } as Field);
// noAutofill: the QR is scanned on phones, but a site tablet must not offer
// the last reporter's address to the next one.
push({ key: "reporter_email", type: "email", label: "Your email", required: false, noAutofill: true } as Field);
push({ key: "reporter_phone", type: "phone", label: "Your phone", required: false } as Field);

const HR = { type: "static_emails" as const, emails: HR_TO };

const workflow: FormWorkflow = {
  default_stage: "notify_hr",
  stages: [
    {
      id: "notify_hr",
      label: "Email the report to HR",
      kind: "email",
      recipients: [HR],
      subject_template: "HR issue report: {field.site_name}",
      body_template:
        "A new HR issue report was submitted for {field.site_name}.\n\n{payload.summary}\n\nIf the name, email and phone are missing, the report was made anonymously.\n\n{submission.url}\n\nThis is a confidential personnel matter. Please don't forward it.",
      transitions: [{ to: "open", label: "Sent" }]
    },
    {
      id: "open",
      label: "Open",
      kind: "approval",
      approver_source: HR,
      transitions: [
        { to: "resolved", label: "Resolved" },
        { to: "closed", label: "Closed - no action" }
      ]
    },
    { id: "resolved", label: "Resolved", kind: "outcome", tint: "success", transitions: [] },
    { id: "closed", label: "Closed - no action", kind: "outcome", tint: "neutral", transitions: [] }
  ]
} as FormWorkflow;

const schema: FormSchema = { fields, workflow };

// ---------------------------------------------------------------------------
const keys = fields.map((f) => f.key);
const ids = fields.map((f) => f.id);
for (const [what, list] of [["id", ids], ["key", keys]] as const) {
  const dup = [...new Set(list.filter((x, i) => list.indexOf(x) !== i))];
  if (dup.length) throw new Error(`duplicate field ${what}s: ${dup.join(", ")}`);
}
if (keys.includes("site_number")) throw new Error("must not have a site_number field (confidential, unscoped)");
if (fields.filter((f) => f.show_in_queue).length > 5) throw new Error("the queue shows 5 fields");
for (const [label, v] of [
  ["strict", formSchemaSchema],
  ["draft", draftFormSchemaSchema]
] as const) {
  const r = v.safeParse(schema);
  if (!r.success) {
    console.error(`${label} validation FAILED`);
    console.error(JSON.stringify(r.error.issues.slice(0, 12), null, 2));
    process.exit(1);
  }
}

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const json = `$hr$${JSON.stringify(schema)}$hr$`;
if (JSON.stringify(schema).includes("$hr$")) throw new Error("dollar tag collision");

const title = "HR Issue Report";
const description = "Report a concern to Human Resources. Name, email and phone are optional.";
const success =
  "Thank you. Your report has been sent to Human Resources. If you included your contact information, HR may reach out to you.";

writeFileSync(
  "supabase/hr-issue-report-01.sql",
  `-- Generated by scripts/gen-hr-issue-report.ts -- edit that, not this file.
-- APPLIED 2026-11-16 via Supabase MCP (created as a draft, test mode).
--
-- HR recipients: ${HR_TO.join(", ")}
-- Test mode: every email goes only to ${TEST_TO} until switched off on the Settings tab.

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

-- Confidential; test mode on; a secret link if it has none yet (a re-run never
-- changes a link already printed on a QR code).
update public.forms
   set scope_location_field_key = 'none:confidential',
       email_drafts = false,
       test_email_to = coalesce(test_email_to, ${lit(TEST_TO)}),
       link_key = coalesce(link_key, replace(gen_random_uuid()::text, '-', ''))
 where slug = ${lit(SLUG)};

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

select f.slug, f.audience, f.status, f.scope_location_field_key, f.email_drafts, f.test_email_to,
       '/forms/' || f.link_key as secret_url,
       jsonb_array_length(v.schema->'fields') as fields
  from public.forms f join public.form_versions v on v.id = f.draft_version_id
 where f.slug = ${lit(SLUG)};
`
);
console.log(`ok  fields=${fields.length} stages=${workflow.stages.length}  HR_TO=${HR_TO.join(",")}`);
