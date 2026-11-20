// Generator for the "Monthly Safety Meeting" form (slug: safety-meeting),
// 2026-11-18. Replaces JotForm 250754533489062.
//
//   npx tsx scripts/gen-safety-meeting.ts
//     (writes supabase/safety-meeting-form-01.sql;
//      run supabase/safety-meeting-01.sql FIRST -- it creates the topics table)
//
// WHAT IT IS FOR. Each site holds a safety meeting at the start of every month
// and records it on the site tablet: site, date (defaults to today, editable),
// the committee's REQUIRED topics for that month (each ticked as covered),
// up to 10 other topics, open topics, who attended (name + signature per
// person, 5 rows to start and "+ Add employee" for more), and who held it.
//
// TWO NEW FIELD TYPES were built for this form:
//   - `required_topics` reads the safety committee's list for the meeting
//     date's month (table form_required_topics, edited at
//     /admin/safety-topics). A month with no topics shows "No required
//     topics". The server re-reads the list at submit and refuses an
//     un-ticked topic.
//   - `attendance` is the growing sign-in sheet (roster search per row with a
//     typed-name fallback, plus a signature).
//
// EMAIL. On submit the completed PDF goes to safety@ AND the "Safety Manager
// Email" typed on the form, then the submission is filed as "Recorded". There
// is no approval step. Built in TEST MODE (forms.test_email_to): every email
// goes only to the operator until test mode is switched off on the Settings
// tab -- the recipients above are the real ones.
//
// ACCESS.
//   - LINK-ONLY (filled on the site tablets without signing in).
//   - LOCATION-SCOPED: the site field is keyed `site_number`, so first publish
//     makes it the scope field and site admins see their own sites' meetings.
//   - access_tag = 'safety_committee': people given that grant on
//     /admin/sysadmin read EVERY site's meetings, and the same grant lets them
//     edit /admin/safety-topics. Tagging the form is also what makes the grant
//     tickable on sysadmin (the list of grantable tags is read from forms).

import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { Field, FormSchema, FormWorkflow } from "@splash/forms-schema";
import { formSchemaSchema, draftFormSchemaSchema } from "@splash/forms-schema";

const SLUG = "safety-meeting";
const SITE_KEY = "site_number";
const SAFETY_TO = "safety@splashcarwashes.com";
const OPERATOR = "josh.copp@splashcarwashes.com";
const TEST_TO = process.env.TEST_TO || OPERATOR;
const ACCESS_TAG = "safety_committee";
const CREATED_BY = "f42882fd-ee5a-433e-b10b-713d5dff8a89";

const idFor = (key: string) => createHash("sha1").update(`${SLUG}:${key}`).digest("hex").slice(0, 8);
const fields: Field[] = [];
const push = (f: Omit<Field, "id">) => fields.push({ ...f, id: idFor(f.key) } as Field);

// --- Site & date ------------------------------------------------------------
push({
  key: SITE_KEY,
  type: "short_text",
  label: "Site number",
  helpText: "3-digit site number (leading zeros optional).",
  required: true,
  maxLength: 10
} as Field);
push({
  key: "site_name",
  type: "lookup",
  label: "Site",
  required: false,
  sourceTable: "pricing_simple",
  sourceColumn: "location_pretty",
  keyColumn: "pricing_simple.site",
  keyFieldId: idFor(SITE_KEY),
  resolutionMode: "prefill_visible",
  nullBehavior: "block_submit", // an unknown site number is a typo
  show_in_queue: true
} as Field);
push({
  key: "meeting_date",
  type: "date",
  label: "Meeting date",
  required: true,
  defaultToToday: true,
  show_in_queue: true
} as Field);
push({
  key: "safety_manager_email",
  type: "email",
  label: "Safety Manager Email",
  helpText: "A copy of the completed meeting (PDF) is emailed here and to safety@splashcarwashes.com.",
  required: true
} as Field);

// --- Topics -----------------------------------------------------------------
push({
  key: "topics_heading",
  type: "heading",
  label: "Topics",
  text: "Safety topics discussed",
  level: "h3",
  required: false
} as Field);
push({
  key: "required_topics",
  type: "required_topics",
  label: "Required topics this month",
  helpText: "Set by the safety committee. Cover each one and tick it off.",
  required: true,
  listKey: "safety_meeting",
  dateFieldKey: "meeting_date"
} as Field);
for (let n = 1; n <= 10; n++) {
  push({
    key: `topic_${n}`,
    type: "short_text",
    label: `Topic ${n}`,
    ...(n === 1 ? { helpText: "Other topics discussed. At least one; leave the rest blank." } : {}),
    required: n === 1,
    maxLength: 200
  } as Field);
}
push({
  key: "open_topics",
  type: "long_text",
  label: "Open topics",
  helpText: "Questions or concerns raised that still need follow-up.",
  required: false,
  maxLength: 4000,
  rows: 3
} as Field);

