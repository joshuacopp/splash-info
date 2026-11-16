// Generator for the two termination forms (2026-11-15):
//
//   employee-termination-report     -- the Employee Termination Report
//   employee-termination-checklist  -- the Employment Termination Checklist
//
// Two separate forms by operator decision. BOTH ARE NORMALLY FILLED BY THE
// SITE GM (operator, 2026-11-15): the report at the time of the termination,
// the checklist as its steps get done (COBRA, last paycheck, Divvy, iSolved,
// email access...), often over several days -- hence save-and-continue. A GM
// on a shared tablet saves to their site inbox or their own Splash address.
//
// BOTH ARE:
//   * link-only behind a SECRET LINK (forms.link_key) -- a random URL that can
//     be changed from the builder's Settings tab, killing old links at once;
//   * "Save and continue later" (forms.email_drafts) -- answers saved
//     server-side, a private resume link emailed to a Splash address, 14 days;
//     the tablet's browser keeps no copy;
//   * CONFIDENTIAL, NOT SITE-SCOPED (scope_location_field_key =
//     'none:confidential'; the site field is keyed `site`, never `site_number`)
//     -- anyone with the link can FILL the form, but only admins and people
//     given access can VIEW submissions;
//   * notify_webhook = false (personnel records stay off the generic webhook);
//   * in TEST MODE (forms.test_email_to) until the operator switches it off.
//
// DOCUMENTS. Each form fills its own paper form as a PDF template (builder
// Documents tab), attached to its email step:
//   * Report    -> the Splash-branded Employee Termination Report (rebuilt on
//                  the checklist's letterhead, scripts/termination-report-pdf.py;
//                  REPORT_BOXES below are measured from that script's layout).
//   * Checklist -> the Employment Termination Checklist PDF as HR supplied it
//                  (CHECKLIST_BOXES measured from its own checkboxes and lines).
// The PDFs are uploaded through the Documents tab (that is what stores them in
// R2); termination-forms-02-documents.sql then places the boxes and attaches
// the document to the email step. Re-upload = re-run that file.
//
// RECIPIENTS. The paper says completed paperwork goes to Daina and Shane.
// They are payroll@ (Daina) and slowe@ (Shane); HR_TO=a@x,b@y overrides.
//
//   npx tsx scripts/gen-termination.ts      (writes the two SQL files)

import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { Field, FormSchema, FormWorkflow, PdfBox } from "@splash/forms-schema";
import { formSchemaSchema, draftFormSchemaSchema } from "@splash/forms-schema";

const OPERATOR = "josh.copp@splashcarwashes.com";
// Daina = payroll@, Shane = slowe@ (operator, 2026-11-15).
const HR_TO = (process.env.HR_TO ?? "payroll@splashcarwashes.com,slowe@splashcarwashes.com")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const TEST_TO = process.env.TEST_TO || OPERATOR;
const CREATED_BY = "f42882fd-ee5a-433e-b10b-713d5dff8a89"; // operator's auth user id (as in the other gen scripts)

const REPORT_SLUG = "employee-termination-report";
const CHECKLIST_SLUG = "employee-termination-checklist";
const REPORT_DOC = "Employee Termination Report";
const CHECKLIST_DOC = "Employment Termination Checklist";

// ---------------------------------------------------------------------------------------
// Field helpers
// ---------------------------------------------------------------------------------------

