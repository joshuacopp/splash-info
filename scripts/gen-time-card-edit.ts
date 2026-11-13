// Generator for the "Time Card Edit" form (slug: time-card-edit).
// Replaces JotForm 250193775451056 (1,108 submissions Jan 2025 - Nov 2026:
// 632 PTO, 476 punch corrections; every one sent to Wendy Wandtke).
//
// WHAT IT IS FOR. A site manager records a change to an employee's time card
// -- a corrected punch or PTO added -- for payroll to apply in iSolved. This
// form does NOT change any time card; it collects, signs and delivers. Wendy
// (payroll) is the source of truth.
//
// AUDIT DETAIL IS THE POINT (operator, 2026-11-13). Corrections record the
// original AND corrected punch for every punch, and PTO records punch-in and
// punch-out per day, not "8 hours", so the PDF shows exactly what changed.
// Each shift / day is a date plus times (JotForm used a date-time per punch);
// same detail, fewer boxes. A shift that crosses midnight is not modelled --
// note it in Notes.
//
// ONE "WHAT NEEDS CHANGING" QUESTION drives every conditional field. JotForm's
// reason -> "1 or 2 corrections" chain is flattened into seven options because
// forms-public.js does not cascade visibility: a hidden radio keeps its checked
// value, so a field conditioned on it would stay visible (and required) after
// its controller was hidden. Single-level conditions avoid that entirely.
//
// THE EMPLOYEE IS PICKED FROM THE ROSTER of the site typed above (Employee
// field, PLAN_FORMS_PERSONNEL.md phase 2); a new hire not in Beekeeper yet can
// be typed and is marked unverified.
//
// DELIVERY: one email step, PDF attached, then done -- no approval (operator,
// 2026-11-13). Live recipients: Wendy, the site's email, and the manager who
// made the edit. While testing (the default) EVERYTHING goes to TEST_TO only;
// regenerate with LIVE=1 to switch to the real recipients.
//
// LINK-ONLY: filled on the site tablets without signing in. Location-scoped by
// the site_number field, so site admins see their own sites' edits.

import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { ApproverSource, Field, FormSchema, FormWorkflow } from "@splash/forms-schema";
import { formSchemaSchema, draftFormSchemaSchema } from "@splash/forms-schema";

const LIVE = process.env.LIVE === "1";
const TEST_TO = process.env.TEST_TO || "josh.copp@splashcarwashes.com";
const PAYROLL = "wendy.wandtke@splashcarwashes.com";
const SITE_KEY = "site_number"; // handlePublish finds the scope field by THIS key

function idFor(key: string): string {
  return createHash("sha1").update(`time-card-edit:${key}`).digest("hex").slice(0, 8);
}

const fields: Field[] = [];
function push(f: Omit<Field, "id"> & { id?: string }) {
  fields.push({ ...f, id: f.id ?? idFor(f.key) } as Field);
}

// --- Site ------------------------------------------------------------------
push({
  key: SITE_KEY,
  type: "short_text",
  label: "Site number",
  helpText: "3-digit site number (leading zeros optional).",
  required: true,
  maxLength: 10
});
const SITE_ID = idFor(SITE_KEY);
push({
  key: "site_name",
  type: "lookup",
  label: "Site",
  required: false,
  sourceTable: "pricing_simple",
  sourceColumn: "location_pretty",
  keyColumn: "pricing_simple.site",
  keyFieldId: SITE_ID,
  resolutionMode: "prefill_visible",
  nullBehavior: "block_submit", // an unknown site number is a typo
  show_in_queue: true
} as Field);
push({
  key: "site_email",
  type: "lookup",
  label: "Site email",
  required: false,
  sourceTable: "pricing_simple",
  sourceColumn: "site_email",
  keyColumn: "pricing_simple.site",
  keyFieldId: SITE_ID,
  resolutionMode: "prefill_hidden",
  nullBehavior: "allow_empty",
  exclude_from_pdf: true
} as Field);

// --- Who and what ------------------------------------------------------------
push({
  key: "employee",
  type: "employee",
  label: "Employee",
  helpText: "Start typing their name. Not listed yet (new hire)? Type their full name and use it.",
  required: true,
  keyFieldKey: SITE_KEY,
  keyColumn: "pricing_simple.site",
  allowTyped: true,
  show_in_queue: true
} as Field);

