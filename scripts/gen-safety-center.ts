// Generator for the Safety Center Compliance Checklist form schema.
//
// Ported from Splash_Safety_Center_Checklist.docx. Emits one JSON file the SQL
// insert reads, strict- and draft-validated first, so the validators see
// exactly what the database will.
//
// THE PAIRING IS LOAD-BEARING. Every item is a Yes/No radio immediately
// followed by a text field keyed `{thatKey}_notes`. The PDF's checklist-table
// renderer discovers rows by exactly that adjacency (see
// apps/forms-worker/src/pdf/layout-checklist.ts), so inserting a field between
// a question and its notes box silently demotes the whole section back to
// stacked label/value rows. Nothing errors; the PDF just stops looking like
// the document it was ported from.

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

function idFor(key: string): string {
  return createHash("sha1").update(`safety-center:${key}`).digest("hex").slice(0, 8);
}

const fields: Field[] = [];
function push(f: Omit<Field, "id"> & { id?: string }) {
  fields.push({ ...f, id: f.id ?? idFor(f.key) } as Field);
}

function heading(key: string, text: string, level: "h3" | "h4") {
  push({ key, type: "heading", label: text, text, level, required: false });
}

/** Yes first, No second. The order is not cosmetic: the PDF marks the FIRST
 *  option as the good one and treats the SECOND as the one needing attention,
 *  and the unflagged-No warning keys off the same convention. */
const YES_NO = [
  { label: "Yes", value: "yes" },
  { label: "No", value: "no" }
];

/**
 * One checklist row: the question, then its notes box.
 *
 * Required, because the source document's instruction is "Check Yes or No for
 * every item" -- a blank is not a valid answer to a compliance check, unlike
 * the AM assessment where an unrated line is a legitimate "did not look".
 */
function item(key: string, label: string) {
  push({
    key,
    type: "radio",
    label,
    layout: "inline",
    options: YES_NO,
    required: true,
    action_item_eligible: true
  });
  // Labelled per item rather than a bare "Notes": the label is the column
  // header in the submissions table and the CSV, and 21 columns all headed
  // "Notes" is the ambiguity that had to be unpicked on the other two forms.
  // The PDF prints its own "Notes" column header, so nothing is lost there.
  push({
    key: `${key}_notes`,
    type: "short_text",
    label: `${label} (notes)`,
    required: false,
    maxLength: 300
  });
}

// ---------------------------------------------------------------------------
// Header
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

push({
  key: "inspection_date",
  type: "date",
  label: "Inspection date",
  required: true,
  defaultToToday: true
});

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
lookup("rm_email", "RM email", "rm_email");

push({ key: "manager", type: "short_text", label: "Manager", required: true, maxLength: 120 });

// ---------------------------------------------------------------------------
// The checklist, verbatim from the document.
// ---------------------------------------------------------------------------
const SECTIONS: { sec: string; prefix: string; items: [string, string][] }[] = [
  {
    sec: "Personal Protective Equipment (PPE)",
    prefix: "ppe",
    items: [
      ["safety_glasses", "Safety Glasses"],
      ["disposable_gloves", "Disposable Gloves"],
      ["waterproof_gloves", "Waterproof Long Gloves (Ninja Operations)"],
      ["burn_sleeves", "Burn Sleeves (Oil Lube Operations)"],
      ["face_masks", "Face Masks"],
      ["hearing_protection", "Hearing Protection / Ear Plugs"],
      ["slip_resistant_boots", "Slip-Resistant Boots Available"],
      ["smocks_aprons", "Smocks / Aprons"],
      ["back_braces", "Back Braces"]
    ]
  },
  {
    sec: "Emergency and First Aid Supplies",
    prefix: "aid",
    items: [
      ["first_aid_kit", "Fully Stocked First Aid Kit"],
      ["bbp_kit", "Bloodborne Pathogen Cleanup Kit"],
      ["band_aids", "Band-Aids"],
      ["alcohol_pads", "Alcohol Prep Pads"],
      ["antibiotic_ointment", "Antibiotic Ointment (Neosporin)"]
    ]
  },
  {
    sec: "Safety Equipment",
    prefix: "equip",
    items: [
      ["wheel_chocks", "Wheel Chocks"],
      ["loto", "Lockout/Tagout (LOTO) Locks and Tags"],
      ["spill_kit", "Spill Kit Fully Stocked"]
    ]
  },
  {
    sec: "Required Safety Programs",
    prefix: "prog",
    items: [
      ["hazcom", "Hazard Communication (HazCom) Program"],
      ["spill_response", "Spill Response Program"],
      ["sds", "SDS (Safety Data Sheet) Program"],
      ["sds_binder", "Current SDS Binder Available"]
    ]
  }
];

let itemCount = 0;
for (const s of SECTIONS) {
  heading(`sec_${s.prefix}`, s.sec, "h3");
  for (const [k, label] of s.items) {
    item(`${s.prefix}_${k}`, label);
    itemCount++;
  }
}

