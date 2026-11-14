// Generator for the "Employee Warning Notice" form (slug: employee-warning-notice).
// Replaces the JotForm-filled paper Employee Warning Notice (Adams 9050 layout).
//
// WHAT IT PRODUCES. One submission, filled on the site tablet IN THE MEETING
// with the employee (operator, 2026-11-14), produces two Splash-branded
// documents in one PDF (apps/forms-worker/src/pdf/warning-notice.ts):
//   1. Employee Warning Notice  -- same sections and order as the paper form.
//   2. Notice of Negative Information -- the Splash notice from the Personnel
//      Records Access and Notification Policy, filled from the write-up, with
//      the employee's acknowledgement (or "refused to sign" + witness).
// Handing both over at the meeting meets the policy's 10-day notice and CT's
// one-business-day copy rule (CGS 31-128b) at once. Every write-up carries the
// "you may submit a written statement" language CT requires (31-128e); it
// costs nothing for NY staff and covers multi-state employees.
//
// DELIVERY (operator, 2026-11-14): the PDF is emailed to the site's HRT
// (locations.hrt_email -- this IS "send to HR by the next business day"), the
// site's RM and the manager who wrote it up. The employee gets their copy by
// email if one is given; otherwise the manager prints it and hands it over in
// a sealed envelope. The Notice records which.
//
// NOT HANDLED HERE: requests to view the personnel record and the Employee
// Written Statement go to HR directly (operator, 2026-11-14).
//
// PREVIOUS WARNINGS are typed by the manager, as on paper. FUTURE (operator,
// 2026-11-14): once every GM writes up here, pre-fill what the system has for
// this employee and let the manager add anything older. Not now: prior
// write-ups live on JotForm / paper, and listing them on a no-sign-in tablet
// form would expose confidential records.
//
// CONFIDENTIAL -- NOT SITE-SCOPED, exactly like Pay Change: the site field is
// keyed `site`, NOT `site_number`, and the forms row gets
// scope_location_field_key = 'none:confidential', so submissions are readable
// only by admins and the people the form routes to. Do NOT rename the field to
// site_number until PLAN_FORMS_PERSONNEL.md phase 3's access rule exists.
//
// MEDICAL INFORMATION does not belong in a write-up (ADA, 29 CFR 1630.14);
// the company statement says so and the PDF keeps the paper form's footnote.
//
// NO CHAINED CONDITIONS: forms-public.js does not cascade visibility.
//
// TEST MODE (default): every email goes to TEST_TO. LIVE=1 for real routing.

import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { ApproverSource, Field, FormSchema, FormWorkflow } from "@splash/forms-schema";
import { formSchemaSchema, draftFormSchemaSchema } from "@splash/forms-schema";

const LIVE = process.env.LIVE === "1";
const TEST_TO = process.env.TEST_TO || "josh.copp@splashcarwashes.com";

function idFor(key: string): string {
  return createHash("sha1").update(`warning-notice:${key}`).digest("hex").slice(0, 8);
}
const fields: Field[] = [];
function push(f: Omit<Field, "id"> & { id?: string }) {
  fields.push({ ...f, id: f.id ?? idFor(f.key) } as Field);
}
const when = (key: string, ...v: string[]) => ({ visible_if: { field_key: key, equals: v } });

// --- Site and routing -----------------------------------------------------------
push({
  key: "site",
  type: "short_text",
  label: "Site number",
  helpText: "3-digit site number (leading zeros optional).",
  required: true,
  maxLength: 10
} as Field);
const SITE_ID = idFor("site");
function lookup(key: string, label: string, sourceTable: string, sourceColumn: string, extra: Record<string, unknown> = {}) {
  push({
    key,
    type: "lookup",
    label,
    required: false,
    sourceTable,
    sourceColumn,
    keyColumn: "pricing_simple.site",
    keyFieldId: SITE_ID,
    resolutionMode: "prefill_hidden",
    nullBehavior: "allow_empty",
    exclude_from_pdf: true,
    ...extra
  } as Field);
}
lookup("site_name", "Site", "pricing_simple", "location_pretty", {
  resolutionMode: "prefill_visible",
  nullBehavior: "block_submit", // an unknown site number is a typo
  exclude_from_pdf: false,
  show_in_queue: true
});
lookup("rm_email", "Regional manager email", "pricing_simple", "rm_email");
lookup("hrt_email", "HRT email", "locations", "hrt_email");

