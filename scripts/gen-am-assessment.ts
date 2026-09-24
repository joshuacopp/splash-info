// Generator for the Area Manager Site Assessment form schema.
//
// Ported from JotForm 250656455549063. Emits ONE json file that the SQL insert
// reads, and strict-validates it against formSchemaSchema first -- the point of
// generating rather than hand-writing 100+ fields is that the validator sees
// exactly what the database will.

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import {
  formSchemaSchema,
  draftFormSchemaSchema,
  type Field,
  type FormSchema,
  type FormWorkflow
} from "@splash/forms-schema";

const SITE_KEY = "site_number"; // handlePublish finds the scope field by THIS key

// ---------------------------------------------------------------------------
// ids: hash of the key, not a truncation of it. Truncating collided on the RM
// form (safety_eye_wash / safety_evacuation_plan both begin "safety_e") and put
// two fields on one DOM id. Zod does not check id uniqueness; we do, below.
// ---------------------------------------------------------------------------
function idFor(key: string): string {
  return createHash("sha1").update(`am-assessment:${key}`).digest("hex").slice(0, 8);
}

const fields: Field[] = [];
function push(f: Omit<Field, "id"> & { id?: string }) {
  fields.push({ ...f, id: f.id ?? idFor(f.key) } as Field);
}

function heading(key: string, text: string, level: "h3" | "h4") {
  push({ key, type: "heading", label: text, text, level, required: false });
}

/** The form's own instructions define the marks: "A check Mark in a box
 *  represents OK, An X in a box represents Not OK". So the three states are
 *  OK / Not OK / N/A -- rendered as radios, because 91 selects is 182 taps. */
const RATING = [
  { label: "OK", value: "ok" },
  { label: "Not OK", value: "not_ok" },
  { label: "N/A", value: "na" }
];

/** Every rated row. NOT required: the JotForm leaves them optional and a
 *  96-question required form is a form people abandon halfway. */
function rate(key: string, label: string) {
  push({
    key,
    type: "radio",
    label,
    layout: "inline",
    options: RATING,
    required: false,
    action_item_eligible: true
  });
}

function otherText(key: string, label = "Other - describe") {
  push({ key, type: "short_text", label, required: false, maxLength: 200 });
}

// ---------------------------------------------------------------------------
// Identity block
// ---------------------------------------------------------------------------
push({
  key: SITE_KEY,
  type: "short_text",
  label: "Site number",
  helpText: "3-digit site number (leading zeros optional).",
  required: true,
  maxLength: 10
});
const SITE_ID = idFor(SITE_KEY);

push({ key: "visit_date", type: "date", label: "Date", required: true, defaultToToday: true });

function lookup(key: string, label: string, sourceColumn: string) {
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
    nullBehavior: "allow_empty"
  });
}
lookup("site_name", "Site", "location_pretty");
// Labels follow the JotForm ("AM Email" / "RM Email") rather than the Brief 59
// org labels, because the audience of THIS form is the people who call
// themselves Area Managers. The columns are the canonical ones either way:
// am_email is the Regional Director field, rm_email the Regional Manager.
lookup("am_email", "AM email", "am_email");
lookup("rm_email", "RM email", "rm_email");

// ---------------------------------------------------------------------------
// The assessment. Section -> subsection -> rated rows, in JotForm order.
// ---------------------------------------------------------------------------
type Sub = { sub: string; prefix: string; rows: string[]; other?: boolean };
type Sec = { sec: string; subs: Sub[] };