function builder(ns: string) {
  const fields: Field[] = [];
  const idFor = (key: string) => createHash("sha1").update(`${ns}:${key}`).digest("hex").slice(0, 8);
  const push = (f: Omit<Field, "id">) => fields.push({ ...f, id: idFor(f.key) } as Field);
  const when = (key: string, ...v: string[]) => ({ visible_if: { field_key: key, equals: v } });
  // Site number + the site's name, looked up. Keyed `site` (NOT site_number):
  // these are confidential and must never be tied to a site's viewers.
  const site = (label: string, help: string) => {
    push({ key: "site", type: "short_text", label, helpText: help, required: true, maxLength: 10 } as Field);
    push({
      key: "site_name",
      type: "lookup",
      label: "Site",
      required: false,
      sourceTable: "pricing_simple",
      sourceColumn: "location_pretty",
      keyColumn: "pricing_simple.site",
      keyFieldId: idFor("site"),
      resolutionMode: "prefill_visible",
      nullBehavior: "block_submit", // an unknown site number is a typo
      show_in_queue: true
    } as Field);
  };
  const employee = () =>
    push({
      key: "employee",
      type: "employee",
      label: "Employee",
      helpText: "Start typing their name. Not listed? Type their full name and use it.",
      required: true,
      keyFieldKey: "site",
      keyColumn: "pricing_simple.site",
      allowTyped: true,
      show_in_queue: true
    } as Field);
  const yesNo = (key: string, label: string, extra: Record<string, unknown> = {}) =>
    push({
      key,
      type: "radio",
      label,
      required: true,
      layout: "inline",
      options: [
        { label: "Yes", value: "yes" },
        { label: "No", value: "no" }
      ],
      ...extra
    } as Field);
  return { fields, push, when, site, employee, yesNo };
}

// ---------------------------------------------------------------------------------------
// 1. Employee Termination Report (the site GM)
// ---------------------------------------------------------------------------------------

const R = builder("termination-report");
R.site("Employee's site number", "3-digit site number (leading zeros optional).");
R.employee();
R.push({ key: "termination_date", type: "date", label: "Date of termination", required: true, show_in_queue: true } as Field);
R.push({
  key: "manager_approved_by",
  type: "name",
  label: "Manager who approved the termination",
  required: true,
  maxLength: 120
} as Field);
R.push({
  key: "reason",
  type: "radio",
  label: "Reason the employee is being terminated",
  helpText: "Make sure previous warnings are documented, including the final one.",
  required: true,
  layout: "vertical",
  options: [
    { label: "Fired", value: "fired" },
    { label: "Voluntarily quit", value: "voluntary_quit" },
    { label: "Job abandonment", value: "job_abandonment" },
    { label: "Medical leave", value: "medical_leave" },
    { label: "Other", value: "other" }
  ],
  show_in_queue: true
} as Field);
// The paper leaves only a short blank after "Other:".
R.push({ key: "reason_other", type: "short_text", label: "Other reason", required: true, maxLength: 40, ...R.when("reason", "other") } as Field);
R.push({
  key: "details",
  type: "long_text",
  label: "Details of termination",
  helpText:
    "The facts: what happened and when. For a medical leave, don't describe the condition. Keep it short enough for the printed form (about 1,000 characters).",
  required: true,
  maxLength: 1000,
  rows: 6
} as Field);
R.yesNo("eligible_rehire", "Is this employee eligible for rehire?");
R.yesNo("medical_plan", "Was this employee on a medical plan?");
R.yesNo("has_property", "Does the employee have company property?");
R.push({
  key: "property_detail",
  type: "long_text",
  label: "What company property do they have?",
  required: true,
  maxLength: 350,
  rows: 3,
  ...R.when("has_property", "yes")
} as Field);
R.push({ key: "sign_heading", type: "heading", label: "Signatures", text: "Signatures", level: "h3", required: false } as Field);
R.push({ key: "manager_name", type: "name", label: "Your name", required: true, maxLength: 120 } as Field);
R.push({
  key: "manager_email",
  type: "email",
  label: "Your email",
  helpText: "A copy of the completed report is sent here.",
  required: true
} as Field);
R.push({ key: "manager_signature", type: "signature", label: "Manager signature", required: true, format: "png" } as Field);
R.push({
  key: "employee_signs",
  type: "radio",
  label: "Is the employee here to sign?",
  required: true,
  layout: "vertical",
  options: [
    { label: "Yes - hand them the tablet", value: "yes" },
    { label: "No - not present, or refused to sign", value: "no" }
  ]
} as Field);
R.push({
  key: "employee_signature",
  type: "signature",
  label: "Employee signature",
  helpText: "Signing confirms you received this report, not that you agree with it.",
  required: true,
  format: "png",
  ...R.when("employee_signs", "yes")
} as Field);
R.push({
  key: "employee_sign_date",
  type: "date",
  label: "Date the employee signed",
  required: true,
  defaultToToday: true,
  ...R.when("employee_signs", "yes")
} as Field);