// ---------------------------------------------------------------------------
// Certification
// ---------------------------------------------------------------------------
heading("sec_certification", "Manager Certification", "h3");
push({
  key: "manager_signature",
  type: "signature",
  label: "Manager signature",
  // The attestation rides as helpText rather than a heading: a heading of this
  // length would be pinned to the top of the viewport by the sticky-section CSS
  // and ellipsised to one line, which is worse than useless for a sentence
  // somebody is certifying.
  helpText:
    "I certify that I have inspected the Safety Center and verified the status of all required safety supplies, equipment, and programs listed above.",
  required: true,
  format: "png"
});

// ---------------------------------------------------------------------------
// Workflow. The document's own instruction: "Completed checklists should be
// submitted to your Regional Manager for review and follow-up."
//
// No outcome emails back to the manager. There is no manager email on the
// paper form and inventing a field to carry one is a worse trade than the
// manager reading the result on My Requests, which already lists it.
// ---------------------------------------------------------------------------
const workflow: FormWorkflow = {
  default_stage: "notify_rm",
  stages: [
    {
      id: "notify_rm",
      label: "Email the RM",
      kind: "email",
      recipients: [{ type: "payload_field", field_key: "rm_email" }],
      subject_template:
        "Safety Center checklist for review - {field.site_name} (site {field.site_number})",
      body_template:
        "{field.manager} completed the Safety Center Compliance Checklist for {field.site_name} (site {field.site_number}) on {field.inspection_date}.\n\n" +
        "The completed checklist is attached, including any corrective action items raised. Those items are also on the site's action items page.\n\n" +
        "Review here:\n\n{submission.url}",
      attach_pdf: true,
      transitions: [{ to: "rm_review", label: "Move to RM review" }]
    },
    {
      id: "rm_review",
      label: "RM review",
      kind: "approval",
      approver_source: { type: "payload_field", field_key: "rm_email" },
      transitions: [
        { to: "reviewed", label: "Mark reviewed", requires: { typed_name: true } },
        { to: "returned", label: "Send back", requires: { note: true } }
      ]
    },
    { id: "reviewed", label: "Reviewed", kind: "outcome", tint: "success", transitions: [] },
    { id: "returned", label: "Sent back", kind: "outcome", tint: "warning", transitions: [] }
  ]
};

const schema: FormSchema = { fields, workflow };

// ---------------------------------------------------------------------------
// Checks the validators do not do, then the validators.
// ---------------------------------------------------------------------------
const ids = fields.map((f) => f.id);
const keys = fields.map((f) => f.key);
for (const [what, list] of [["id", ids], ["key", keys]] as const) {
  const dup = [...new Set(list.filter((x, i) => list.indexOf(x) !== i))];
  if (dup.length) throw new Error(`duplicate field ${what}s: ${dup.join(", ")}`);
}
for (const k of keys) {
  if (!/^[a-z][a-z0-9_]*$/.test(k)) throw new Error(`malformed key: ${k}`);
}
const payloadLabels = fields
  .filter((f) => f.type !== "heading" && f.type !== "image")
  .map((f) => f.label);
const dupLabels = [
  ...new Set(payloadLabels.filter((l, i) => payloadLabels.indexOf(l) !== i))
];
if (dupLabels.length) throw new Error(`ambiguous labels: ${dupLabels.join(", ")}`);

// The PDF finds a checklist row by adjacency, so assert the adjacency here
// rather than discovering in a rendered PDF that a section quietly lost its
// table.
let paired = 0;
for (let i = 0; i < fields.length; i++) {
  const f = fields[i]!;
  if (f.type !== "radio") continue;
  const next = fields[i + 1];
  if (!next || next.key !== `${f.key}_notes`) {
    throw new Error(`"${f.key}" is not immediately followed by its notes field`);
  }
  paired++;
}
if (paired !== itemCount) {
  throw new Error(`paired ${paired} rows but built ${itemCount} items`);
}

const stageIds = new Set(workflow.stages.map((s) => s.id));
if (!stageIds.has(workflow.default_stage)) throw new Error("default_stage is not a stage");
for (const s of workflow.stages) {
  for (const t of s.transitions) {
    if (!stageIds.has(t.to)) throw new Error(`transition ${s.id} -> ${t.to} has no destination`);
  }
  for (const r of [...(s.recipients ?? []), ...(s.approver_source ? [s.approver_source] : [])]) {
    if (r.type === "payload_field" && !keys.includes(r.field_key)) {
      throw new Error(`workflow references missing field "${r.field_key}"`);
    }
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

const out = process.argv[2] ?? "safety-center.json";
writeFileSync(out, JSON.stringify(schema));
console.log(
  `ok  fields=${fields.length} items=${itemCount} paired=${paired}` +
    ` headings=${fields.filter((f) => f.type === "heading").length}` +
    ` stages=${workflow.stages.length}  -> ${out}`
);