const CORR1 = "correction_1";
const CORR2 = "correction_2";
const PTO = [1, 2, 3, 4, 5].map((n) => `pto_${n}`);
push({
  key: "edit_type",
  type: "radio",
  label: "What needs changing?",
  required: true,
  layout: "vertical",
  options: [
    { label: "Punch correction - 1 shift", value: CORR1 },
    { label: "Punch correction - 2 shifts", value: CORR2 },
    { label: "PTO - 1 day", value: PTO[0]! },
    { label: "PTO - 2 days", value: PTO[1]! },
    { label: "PTO - 3 days", value: PTO[2]! },
    { label: "PTO - 4 days", value: PTO[3]! },
    { label: "PTO - 5 days", value: PTO[4]! }
  ],
  show_in_queue: true
} as Field);

// --- Punch corrections -------------------------------------------------------
for (const n of [1, 2]) {
  const when = { field_key: "edit_type", equals: n === 1 ? [CORR1, CORR2] : [CORR2] };
  push({
    key: `corr${n}_heading`,
    type: "heading",
    label: `Shift ${n}`,
    text: `Shift ${n}`,
    level: "h3",
    required: false,
    visible_if: when
  } as Field);
  push({ key: `corr${n}_date`, type: "date", label: `Shift ${n} date`, required: true, visible_if: when } as Field);
  for (const [k, label, help] of [
    ["orig_in", "Original punch in", undefined],
    ["new_in", "Corrected punch in", "Same as the original if this punch didn't change."],
    ["orig_out", "Original punch out", undefined],
    ["new_out", "Corrected punch out", "Same as the original if this punch didn't change."]
  ] as const) {
    push({
      key: `corr${n}_${k}`,
      type: "time",
      label,
      ...(help ? { helpText: help } : {}),
      required: true,
      visible_if: when
    } as Field);
  }
}

// --- PTO -----------------------------------------------------------------------
for (const n of [1, 2, 3, 4, 5]) {
  const when = { field_key: "edit_type", equals: PTO.slice(n - 1) };
  push({
    key: `pto${n}_heading`,
    type: "heading",
    label: `PTO day ${n}`,
    text: `PTO day ${n}`,
    level: "h3",
    required: false,
    visible_if: when
  } as Field);
  push({ key: `pto${n}_date`, type: "date", label: `PTO day ${n} date`, required: true, visible_if: when } as Field);
  push({ key: `pto${n}_in`, type: "time", label: "Punch in", required: true, visible_if: when } as Field);
  push({ key: `pto${n}_out`, type: "time", label: "Punch out", required: true, visible_if: when } as Field);
}

// --- Sign-off --------------------------------------------------------------------
push({
  key: "notes",
  type: "long_text",
  label: "Notes",
  helpText: "Optional. Why the edit was needed, or anything payroll should know (e.g. a shift that ran past midnight).",
  required: false,
  maxLength: 2000,
  rows: 3
} as Field);
push({ key: "manager_name", type: "name", label: "Manager making the edit", required: true, maxLength: 120 } as Field);
push({
  key: "manager_email",
  type: "email",
  label: "Manager's email",
  helpText: "A copy of the completed form is sent here.",
  required: true
} as Field);
push({ key: "employee_signature", type: "signature", label: "Employee signature", required: true, format: "png" } as Field);
push({ key: "manager_signature", type: "signature", label: "Manager signature", required: true, format: "png" } as Field);

// --- Workflow: one email with the PDF, then done -------------------------------
const recipients: ApproverSource[] = LIVE
  ? [
      { type: "static_emails", emails: [PAYROLL] },
      { type: "payload_field", field_key: "site_email" },
      { type: "payload_field", field_key: "manager_email" }
    ]
  : [{ type: "static_emails", emails: [TEST_TO] }];

const workflow: FormWorkflow = {
  default_stage: "send",
  stages: [
    {
      id: "send",
      label: "Email payroll",
      kind: "email",
      recipients,
      attach_pdf: true,
      subject_template: `${LIVE ? "" : "[TEST] "}Time card edit: {field.employee} at {field.site_name}`,
      body_template: [
        LIVE
          ? "A time card edit was submitted for {field.employee} at {field.site_name} ({field.site_number})."
          : "TEST - when live this goes to payroll, the site email and the manager. A time card edit was submitted for {field.employee} at {field.site_name} ({field.site_number}).",
        "{payload.summary}",
        "The signed form is attached."
      ].join("\n\n"),
      transitions: [{ to: "sent", label: "Sent" }]
    },
    { id: "sent", label: "Sent to payroll", kind: "outcome", tint: "success", transitions: [] }
  ]
};

const schema: FormSchema = { fields, workflow };

// --- Checks -----------------------------------------------------------------------
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

const out = process.argv[2] ?? "time-card-edit.json";
writeFileSync(out, JSON.stringify(schema));
console.log(`ok  ${LIVE ? "LIVE" : "TEST -> " + TEST_TO}  fields=${fields.length} stages=${workflow.stages.length}  -> ${out}`);