// --- Attendance -------------------------------------------------------------
push({
  key: "attendance_heading",
  type: "heading",
  label: "Employees in attendance",
  text: "Employees in attendance",
  level: "h3",
  required: false
} as Field);
push({
  key: "attendees",
  type: "attendance",
  label: "Sign-in sheet",
  helpText:
    "Each employee finds their name and signs. Not listed? Type your full name and use it. Tap “+ Add employee” for more rows; blank rows are ignored.",
  required: true,
  keyFieldKey: SITE_KEY,
  keyColumn: "pricing_simple.site",
  allowTyped: true,
  initialRows: 5,
  show_in_queue: true
} as Field);

// --- Held by ----------------------------------------------------------------
push({
  key: "held_by",
  type: "employee",
  label: "Meeting held by",
  helpText: "Start typing your name. Not listed? Type your full name and use it.",
  required: true,
  keyFieldKey: SITE_KEY,
  keyColumn: "pricing_simple.site",
  allowTyped: true,
  show_in_queue: true
} as Field);
push({
  key: "held_by_signature",
  type: "signature",
  label: "Signature of the person who held the meeting",
  required: true,
  format: "png"
} as Field);

// --- Workflow: email the PDF, file as Recorded -------------------------------
const workflow: FormWorkflow = {
  default_stage: "email_safety",
  stages: [
    {
      id: "email_safety",
      label: "Email the meeting to Safety",
      kind: "email",
      recipients: [
        { type: "static_emails", emails: [SAFETY_TO] },
        { type: "payload_field", field_key: "safety_manager_email" }
      ],
      subject_template: "Safety meeting: {field.site_name} ({field.site_number}) - {field.meeting_date}",
      body_template:
        "The monthly safety meeting for {field.site_name} ({field.site_number}) held on {field.meeting_date} has been recorded. The completed form with every signature is attached as a PDF.\n\n{payload.summary}",
      attach_pdf: true,
      transitions: [{ to: "recorded", label: "Sent" }]
    },
    { id: "recorded", label: "Recorded", kind: "outcome", tint: "success", transitions: [] }
  ]
} as FormWorkflow;

const schema: FormSchema = { fields, workflow };

// --- Checks -------------------------------------------------------------------
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

// --- SQL ------------------------------------------------------------------------
const TAG = "$sm$";
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
if (JSON.stringify(schema).includes(TAG)) throw new Error("dollar tag collision");
const json = `${TAG}${JSON.stringify(schema)}${TAG}`;

const title = "Monthly Safety Meeting";
const description =
  "Record this month's safety meeting: topics covered and everyone who attended. A PDF copy goes to Safety.";
const success = "Thanks - the safety meeting is recorded and a copy has been emailed to Safety.";

writeFileSync(
  "supabase/safety-meeting-form-01.sql",
  `-- Generated by scripts/gen-safety-meeting.ts -- edit that, not this file.
-- Run supabase/safety-meeting-01.sql (form_required_topics) FIRST.
-- Draft (unpublished). Re-runnable: upserts the forms row, creates a draft
-- version only when there is none, otherwise overwrites the draft schema.
--
--   slug ${SLUG}   audience link-only   ${fields.length} fields   access_tag ${ACCESS_TAG}
--   emails: ${SAFETY_TO} + the Safety Manager Email field (PDF attached)
--   test mode: every email goes only to ${TEST_TO} until switched off on the Settings tab
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

-- Committee grant tag, and test mode. CAUTION: switching test mode off clears
-- test_email_to, so re-running this AFTER go-live turns test mode back on.
update public.forms
   set access_tag = ${lit(ACCESS_TAG)},
       test_email_to = coalesce(test_email_to, ${lit(TEST_TO)})
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

select f.id, f.slug, f.audience, f.status, f.access_tag, f.test_email_to, f.draft_version_id,
       jsonb_array_length(v.schema->'fields') as fields
  from public.forms f join public.form_versions v on v.id = f.draft_version_id
 where f.slug = ${lit(SLUG)};
`
);
console.log(`ok  fields=${fields.length} stages=${workflow.stages.length}  -> supabase/safety-meeting-form-01.sql`);