const REPORT_WORKFLOW: FormWorkflow = {
  default_stage: "send",
  stages: [
    {
      id: "send",
      label: "Email the report to HR and the manager",
      kind: "email",
      recipients: [
        { type: "static_emails", emails: HR_TO },
        { type: "payload_field", field_key: "manager_email" }
      ],
      subject_template: "Employee termination report: {field.employee} at {field.site_name}",
      body_template: [
        "{field.manager_name} submitted an employee termination report for {field.employee} at {field.site_name}.",
        "Date of termination: {field.termination_date}\nReason: {field.reason}",
        "The signed report is attached. The Employment Termination Checklist follows once its steps are done.",
        "This is a confidential personnel record. Please don't forward it."
      ].join("\n\n"),
      transitions: [{ to: "filed", label: "Sent" }]
    },
    { id: "filed", label: "Filed", kind: "outcome", tint: "neutral", transitions: [] }
  ]
};

// ---------------------------------------------------------------------------------------
// 2. Employment Termination Checklist (the site GM)
// ---------------------------------------------------------------------------------------

// Paper order and wording (lightly tidied: "electrically" -> "electronically").
const STEPS: Array<[string, string]> = [
  ["unemployment", "Unemployment paperwork handed or electronically sent to employee"],
  ["cobra", "COBRA letter drafted and mailed to employee, if necessary"],
  ["last_paycheck", "Last paycheck handed to employee or scheduled for direct deposit"],
  ["location_keys", "Location keys recovered from employee"],
  ["email_access", "Company email access removed (contact Shane or Roger)"],
  ["divvy", "Divvy access removed and Divvy business card recovered, if necessary (contact Blayne)"],
  ["alarm_codes", "Security alarm system codes changed, if necessary"],
  ["building_locks", "Building keys and locks changed, if necessary"],
  ["micrologic", "Micrologic (Wash Assist) access removed"],
  ["connect_team", "Connect Team account access removed, if necessary"],
  ["isolved", "iSolved manager access removed, if necessary"],
  ["property", "Splash Car Wash property recovered from the employee"],
  ["business_accounts", "Business account access removed and passwords changed"],
  ["spot_ai", "Spot A.I. software access removed, if necessary"],
  ["kiosk", "Kiosk codes and keys changed, if necessary"],
  ["paperwork_sent", "Termination paperwork and employee write-ups sent to Daina and Shane"]
];
const MICROLOGIC: Array<[string, string]> = [
  ["inactive", "Employee account made inactive"],
  ["deactivated", "User account deactivated"]
];
const PROPERTY: Array<[string, string]> = [
  ["laptop", "Company laptop"],
  ["printer", "Company printer"],
  ["vehicle", "Company vehicle"],
  ["tools", "Company tools"],
  ["key_card", "Company key card for the office suite"]
];
const ACCOUNTS: Array<[string, string]> = [
  ["wb_mason", "W.B. Mason"],
  ["grainger", "Grainger"],
  ["sonnys", "Sonny's"]
];
const opts = (list: Array<[string, string]>) => list.map(([value, label]) => ({ label, value }));

