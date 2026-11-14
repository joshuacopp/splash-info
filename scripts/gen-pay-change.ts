// Generator for the "Pay Change" form (slug: pay-change).
//
// REPLACES FIVE JOTFORMS that were one process re-typed at every step
// (~108 submissions / 30 days, Nov 2026 audit):
//   250143453430041 Pay Change Request         (GM asks)
//   250143372028044 RM Approval of Rate of Pay  (RM approves, re-typed)
//   250142790635960 AM Approval of Rate of Pay  (RD approves, re-typed)
//   250144363046045 Rate of Pay Change Form     (manager + employee sign)
//   251284153618053 Pay Rate Acknowledgement-NY (NY Labor Law s.195.1 notice)
// Here the details are entered ONCE by the GM and travel through the workflow.
//
// FLOW (operator, 2026-11-13): GM requests -> the site's RM approves (signature)
// or denies (reason) -> the site's RD (locations.am_email) does the same ->
// the site gets a link and the EMPLOYEE signs on the tablet (their signature +
// printed name, recorded in the workflow history and on the PDF) -> the signed
// PDF goes to payroll@ and the site email. A denial at either step emails the
// requesting manager and the site with the reason. RM / RD / site emails come
// from pricing_simple via the site number, so nobody picks an approver.
//
// NY s.195 NOTICE: the GM fills it in at request time (payday, pay frequency,
// allowances, the employee's language) when the site is in New York; the
// acknowledgement wording is printed in the form and the employee's sign-off
// signature is the acknowledgement. HR should confirm that wording before
// go-live -- it is transcribed from the JotForm version.
//
// CONFIDENTIAL -- NOT SITE-SCOPED. Pay is personnel data (PLAN_FORMS_PERSONNEL.md).
// The site field is keyed `site`, NOT `site_number`, and the forms row gets
// scope_location_field_key = 'none:confidential' so publish does not inject or
// designate a scope field. Submissions are then readable only by admins and the
// workflow's own people. Do NOT rename the field to site_number or clear that
// column until phase 3's access rule exists.
//
// NO CHAINED CONDITIONS: forms-public.js does not cascade visibility (see the
// Time Card Edit generator), so every conditional field hangs off a question
// that is itself always shown.
//
// TEST MODE (default): every approver and recipient is TEST_TO, so one person
// can walk the whole chain from their inbox. LIVE=1 for the real routing.

import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { ApproverSource, Field, FormSchema, FormWorkflow } from "@splash/forms-schema";
import { formSchemaSchema, draftFormSchemaSchema } from "@splash/forms-schema";

const LIVE = process.env.LIVE === "1";
const TEST_TO = process.env.TEST_TO || "josh.copp@splashcarwashes.com";
const PAYROLL = "payroll@splashcarwashes.com";

function idFor(key: string): string {
  return createHash("sha1").update(`pay-change:${key}`).digest("hex").slice(0, 8);
}
const fields: Field[] = [];
function push(f: Omit<Field, "id"> & { id?: string }) {
  fields.push({ ...f, id: f.id ?? idFor(f.key) } as Field);
}

const PAY_TYPES = [
  { label: "Per hour", value: "hour" },
  { label: "Per week", value: "week" },
  { label: "Per year", value: "year" }
];

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
function lookup(key: string, label: string, sourceColumn: string, extra: Record<string, unknown> = {}) {
  push({
    key,
    type: "lookup",
    label,
    required: false,
    sourceTable: "pricing_simple",
    sourceColumn,
    keyColumn: "pricing_simple.site",
    keyFieldId: SITE_ID,
    resolutionMode: "prefill_hidden",
    nullBehavior: "block_submit",
    exclude_from_pdf: true,
    ...extra
  } as Field);
}
lookup("site_name", "Site", "location_pretty", {
  resolutionMode: "prefill_visible",
  exclude_from_pdf: false,
  show_in_queue: true
});
// No RM or RD on file -> nobody to approve; refuse rather than strand it.
lookup("rm_email", "Regional manager email", "rm_email");
lookup("rd_email", "Regional director email", "am_email");
lookup("site_email", "Site email", "site_email", { nullBehavior: "allow_empty" });

// --- Who --------------------------------------------------------------------------
push({
  key: "employee",
  type: "employee",
  label: "Employee",
  helpText: "Start typing their name.",
  required: true,
  keyFieldKey: "site",
  keyColumn: "pricing_simple.site",
  allowTyped: true,
  show_in_queue: true
} as Field);
push({ key: "manager_name", type: "name", label: "Manager requesting the change", required: true, maxLength: 120 } as Field);
push({
  key: "manager_email",
  type: "email",
  label: "Manager's email",
  helpText: "You'll be emailed if the request is denied.",
  required: true,
  hide_from_approvers: true
} as Field);