// --- Header (paper: Employee / Warning date / Employee no. / Department / Shift) --
push({
  key: "employee",
  type: "employee",
  label: "Employee",
  helpText: "Start typing their name. Not listed yet (new hire)? Type their full name and use it.",
  required: true,
  keyFieldKey: "site",
  keyColumn: "pricing_simple.site",
  allowTyped: true,
  show_in_queue: true
} as Field);
push({ key: "warning_date", type: "date", label: "Warning date", required: true, defaultToToday: true, show_in_queue: true } as Field);
push({ key: "employee_number", type: "short_text", label: "Employee no.", required: false, maxLength: 30 } as Field);
// DEPARTMENT IS THE SITE (operator, 2026-11-14): write-ups are site-level,
// and the paper / JotForm process always put the location name in the
// Department box, so the PDF prints site_name there and the form does not ask.
// If 011 / 101 office staff are ever written up here, add a `department`
// short_text with visible_if { field_key: "site", equals: ["011", "11", "101"] }
// -- the PDF already prefers a typed `department` over the site name.
push({ key: "shift", type: "short_text", label: "Shift", required: false, maxLength: 60 } as Field);

// --- Violations ---------------------------------------------------------------------
// Paper order, read down each column.
push({
  key: "violations",
  type: "multi",
  label: "Violations",
  helpText: "Tick every one that applies.",
  required: true,
  minSelected: 1,
  options: [
    { label: "Attendance", value: "attendance" },
    { label: "Carelessness", value: "carelessness" },
    { label: "Conduct", value: "conduct" },
    { label: "Insubordination", value: "insubordination" },
    { label: "Personal work", value: "personal_work" },
    { label: "Refusal to work overtime", value: "refusal_overtime" },
    { label: "Safety", value: "safety" },
    { label: "Tardiness", value: "tardiness" },
    { label: "Unauthorized absence", value: "unauthorized_absence" },
    { label: "Work quality", value: "work_quality" },
    { label: "Willful damage to company property", value: "willful_damage" },
    { label: "Other", value: "other" }
  ],
  show_in_queue: true
} as Field);
push({ key: "violation_other", type: "short_text", label: "Other violation", required: true, maxLength: 120, ...when("violations", "other") } as Field);

// --- Previous warnings ----------------------------------------------------------------
push({ key: "prior_heading", type: "heading", label: "Previous warnings", text: "Previous warnings", level: "h3", required: false } as Field);
push({
  key: "prior_count",
  type: "radio",
  label: "How many previous warnings?",
  required: true,
  layout: "inline",
  defaultValue: "0",
  options: [
    { label: "None", value: "0" },
    { label: "1", value: "1" },
    { label: "2", value: "2" },
    { label: "3", value: "3" }
  ]
} as Field);
for (const n of [1, 2, 3]) {
  const shown = when("prior_count", ...["1", "2", "3"].filter((c) => Number(c) >= n));
  push({ key: `prior${n}_date`, type: "date", label: `Warning ${n} date`, required: true, ...shown } as Field);
  push({
    key: `prior${n}_type`,
    type: "radio",
    label: `Warning ${n}: oral or written`,
    required: true,
    layout: "inline",
    options: [
      { label: "Oral", value: "oral" },
      { label: "Written", value: "written" }
    ],
    ...shown
  } as Field);
  push({
    key: `prior${n}_signed`,
    type: "radio",
    label: `Warning ${n}: signed by the employee?`,
    required: true,
    layout: "inline",
    options: [
      { label: "Yes", value: "yes" },
      { label: "No", value: "no" },
      { label: "Refused", value: "refused" }
    ],
    ...shown
  } as Field);
}