const C = builder("termination-checklist");
C.site("Employee's site number", "3-digit site number (leading zeros optional).");
C.employee();
C.push({ key: "termination_date", type: "date", label: "Date of termination", required: true, show_in_queue: true } as Field);
C.push({
  key: "steps_heading",
  type: "heading",
  label: "Checklist",
  text: "Checklist",
  level: "h3",
  helpText:
    "Tick each step when it's done. You can save and come back as steps get finished. Steps marked \"if necessary\" can stay unticked when they don't apply; say why in Notes.",
  required: false
} as Field);
C.push({ key: "steps", type: "multi", label: "Completed steps", required: false, options: opts(STEPS) } as Field);
C.push({
  key: "micrologic_steps",
  type: "multi",
  label: "Micrologic (Wash Assist)",
  required: false,
  options: opts(MICROLOGIC),
  ...C.when("steps", "micrologic")
} as Field);
C.push({
  key: "property_recovered",
  type: "multi",
  label: "Property recovered",
  helpText: "Tick what was returned.",
  required: false,
  options: opts(PROPERTY),
  ...C.when("steps", "property")
} as Field);
C.push({
  key: "accounts_changed",
  type: "multi",
  label: "Business accounts: access removed and password changed",
  required: false,
  options: opts(ACCOUNTS),
  ...C.when("steps", "business_accounts")
} as Field);
C.push({
  key: "notes",
  type: "long_text",
  label: "Notes",
  helpText: "About 300 characters fit on the printed checklist.",
  required: false,
  maxLength: 300,
  rows: 3
} as Field);
C.push({ key: "sign_heading", type: "heading", label: "Sign off", text: "Sign off", level: "h3", required: false } as Field);
C.push({ key: "completed_by_name", type: "name", label: "Your name", required: true, maxLength: 120 } as Field);
C.push({
  key: "completed_by_email",
  type: "email",
  label: "Your email",
  helpText: "A copy of the completed checklist is sent here.",
  required: true
} as Field);
C.push({
  key: "signature",
  type: "signature",
  label: "Signature",
  helpText: "Sign once the checklist is complete.",
  required: true,
  format: "png"
} as Field);

const CHECKLIST_WORKFLOW: FormWorkflow = {
  default_stage: "send",
  stages: [
    {
      id: "send",
      label: "Email the checklist to HR and the person who completed it",
      kind: "email",
      recipients: [
        { type: "static_emails", emails: HR_TO },
        { type: "payload_field", field_key: "completed_by_email" }
      ],
      subject_template: "Employment termination checklist completed: {field.employee} at {field.site_name}",
      body_template: [
        "{field.completed_by_name} completed the employment termination checklist for {field.employee} at {field.site_name} (terminated {field.termination_date}).",
        "The signed checklist is attached.",
        "This is a confidential personnel record. Please don't forward it."
      ].join("\n\n"),
      transitions: [{ to: "filed", label: "Sent" }]
    },
    { id: "filed", label: "Filed", kind: "outcome", tint: "neutral", transitions: [] }
  ]
};

// ---------------------------------------------------------------------------------------
// PDF boxes (points, top-left origin -- see packages/forms-schema/src/pdf-template.ts)
// ---------------------------------------------------------------------------------------

let boxN = 0;
const bid = (ns: string) => createHash("sha1").update(`${ns}:box:${boxN++}`).digest("hex").slice(0, 10);

/** Measured from scripts/termination-report-pdf.py (its report_spots.json). */
function reportBoxes(): PdfBox[] {
  const b: PdfBox[] = [];
  const add = (x: number, y: number, w: number, h: number, source: PdfBox["source"], extra: Partial<PdfBox> = {}) =>
    b.push({ id: bid("report"), page: 0, x, y, w, h, source, ...extra });
  const f = (key: string) => ({ type: "field" as const, key });
  const chk = (key: string, value: string) => ({ type: "check" as const, key, value });
  add(130, 203, 188, 13, f("employee"), { font_size: 11 });
  add(384, 203, 156, 13, f("site_name"), { font_size: 11 });
  add(179.3, 233, 138.7, 13, f("termination_date"), { font_size: 11 });
  add(406.3, 233, 133.7, 13, { type: "submitted_date" }, { font_size: 11 });
  add(186.6, 263, 213.4, 13, f("manager_approved_by"), { font_size: 11 });
  add(72, 341, 11, 12, chk("reason", "fired"));
  add(126.3, 341, 11, 12, chk("reason", "voluntary_quit"));
  add(235, 341, 11, 12, chk("reason", "job_abandonment"));
  add(351.6, 341, 11, 12, chk("reason", "medical_leave"));
  add(452.3, 341, 11, 12, chk("reason", "other"));
  add(503.9, 341, 36.1, 13, f("reason_other"));
  add(72, 388.2, 468, 110, f("details"), { multiline: true, line_height: 22, font_size: 11 });
  for (const [key, y] of [["eligible_rehire", 523], ["medical_plan", 547], ["has_property", 571]] as const) {
    add(352, y, 11, 12, chk(key, "yes"));
    add(403.7, y, 11, 12, chk(key, "no"));
  }
  add(72, 584.2, 468, 48, f("property_detail"), { multiline: true, line_height: 24, font_size: 11 });
  add(86, 654, 134, 34, f("manager_signature"));
  add(233, 677, 63, 13, { type: "submitted_date" }, { font_size: 10 });
  add(332, 654, 134, 34, f("employee_signature"));
  add(479, 677, 61, 13, f("employee_sign_date"), { font_size: 10 });
  return b;
}