// --- The change -------------------------------------------------------------------
push({ key: "pay_heading", type: "heading", label: "Pay change", text: "Pay change", level: "h3", required: false } as Field);
push({
  key: "current_rate",
  type: "short_text",
  label: "Current pay rate ($)",
  required: true,
  maxLength: 20,
  placeholder: "15.50"
} as Field);
push({ key: "current_pay_type", type: "radio", label: "Current pay type", required: true, layout: "inline", options: PAY_TYPES } as Field);
push({
  key: "new_rate",
  type: "short_text",
  label: "Requested pay rate ($)",
  required: true,
  maxLength: 20,
  placeholder: "16.50",
  show_in_queue: true
} as Field);
push({ key: "new_pay_type", type: "radio", label: "Requested pay type", required: true, layout: "inline", options: PAY_TYPES } as Field);
push({
  key: "effective_date",
  type: "date",
  label: "Effective date (pay week beginning)",
  required: true,
  show_in_queue: true
} as Field);
push({
  key: "merits",
  type: "long_text",
  label: "Employee merits prompting the request",
  required: true,
  maxLength: 3000,
  rows: 4
} as Field);
push({
  key: "monthly_effect",
  type: "short_text",
  label: "Monthly cost of the change ($)",
  helpText: "Increase x average hours the employee works in a month.",
  required: true,
  maxLength: 20
} as Field);
push({ key: "labor_budget", type: "short_text", label: "This month's labor budget", required: true, maxLength: 40 } as Field);
push({ key: "labor_trend", type: "short_text", label: "Current monthly labor trend / pace", required: true, maxLength: 40 } as Field);
push({
  key: "back_pay",
  type: "radio",
  label: "Any retroactive pay due?",
  required: true,
  layout: "inline",
  options: [
    { label: "No", value: "no" },
    { label: "Yes", value: "yes" }
  ]
} as Field);
push({
  key: "back_pay_detail",
  type: "long_text",
  label: "Reason and hours / weeks of retroactive pay",
  required: true,
  maxLength: 2000,
  rows: 3,
  visible_if: { field_key: "back_pay", equals: ["yes"] }
} as Field);

// --- NY s.195.1 notice ----------------------------------------------------------------
push({
  key: "ny_site",
  type: "radio",
  label: "Is this site in New York State?",
  helpText: "New York requires a written pay-rate notice before a pay change.",
  required: true,
  hide_from_approvers: true,
  layout: "inline",
  options: [
    { label: "Yes", value: "yes" },
    { label: "No", value: "no" }
  ]
} as Field);
const NY = { field_key: "ny_site", equals: ["yes"] };
push({
  key: "ny_heading",
  type: "heading",
  label: "NY pay rate notice",
  text: "Notice of Pay Rate and Payday - NY Labor Law s.195.1 (given before a change in pay rate)",
  level: "h3",
  required: false,
  visible_if: NY,
  hide_from_approvers: true
} as Field);
push({ key: "ny_payday", type: "short_text", label: "Regular payday", placeholder: "e.g. Friday", required: true, maxLength: 40, visible_if: NY, hide_from_approvers: true } as Field);
push({
  key: "ny_pay_frequency",
  type: "radio",
  label: "Pay is",
  required: true,
  layout: "inline",
  options: [
    { label: "Weekly", value: "weekly" },
    { label: "Bi-weekly", value: "biweekly" },
    { label: "Other", value: "other" }
  ],
  visible_if: NY,
  hide_from_approvers: true
} as Field);
push({
  key: "ny_allowances",
  type: "multi",
  label: "Allowances taken",
  required: true,
  options: [
    { label: "None", value: "none" },
    { label: "Tips", value: "tips" },
    { label: "Meals", value: "meals" },
    { label: "Lodging", value: "lodging" },
    { label: "Other", value: "other" }
  ],
  visible_if: NY,
  hide_from_approvers: true
} as Field);
push({
  key: "ny_allowance_detail",
  type: "short_text",
  label: "Allowance amounts (if any)",
  helpText: "e.g. tips $X per hour, meals $X per meal. Leave blank if none.",
  required: false,
  maxLength: 200,
  visible_if: NY,
  hide_from_approvers: true
} as Field);
push({ key: "ny_primary_language", type: "short_text", label: "Employee's primary language", required: true, maxLength: 60, visible_if: NY, hide_from_approvers: true } as Field);
push({
  key: "ny_notice_language",
  type: "radio",
  label: "This notice is given",
  required: true,
  layout: "vertical",
  options: [
    { label: "In English, which is the employee's primary language", value: "english_primary" },
    { label: "In English only - the Department of Labor does not yet offer it in the employee's primary language", value: "english_only" }
  ],
  visible_if: NY,
  hide_from_approvers: true
} as Field);
push({
  key: "ny_ack_text",
  type: "heading",
  label: "Employee acknowledgement",
  text:
    "Employee acknowledgement (signed when the change is approved): On this day, I received notice of my pay rate, overtime rate (if eligible), allowances, and designated payday. I told my employer what my primary language is. Overtime is in most cases 1.5 times the regular rate of pay for the week.",
  level: "h4",
  required: false,
  visible_if: NY,
  hide_from_approvers: true
} as Field);