// --- Company statement and action -------------------------------------------------------
push({
  key: "company_statement",
  type: "long_text",
  label: "Company statement",
  helpText:
    "What happened: dates, times and facts. Describe the conduct, not anyone's health. Medical information goes to HR separately and must not be written here.",
  required: true,
  maxLength: 4000,
  rows: 6
} as Field);
push({ key: "action_taken", type: "long_text", label: "Action taken", required: true, maxLength: 2000, rows: 3 } as Field);
push({ key: "supervisor_name", type: "name", label: "Supervisor's name", required: true, maxLength: 120 } as Field);
push({ key: "supervisor_title", type: "short_text", label: "Supervisor's title", placeholder: "e.g. General Manager", required: true, maxLength: 80 } as Field);
push({
  key: "supervisor_email",
  type: "email",
  label: "Supervisor's email",
  helpText: "A copy of the completed notice is sent here.",
  required: true
} as Field);
push({ key: "supervisor_signature", type: "signature", label: "Supervisor signature", required: true, format: "png" } as Field);

// --- Employee section (the tablet is handed over) -----------------------------------------
push({
  key: "employee_heading",
  type: "heading",
  label: "Employee statement",
  text: "Employee statement - hand the tablet to the employee",
  level: "h3",
  required: false
} as Field);
// The employee signs for the Notice of Negative Information, so they read its
// rights text here BEFORE signing. Keep identical to RIGHTS_PARAGRAPHS in
// apps/forms-worker/src/pdf/warning-notice.ts (the printed Notice).
push({
  key: "rights_notice",
  type: "heading",
  label: "Notice of Negative Information",
  text: "Notice of Negative Information - please read before signing",
  level: "h4",
  helpText: [
    "This warning is being added to your personnel file.",
    "You may request a copy of your personnel record by submitting a written request to your immediate Manager. A request made in response to this notice does not count toward your two-requests-per-year limit.",
    "If you disagree with this information, you may discuss it with Human Resources. If an agreement is not reached, you may submit a written statement explaining your position, which will become a permanent part of your personnel record.",
    "The Company prohibits retaliation for exercising these rights."
  ].join("\n\n"),
  required: false
} as Field);
push({
  key: "employee_response",
  type: "radio",
  label: "Employee statement",
  required: true,
  layout: "vertical",
  options: [
    { label: "I agree with the company statement", value: "agree" },
    { label: "I disagree with the company statement", value: "disagree" },
    { label: "Employee refused to sign (supervisor ticks this)", value: "refused" }
  ],
  show_in_queue: true
} as Field);
push({
  key: "employee_reasons",
  type: "long_text",
  label: "Reasons",
  helpText: "Optional. Anything the employee wants on the record.",
  required: false,
  maxLength: 4000,
  rows: 4,
  ...when("employee_response", "agree", "disagree")
} as Field);
push({
  key: "employee_signature",
  type: "signature",
  label: "Employee signature",
  helpText:
    "I have read this Warning Notice and understand it, and I have received the Notice of Negative Information. Signing confirms I received them, not that I agree.",
  required: true,
  format: "png",
  ...when("employee_response", "agree", "disagree")
} as Field);
push({
  key: "witness_name",
  type: "name",
  label: "Second supervisor (witness) name",
  helpText: "The employee refused to sign. A second supervisor witnesses that the notice was given.",
  required: true,
  maxLength: 120,
  ...when("employee_response", "refused")
} as Field);
push({ key: "witness_signature", type: "signature", label: "Second supervisor signature", required: true, format: "png", ...when("employee_response", "refused") } as Field);

// --- Employee's copy ------------------------------------------------------------------------
// The manager chooses how the copy is delivered; printing requires a
// confirmation, because nothing else records that the hand-over happened.
push({
  key: "copy_delivery",
  type: "radio",
  label: "How will the employee get their copy?",
  required: true,
  layout: "vertical",
  options: [
    { label: "Email it to them", value: "email" },
    { label: "Print it and hand it to them", value: "print" }
  ]
} as Field);
push({
  key: "employee_email",
  type: "email",
  label: "Employee's email for their copy",
  helpText: "Both documents are emailed here as soon as the form is submitted.",
  required: true,
  // The tablet's browser was filling this with the manager's own address.
  noAutofill: true,
  ...when("copy_delivery", "email")
} as Field);
push({
  key: "print_confirm",
  type: "multi",
  label: "Printed copy",
  required: true,
  minSelected: 1,
  options: [
    {
      label: "I will print the employee's copy (it is emailed to me) and hand it to them in a sealed envelope today.",
      value: "confirmed"
    }
  ],
  ...when("copy_delivery", "print")
} as Field);