/** Measured from the checklist PDF itself (its drawn boxes and ruled lines). */
function checklistBoxes(): PdfBox[] {
  const b: PdfBox[] = [];
  const add = (page: number, x: number, y: number, w: number, h: number, source: PdfBox["source"], extra: Partial<PdfBox> = {}) =>
    b.push({ id: bid("checklist"), page, x, y, w, h, source, ...extra });
  // Who this is about -- the paper has no blank for it; between the title and item 1.
  add(0, 72, 179, 48, 13, { type: "text", text: "Employee:" }, { font_size: 10 });
  add(0, 120, 179, 200, 13, { type: "field", key: "employee" }, { font_size: 10 });
  add(0, 330, 179, 26, 13, { type: "text", text: "Site:" }, { font_size: 10 });
  add(0, 356, 179, 184, 13, { type: "field", key: "site_name" }, { font_size: 10 });
  // The checklist's own boxes, top to bottom (x, y of each drawn square).
  const BOX_XY: Array<[number, number]> = [
    [55.5, 197.7], [55.5, 218.7], [55.5, 239.8], [55.5, 259.2], [55.5, 280.1], [55.5, 301.7],
    [55.5, 319.5], [55.5, 341.1], [54.6, 362.1], [55.5, 425.1], [55.5, 443.7], [55.5, 467.0],
    [50.4, 590.6], [54.6, 673.1], [55.5, 696.3], [55.5, 715.1]
  ];
  if (BOX_XY.length !== STEPS.length) throw new Error("checklist boxes and steps out of step");
  STEPS.forEach(([value], i) => {
    const [x, y] = BOX_XY[i]!;
    add(0, x, y, 12.9, 14.2, { type: "check", key: "steps", value });
  });
  // Sub-items (a., b., ...) have no box on paper: a tick just left of the letter.
  const sub = (key: string, list: Array<[string, string]>, tops: number[]) =>
    list.forEach(([value], i) => add(0, 93, tops[i]! + 1, 11, 12, { type: "check", key, value }));
  sub("micrologic_steps", MICROLOGIC, [389, 410]);
  sub("property_recovered", PROPERTY, [493, 514, 534, 555, 576]);
  sub("accounts_changed", ACCOUNTS, [617, 638, 659]);
  // Page 2: Notes on the three ruled lines (baselines ~2pt above each rule),
  // then the signature on its line, the date, and the signer's printed name.
  // The rules are rows of underscores whose baselines sit at ~88.5 / 102.5 / 116.5.
  add(1, 38, 76.5, 536, 42, { type: "field", key: "notes" }, { multiline: true, line_height: 14, font_size: 10 });
  add(1, 98, 161, 200, 25, { type: "field", key: "signature" });
  add(1, 316, 176, 250, 13, { type: "field", key: "completed_by_name" }, { font_size: 10 });
  add(1, 68, 202, 220, 13, { type: "submitted_date" }, { font_size: 10 });
  return b;
}

// ---------------------------------------------------------------------------------------
// Checks + SQL
// ---------------------------------------------------------------------------------------