const SECTIONS: Sec[] = [
  {
    sec: "Safety",
    subs: [
      {
        sub: "Hazards",
        prefix: "safety_haz",
        rows: ["Driving", "Electrical", "Fire", "Spills", "Covers/Guards", "Environmental", "Slip/Trip/Fall", "Ladder"]
      },
      {
        sub: "Procedural and Compliance",
        prefix: "safety_proc",
        rows: ["Drivers", "Training", "PPE", "LOTO", "Certifications", "Spill Kits", "SDS", "HAZCOM", "Labels", "Fire Extinguishers"]
      }
    ]
  },
  {
    sec: "Maintenance and Equipment",
    subs: [
      {
        sub: "Cleanliness",
        prefix: "maint_clean",
        rows: ["Grounds", "Tunnel", "Store/Lobby", "Back Room", "Uniforms", "Vacs"]
      },
      {
        sub: "Functionality",
        prefix: "maint_func",
        rows: ["Maintenance", "Repairs Building", "Repairs Equipment", "Paving", "Electrical", "Landscape", "Pits and Tanks"],
        other: true
      }
    ]
  },
  {
    sec: "CapEx and Projects",
    subs: [
      {
        sub: "Maintenance CapEx",
        prefix: "capex_maint",
        rows: ["Roof", "Building", "Facade", "Pavement", "Lights", "Equipment", "Remodel"]
      },
      {
        sub: "Growth CapEx",
        prefix: "capex_growth",
        rows: ["Mat Room", "Vacuum", "Kiosk", "Site Layout"]
      },
      {
        sub: "Projects",
        prefix: "capex_proj",
        rows: ["Cleaning", "Painting", "Repair"],
        other: true
      }
    ]
  },
  {
    sec: "Operational Procedures",
    subs: [
      {
        sub: "Processing",
        prefix: "ops_proc",
        rows: ["Entrance", "Exit", "Tunnel", "Detail", "Fivestar", "Oil Change"]
      },
      {
        sub: "Sales",
        prefix: "ops_sales",
        rows: ["CSA", "Cashier", "Fivestar", "Oil Change"],
        other: true
      },
      {
        sub: "CPM Staffing and Schedule",
        prefix: "ops_cpm",
        rows: ["Proper Staff", "Deployment", "Schedule Up", "Trend Posted"]
      },
      {
        sub: "Employee Engagement and Procedures",
        prefix: "ops_eng",
        rows: [
          "Smiles", "Welcoming", "Sales Model", "Cashier Model", "Fivestar Favors",
          "Oil Change Sales Models", "Loading Procedure", "Vac Procedure",
          "3 Towel System", "Stacking", "Detail", "Fivestar"
        ],
        other: true
      }
    ]
  },
  {
    sec: "Marketing",
    subs: [
      {
        sub: "Signage",
        prefix: "mkt_sign",
        rows: ["Appearance", "Proper Message", "Condition", "Lit", "Pricing", "Descriptions"]
      },
      {
        sub: "Visibility",
        prefix: "mkt_vis",
        rows: ["Road Signs", "Building Signs", "Windmasters", "Banners", "Menus", "Digital Signs", "Promo Signage"],
        other: true
      }
    ]
  }
];

/** Row label -> key suffix. Several labels repeat ACROSS subsections (Tunnel,
 *  Detail, Fivestar, Oil Change, Electrical, Other), which is why every key
 *  carries its subsection prefix -- otherwise the payload silently loses one of
 *  each pair. */
function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^([0-9])/, "n$1");
}

let ratedCount = 0;
for (const s of SECTIONS) {
  heading(`sec_${slug(s.sec)}`, s.sec, "h3");
  for (const sub of s.subs) {
    heading(`${sub.prefix}_head`, sub.sub, "h4");
    for (const row of sub.rows) {
      rate(`${sub.prefix}_${slug(row)}`, row);
      ratedCount++;
    }
    if (sub.other) {
      rate(`${sub.prefix}_other`, "Other");
      ratedCount++;
      otherText(`${sub.prefix}_other_desc`);
    }
  }
}

// ---------------------------------------------------------------------------
// Wrap-up
// ---------------------------------------------------------------------------
heading("sec_wrapup", "Comments and Sign-off", "h3");
push({
  key: "comments",
  type: "long_text",
  label: "Comments",
  helpText: "Explain anything marked Not OK.",
  required: false,
  maxLength: 5000,
  action_item_eligible: true
});
push({ key: "done_by", type: "short_text", label: "Done by", required: true, maxLength: 120 });

// ---------------------------------------------------------------------------
// Scores. Five sections; the JotForm's sixth box ("Overall (Average)
// **Automatically Calculated**") is dropped -- it is the mean of the five
// above it, and a box someone types the average into by hand is a box that
// disagrees with its own inputs.
// ---------------------------------------------------------------------------
const SCORE = [
  { label: "3 - Above Standard", value: "3" },
  { label: "2 - Standard", value: "2" },
  { label: "1 - Below Standard", value: "1" }
];
heading("sec_scores", "Scores", "h3");
for (const [key, label] of [
  ["score_safety", "Safety"],
  ["score_maintenance", "Maintenance and Equipment"],
  ["score_capex", "CapEx and Projects"],
  ["score_operations", "Operational Procedures"],
  ["score_marketing", "Marketing"]
] as const) {
  push({ key, type: "radio", label, options: SCORE, layout: "inline", required: true });
}