// --- Workflow: email the PDF, then done ------------------------------------------------------
const test = (live: ApproverSource[]): ApproverSource[] =>
  LIVE ? live : [{ type: "static_emails", emails: [TEST_TO] }];
const T = LIVE ? "" : "[TEST] ";

const workflow: FormWorkflow = {
  default_stage: "send_hr",
  stages: [
    {
      id: "send_hr",
      label: "Email HRT, RM and supervisor",
      kind: "email",
      recipients: test([
        { type: "payload_field", field_key: "hrt_email" },
        { type: "payload_field", field_key: "rm_email" },
        { type: "payload_field", field_key: "supervisor_email" }
      ]),
      attach_warning_notice: true,
      subject_template: `${T}Employee warning notice: {field.employee} at {field.site_name}`,
      body_template: [
        LIVE ? "" : "TEST - when live this goes to the site's HRT, the RM and the supervisor.",
        "{field.supervisor_name} issued an employee warning notice to {field.employee} at {field.site_name} on {field.warning_date}.",
        "The signed Warning Notice and the Notice of Negative Information are attached. If the employee's copy was not emailed to them, the supervisor hands it over in a sealed envelope.",
        "This is a confidential personnel record."
      ]
        .filter(Boolean)
        .join("\n\n"),
      transitions: [{ to: "send_employee", label: "Sent" }]
    },
    {
      id: "send_employee",
      label: "Email the employee their copy",
      kind: "email",
      recipients: test([{ type: "payload_field", field_key: "employee_email" }]),
      attach_warning_notice: true,
      subject_template: `${T}Your copy: Employee Warning Notice from Splash Car Wash`,
      body_template: [
        LIVE ? "" : "TEST - when live this goes to the employee's email, only when one was given.",
        "Attached is your copy of the Employee Warning Notice issued on {field.warning_date}, and a Notice of Negative Information explaining your rights.",
        "You may request a copy of your personnel record from your manager, and if you disagree with the warning you may submit a written statement explaining your position, which will become part of your personnel record. Splash prohibits retaliation for exercising these rights."
      ]
        .filter(Boolean)
        .join("\n\n"),
      transitions: [{ to: "filed", label: "Sent" }]
    },
    { id: "filed", label: "Filed", kind: "outcome", tint: "neutral", transitions: [] }
  ]
};

const schema: FormSchema = { fields, workflow };

// --- Checks ---------------------------------------------------------------------------------
const ids = fields.map((f) => f.id);
const keys = fields.map((f) => f.key);
for (const [what, list] of [["id", ids], ["key", keys]] as const) {
  const dup = [...new Set(list.filter((x, i) => list.indexOf(x) !== i))];
  if (dup.length) throw new Error(`duplicate field ${what}s: ${dup.join(", ")}`);
}
if (keys.includes("site_number")) throw new Error("warning notice must not have a site_number field (confidential, unscoped)");
const queued = fields.filter((f) => f.show_in_queue).length;
if (queued > 5) throw new Error(`show_in_queue on ${queued} fields; the queue shows 5`);
for (const f of fields) {
  if (f.visible_if) {
    const ctl = fields.find((c) => c.key === f.visible_if!.field_key);
    if (!ctl) throw new Error(`${f.key}: visible_if names unknown field`);
    if (ctl.visible_if) throw new Error(`${f.key}: chained visible_if via ${ctl.key} (forms-public.js does not cascade)`);
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

const out = process.argv[2] ?? "employee-warning-notice.json";
writeFileSync(out, JSON.stringify(schema));
console.log(`ok  ${LIVE ? "LIVE" : "TEST -> " + TEST_TO}  fields=${fields.length} stages=${workflow.stages.length}  -> ${out}`);