function check(name: string, schema: FormSchema): void {
  const fields = schema.fields;
  const keys = fields.map((f) => f.key);
  const ids = fields.map((f) => f.id);
  for (const [what, list] of [["id", ids], ["key", keys]] as const) {
    const dup = [...new Set(list.filter((x, i) => list.indexOf(x) !== i))];
    if (dup.length) throw new Error(`${name}: duplicate field ${what}s: ${dup.join(", ")}`);
  }
  if (keys.includes("site_number")) throw new Error(`${name}: must not have a site_number field (confidential, unscoped)`);
  const queued = fields.filter((f) => f.show_in_queue).length;
  if (queued > 5) throw new Error(`${name}: show_in_queue on ${queued} fields; the queue shows 5`);
  for (const f of fields) {
    if (!f.visible_if) continue;
    const ctl = fields.find((c) => c.key === f.visible_if!.field_key);
    if (!ctl) throw new Error(`${name}: ${f.key} visible_if names an unknown field`);
    if (ctl.visible_if) throw new Error(`${name}: ${f.key} chained visible_if (forms-public.js does not cascade)`);
  }
  for (const [label, v] of [
    ["strict", formSchemaSchema],
    ["draft", draftFormSchemaSchema]
  ] as const) {
    const r = v.safeParse(schema);
    if (!r.success) {
      console.error(`${name}: ${label} validation FAILED`);
      console.error(JSON.stringify(r.error.issues.slice(0, 12), null, 2));
      process.exit(1);
    }
  }
}

function checkBoxes(name: string, schema: FormSchema, boxes: PdfBox[]): void {
  const keys = new Set(schema.fields.map((f) => f.key));
  for (const box of boxes) {
    const s = box.source;
    if ((s.type === "field" || s.type === "check") && !keys.has(s.key)) throw new Error(`${name}: box for unknown field ${s.key}`);
    if (s.type === "check") {
      const f = schema.fields.find((x) => x.key === s.key) as { options?: Array<{ value: string }> };
      if (!f.options?.some((o) => o.value === s.value)) throw new Error(`${name}: box ticks unknown option ${s.key}=${s.value}`);
    }
  }
}

const dollar = (tag: string, s: string) => {
  if (s.includes(`$${tag}$`)) throw new Error("dollar tag collision");
  return `$${tag}$${s}$${tag}$`;
};
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

function formSql(args: {
  slug: string;
  title: string;
  description: string;
  success: string;
  schema: FormSchema;
  tag: string;
}): string {
  const json = dollar(args.tag, JSON.stringify(args.schema));
  return `-- ${args.title} (${args.slug})
insert into public.forms
  (slug, title, description, audience, status, notify_webhook,
   turnstile_required, success_message, created_by, last_edited_by)
values
  (${lit(args.slug)}, ${lit(args.title)}, ${lit(args.description)}, 'link-only', 'draft', false, false,
   ${lit(args.success)}, '${CREATED_BY}', '${CREATED_BY}')
on conflict (slug) do update
  set title = excluded.title,
      description = excluded.description,
      audience = excluded.audience,
      notify_webhook = excluded.notify_webhook,
      turnstile_required = excluded.turnstile_required,
      success_message = excluded.success_message,
      last_edited_at = now();

-- Confidential; save-and-continue on; test mode on; a secret link if it has
-- none yet (a re-run never changes a link people are already using).
update public.forms
   set scope_location_field_key = 'none:confidential',
       email_drafts = true,
       test_email_to = coalesce(test_email_to, ${lit(TEST_TO)}),
       link_key = coalesce(link_key, replace(gen_random_uuid()::text, '-', ''))
 where slug = ${lit(args.slug)};

with f as (select id, draft_version_id from public.forms where slug = ${lit(args.slug)}),
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
 where f.slug = ${lit(args.slug)} and v.id = f.draft_version_id;
`;
}

function docSql(slug: string, docName: string, boxes: PdfBox[], tag: string): string {
  return `-- ${docName} on ${slug}
update public.form_pdf_templates t
   set boxes = ${dollar(tag, JSON.stringify(boxes))}::jsonb, updated_at = now()
  from public.forms f
 where t.form_id = f.id and f.slug = ${lit(slug)} and t.name = ${lit(docName)};

-- Attach it to the email step (stage 0) of the DRAFT; publish to take effect.
update public.form_versions v
   set schema = jsonb_set(v.schema, '{workflow,stages,0,attach_documents}', jsonb_build_array(t.id::text))
  from public.forms f
  join public.form_pdf_templates t on t.form_id = f.id and t.name = ${lit(docName)}
 where f.slug = ${lit(slug)} and v.id = f.draft_version_id;
`;
}