// ---------------------------------------------------------------------------
// Workflow: submit -> email the signer -> they sign off or send it back, and
// either way the submitter hears about it. The email steps exist because a
// workflow without them only changes a column; nothing tells anyone.
// ---------------------------------------------------------------------------
const SIGNER = "josh.copp@splashcarwashes.com";
const workflow: FormWorkflow = {
  default_stage: "notify_signer",
  stages: [
    {
      id: "notify_signer",
      label: "Email sign-off request",
      kind: "email",
      recipients: [{ type: "static_emails", emails: [SIGNER] }],
      subject_template: "Site assessment ready for sign-off - site {field.site_number}",
      body_template:
        "{submitter.name} has submitted an Area Manager Site Assessment for {field.site_name} (site {field.site_number}), visited {field.visit_date}.\n\n" +
        "Scores - Safety {field.score_safety}, Maintenance {field.score_maintenance}, CapEx {field.score_capex}, Operations {field.score_operations}, Marketing {field.score_marketing} (3 above standard, 2 standard, 1 below).\n\n" +
        "Comments: {field.comments}\n\n" +
        "The completed assessment is attached. Review and sign off here:\n\n{submission.url}",
      attach_pdf: true,
      transitions: [{ to: "signoff", label: "Move to Sign-off" }]
    },
    {
      id: "signoff",
      label: "Sign-off",
      kind: "approval",
      approver_source: { type: "static_emails", emails: [SIGNER] },
      transitions: [
        { to: "notify_signed_off", label: "Sign off", requires: { typed_name: true } },
        { to: "notify_returned", label: "Send back", requires: { note: true } }
      ]
    },
    {
      id: "notify_signed_off",
      label: "Email the AM - signed off",
      kind: "email",
      recipients: [{ type: "payload_field", field_key: "am_email" }],
      subject_template: "Signed off - site assessment for site {field.site_number}",
      body_template:
        "Your Area Manager Site Assessment for {field.site_name} (site {field.site_number}) has been signed off.\n\n{submission.url}",
      attach_pdf: true,
      transitions: [{ to: "signed_off", label: "Move to Signed off" }]
    },
    { id: "signed_off", label: "Signed off", kind: "outcome", tint: "success", transitions: [] },
    {
      id: "notify_returned",
      label: "Email the AM - sent back",
      kind: "email",
      recipients: [{ type: "payload_field", field_key: "am_email" }],
      subject_template: "Sent back - site assessment for site {field.site_number}",
      body_template:
        "Your Area Manager Site Assessment for {field.site_name} (site {field.site_number}) has been sent back with a note.\n\n{submission.url}",
      attach_pdf: false,
      transitions: [{ to: "returned", label: "Move to Sent back" }]
    },
    { id: "returned", label: "Sent back", kind: "outcome", tint: "warning", transitions: [] }
  ]
};

const schema: FormSchema = { fields, workflow };

// ---------------------------------------------------------------------------
// Checks the validators do NOT do, then the validators themselves.
// ---------------------------------------------------------------------------
const ids = fields.map((f) => f.id);
const keys = fields.map((f) => f.key);
const dupIds = ids.filter((x, i) => ids.indexOf(x) !== i);
const dupKeys = keys.filter((x, i) => keys.indexOf(x) !== i);
if (dupIds.length) throw new Error(`duplicate field ids: ${[...new Set(dupIds)].join(", ")}`);
if (dupKeys.length) throw new Error(`duplicate field keys: ${[...new Set(dupKeys)].join(", ")}`);
for (const k of keys) {
  if (!/^[a-z][a-z0-9_]*$/.test(k)) throw new Error(`malformed key: ${k}`);
}
// Every workflow reference must point somewhere real.
const stageIds = new Set(workflow.stages.map((s) => s.id));
if (!stageIds.has(workflow.default_stage)) throw new Error("default_stage is not a stage");
for (const s of workflow.stages) {
  for (const t of s.transitions) {
    if (!stageIds.has(t.to)) throw new Error(`transition ${s.id} -> ${t.to} has no destination`);
  }
  for (const r of s.recipients ?? []) {
    if (r.type === "payload_field" && !keys.includes(r.field_key)) {
      throw new Error(`recipient field_key ${r.field_key} is not a field`);
    }
  }
}

// BOTH validators. The RM form shipped a draft-invalid schema once because only
// the strict one was run; Save Draft then failed on a form that published fine.
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

const out = process.argv[2] ?? "am-assessment.json";
writeFileSync(out, JSON.stringify(schema));
console.log(
  `ok  fields=${fields.length} rated=${ratedCount} headings=${fields.filter((f) => f.type === "heading").length}` +
    ` radios=${fields.filter((f) => f.type === "radio").length}` +
    ` lookups=${fields.filter((f) => f.type === "lookup").length}` +
    ` eligible=${fields.filter((f) => (f as { action_item_eligible?: boolean }).action_item_eligible).length}` +
    ` stages=${workflow.stages.length}  -> ${out}`
);