push({ key: "manager_signature", type: "signature", label: "Manager signature", required: true, format: "png" } as Field);

// --- Workflow ---------------------------------------------------------------------------
const test = (live: ApproverSource[]): ApproverSource[] =>
  LIVE ? live : [{ type: "static_emails", emails: [TEST_TO] }];
const T = LIVE ? "" : "[TEST] ";
const rm = test([{ type: "payload_field", field_key: "rm_email" }]);
const rd = test([{ type: "payload_field", field_key: "rd_email" }]);
const siteAndManager = test([
  { type: "payload_field", field_key: "site_email" },
  { type: "payload_field", field_key: "manager_email" }
]);
const payrollAndSite = test([
  { type: "static_emails", emails: [PAYROLL] },
  { type: "payload_field", field_key: "site_email" }
]);
const WHO = "{field.employee} at {field.site_name}";
// What an approver decides on, one line each. NOT {payload.summary}: that
// dumps every answer (routing emails, the NY notice, signatures) and buries
// the decision (operator feedback, 2026-11-13).
const FACTS = [
  "Pay: ${field.current_rate} {field.current_pay_type} -> ${field.new_rate} {field.new_pay_type}",
  "Effective: {field.effective_date}",
  "Monthly cost: ${field.monthly_effect}",
  "Labor budget / trend: {field.labor_budget} / {field.labor_trend}",
  "Back pay: {field.back_pay}",
  "Requested by: {field.manager_name}"
].join("\n");