const reportSchema: FormSchema = { fields: R.fields, workflow: REPORT_WORKFLOW };
const checklistSchema: FormSchema = { fields: C.fields, workflow: CHECKLIST_WORKFLOW };
check(REPORT_SLUG, reportSchema);
check(CHECKLIST_SLUG, checklistSchema);
const rBoxes = reportBoxes();
const cBoxes = checklistBoxes();
checkBoxes(REPORT_SLUG, reportSchema, rBoxes);
checkBoxes(CHECKLIST_SLUG, checklistSchema, cBoxes);

const header = `-- Generated by scripts/gen-termination.ts -- edit that, not this file.
-- NOT YET APPLIED. Needs supabase/forms-secret-links-and-drafts-01.sql first
-- (link_key / email_drafts columns).
--
-- HR recipients: ${HR_TO.join(", ")}${HR_TO.length === 1 && HR_TO[0] === OPERATOR ? "  <-- PLACEHOLDER: regenerate with HR_TO=<Daina>,<Shane>" : ""}
-- Test mode: every email goes only to ${TEST_TO} until switched off on the Settings tab.
`;

writeFileSync(
  "supabase/termination-forms-01.sql",
  header +
    "\n" +
    formSql({
      slug: REPORT_SLUG,
      title: "Employee Termination Report",
      description: "Report an employee termination. The signed report is emailed to HR.",
      success: "Thanks - the termination report has been sent to HR, with a copy to you. Next, work through the Employment Termination Checklist; you can save it and come back as steps get done.",
      schema: reportSchema,
      tag: "tr"
    }) +
    "\n" +
    formSql({
      slug: CHECKLIST_SLUG,
      title: "Employment Termination Checklist",
      description: "Work through the steps after a termination. Save as you go; submit once everything is done.",
      success: "Thanks - the completed checklist has been sent to HR, with a copy to you.",
      schema: checklistSchema,
      tag: "tc"
    }) +
    `
select f.slug, f.audience, f.status, f.scope_location_field_key, f.email_drafts, f.test_email_to,
       '/forms/' || f.link_key as secret_url,
       jsonb_array_length(v.schema->'fields') as fields
  from public.forms f join public.form_versions v on v.id = f.draft_version_id
 where f.slug in ('${REPORT_SLUG}', '${CHECKLIST_SLUG}');
`
);

writeFileSync(
  "supabase/termination-forms-02-documents.sql",
  `-- Generated by scripts/gen-termination.ts -- edit that, not this file.
-- Run AFTER uploading each PDF on its form's Documents tab, named EXACTLY:
--   ${REPORT_SLUG}:    "${REPORT_DOC}"     (Splash_Termination_Form.pdf)
--   ${CHECKLIST_SLUG}: "${CHECKLIST_DOC}"  (Termination_Checklist.pdf)
-- Places the fill boxes and attaches each document to the form's email step,
-- then publish each form. Safe to re-run (e.g. after re-uploading a PDF).

` +
    docSql(REPORT_SLUG, REPORT_DOC, rBoxes, "rb") +
    "\n" +
    docSql(CHECKLIST_SLUG, CHECKLIST_DOC, cBoxes, "cb") +
    `
select f.slug, t.name, jsonb_array_length(t.boxes) as boxes,
       v.schema->'workflow'->'stages'->0->'attach_documents' as attached
  from public.forms f
  join public.form_pdf_templates t on t.form_id = f.id
  join public.form_versions v on v.id = f.draft_version_id
 where f.slug in ('${REPORT_SLUG}', '${CHECKLIST_SLUG}');
`
);

writeFileSync("scripts/.termination-boxes.json", JSON.stringify({ report: rBoxes, checklist: cBoxes }));
console.log(
  `ok  report fields=${R.fields.length} boxes=${rBoxes.length}  checklist fields=${C.fields.length} boxes=${cBoxes.length}  HR_TO=${HR_TO.join(",")}`
);