const workflow: FormWorkflow = {
  default_stage: "notify_rm",
  stages: [
    {
      id: "notify_rm",
      label: "Email RM",
      kind: "email",
      recipients: rm,
      subject_template: `${T}Pay change to approve: ${WHO}`,
      body_template: [
        "{field.manager_name} has requested a pay change for " + WHO + ".",
        FACTS,
        "Merits: {field.merits}",
        "{approval.link}",
        "Opens without signing in; expires in 7 days. Approve needs your signature, deny needs a reason."
      ].join("\n\n"),
      transitions: [{ to: "rm_review", label: "Sent" }]
    },
    {
      id: "rm_review",
      label: "RM approval",
      kind: "approval",
      approver_source: rm[0]!,
      transitions: [
        { to: "notify_rd", label: "Approve", requires: { signature: true } },
        { to: "denied_email", label: "Deny", requires: { note: true } }
      ]
    },
    {
      id: "notify_rd",
      label: "Email RD",
      kind: "email",
      recipients: rd,
      subject_template: `${T}Pay change to approve: ${WHO}`,
      body_template: [
        "The regional manager approved this pay change for " + WHO + ". It now needs your approval.",
        FACTS,
        "Merits: {field.merits}",
        "{approval.link}",
        "Opens without signing in; expires in 7 days. Approve needs your signature, deny needs a reason."
      ].join("\n\n"),
      transitions: [{ to: "rd_review", label: "Sent" }]
    },
    {
      id: "rd_review",
      label: "RD approval",
      kind: "approval",
      approver_source: rd[0]!,
      transitions: [
        { to: "notify_site", label: "Approve", requires: { signature: true } },
        { to: "denied_email", label: "Deny", requires: { note: true } }
      ]
    },
    {
      id: "notify_site",
      label: "Email site for employee signature",
      kind: "email",
      recipients: siteAndManager,
      subject_template: `${T}Approved - employee signature needed: ${WHO}`,
      approval_link_label: "Open for employee signature",
      body_template: [
        "The pay change for " + WHO + " is approved.",
        "Open the link below with the employee and have them sign to acknowledge the new rate. It is not sent to payroll until they sign.",
        FACTS,
        "{approval.link}"
      ].join("\n\n"),
      transitions: [{ to: "employee_signoff", label: "Sent" }]
    },
    {
      // THE EMPLOYEE signs here, not the manager (operator, 2026-11-13: the
      // generic approval page read as if the manager were signing). The
      // manager opens the link and hands the tablet over; the page says so,
      // shows only what the employee is acknowledging, and labels the boxes
      // as the employee's.
      id: "employee_signoff",
      label: "Employee acknowledgement",
      kind: "approval",
      approver_source: siteAndManager[0]!,
      page_intro:
        "Manager: hand this device to {field.employee}.\n\n" +
        "{field.employee}: your pay rate is changing as shown below. Please review it, then type your name and sign to acknowledge that you have been told your new pay rate" +
        " (and, in New York, your overtime rate, allowances and payday).",
      show_fields: [
        "employee",
        "site_name",
        "current_rate",
        "current_pay_type",
        "new_rate",
        "new_pay_type",
        "effective_date"
      ],
      // The NY notice as it will read -- including the 1.5x overtime rate --
      // rather than the raw NY answers (operator: the page only MENTIONED
      // overtime). Same code that fills the notice computes it.
      show_ny_pay_notice: true,
      transitions: [
        {
          to: "payroll_email",
          label: "Sign and submit",
          requires: { signature: true, typed_name: true },
          typed_name_label: "Employee's full name",
          signature_label: "Employee signature"
        }
      ]
    },
    {
      id: "payroll_email",
      label: "Email payroll",
      kind: "email",
      recipients: payrollAndSite,
      attach_pdf: true,
      // The official NY s.195.1 notice (LS 54 / LS 59), filled and signed by
      // the employee, for NY sites only.
      attach_ny_pay_notice: true,
      subject_template: `${T}Approved pay change: ${WHO}`,
      body_template: [
        "Approved and signed pay change for " + WHO + ".",
        FACTS,
        "The signed form, with both approvals and the employee's acknowledgement, is attached."
      ].join("\n\n"),
      transitions: [{ to: "approved", label: "Sent" }]
    },
    {
      id: "denied_email",
      label: "Email denial",
      kind: "email",
      recipients: siteAndManager,
      attach_pdf: true,
      subject_template: `${T}Pay change denied: ${WHO}`,
      body_template: [
        "The pay change for " + WHO + " was denied by {decision.by}.",
        "Reason: {decision.note}",
        FACTS
      ].join("\n\n"),
      transitions: [{ to: "denied", label: "Sent" }]
    },
    { id: "approved", label: "Approved", kind: "outcome", tint: "success", transitions: [] },
    { id: "denied", label: "Denied", kind: "outcome", tint: "danger", transitions: [] }
  ]
};

// With TEST_TO everywhere the employee-signoff approver list collapses to one
// address; LIVE has two (site + manager), so take the whole list there.
if (LIVE) {
  const so = workflow.stages.find((s) => s.id === "employee_signoff")!;
  // ApproverSource is a single source; route the sign-off to the site inbox,
  // the tablet's shared login. The manager still gets the email with the link.
  so.approver_source = { type: "payload_field", field_key: "site_email" };
}

const schema: FormSchema = { fields, workflow };

// --- Checks ---------------------------------------------------------------------------------
const ids = fields.map((f) => f.id);
const keys = fields.map((f) => f.key);
for (const [what, list] of [["id", ids], ["key", keys]] as const) {
  const dup = [...new Set(list.filter((x, i) => list.indexOf(x) !== i))];
  if (dup.length) throw new Error(`duplicate field ${what}s: ${dup.join(", ")}`);
}
for (const st of workflow.stages) {
  for (const k of st.show_fields ?? []) {
    if (!keys.includes(k)) throw new Error(`stage ${st.id}: show_fields names unknown field ${k}`);
  }
}
if (keys.includes("site_number")) throw new Error("pay-change must not have a site_number field (confidential, unscoped)");
const queued = fields.filter((f) => f.show_in_queue).length;
if (queued > 5) throw new Error(`show_in_queue on ${queued} fields; the queue shows 5`);
for (const f of fields) {
  if (f.visible_if) {
    const ctl = fields.find((c) => c.key === f.visible_if!.field_key);
    if (ctl?.visible_if) throw new Error(`${f.key}: chained visible_if via ${ctl.key} (forms-public.js does not cascade)`);
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

const out = process.argv[2] ?? "pay-change.json";
writeFileSync(out, JSON.stringify(schema));
console.log(`ok  ${LIVE ? "LIVE" : "TEST -> " + TEST_TO}  fields=${fields.length} stages=${workflow.stages.length}  -> ${out}`);
