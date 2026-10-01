// Generator for the "New site onboarding" form (slug: site-onboarding).
//
// WHAT IT IS FOR. When a site opens, somebody has to create its rows in
// `locations` and `pricing_simple`. The facts needed for that live with the RM
// or RD, and today they arrive by whatever route anyone happens to use. This is
// a link-only form that collects them in one place, routed to one approver who
// then makes the entries by hand.
//
// IT DOES NOT WRITE TO EITHER TABLE, deliberately. A submission is a request,
// not a migration: `location_code` is a load-bearing customer URL (CLAUDE.md
// constraint #1) and the package slugs are inconsistent enough across the
// estate that choosing one is a judgement. The approver uses sysadmin's Add
// Location, which already inserts `locations` first and rolls back cleanly.
//
// THE DIRECTION OF SYNC IS locations -> pricing_simple, NOT the reverse.
// `trg_sync_pricing_simple` fires AFTER UPDATE ON locations and pushes the
// denormalised columns (am_email, rm_email, site_email, area_manager,
// regional_manager, address, site) down into pricing_simple. Nothing propagates
// upward, so creating pricing_simple rows alone leaves `locations` without the
// site and the trigger with nothing to fire on.
//
// WHY EMAILS ARE ASKED FOR AND NAMES ALONE ARE NOT ENOUGH. `rm_email` and
// `am_email` are what `trg_sync_user_permissions` turns into access: the whole
// email-on-locations model keys off them. A site created with names but no
// addresses is a site whose RM cannot see it.

import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { Field, FormSchema, FormWorkflow } from "@splash/forms-schema";
import {
  formSchemaSchema,
  draftFormSchemaSchema
} from "@splash/forms-schema";

const fields: Field[] = [];
const push = (f: Field) => fields.push(f);

/** Hashed rather than truncated: truncation collided on an earlier form. */
function idFor(key: string): string {
  return createHash("sha1").update(`site-onboarding:${key}`).digest("hex").slice(0, 8);
}

function heading(key: string, text: string) {
  push({ key, id: idFor(key), type: "heading", label: text, text, level: "h3", required: false });
}

function text(key: string, label: string, opts: { required?: boolean; max?: number; help?: string } = {}) {
  push({
    key,
    id: idFor(key),
    type: "short_text",
    label,
    required: opts.required ?? true,
    maxLength: opts.max ?? 200,
    ...(opts.help ? { helpText: opts.help } : {})
  } as Field);
}

function email(key: string, label: string, help?: string) {
  push({
    key,
    id: idFor(key),
    type: "email",
    label,
    required: true,
    ...(help ? { helpText: help } : {})
  } as Field);
}

function longText(key: string, label: string, opts: { required?: boolean; max?: number; help?: string } = {}) {
  push({
    key,
    id: idFor(key),
    type: "long_text",
    label,
    required: opts.required ?? true,
    maxLength: opts.max ?? 2000,
    ...(opts.help ? { helpText: opts.help } : {})
  } as Field);
}

// ---------------------------------------------------------------------------
heading("sec_site", "The site");

text("location_name", "Location name", {
  help: "How the site is referred to in conversation, e.g. Binghamton. Not the web address."
});

// The CHECK on pricing_simple is `site::text ~ '^\d{3}$'`, and a value that
// cannot satisfy it is worth catching on the form rather than three steps later
// when the insert is attempted.
text("site_number", "Site number", {
  max: 3,
  help: "Three digits, zero-padded. 069, not 69."
});

longText("street_address", "Street address", {
  max: 300,
  help: "Full postal address, as it should appear on paperwork."
});

email("site_email", "Site email", "The address the site itself reads. Customer replies and site copies go here.");

// ---------------------------------------------------------------------------
heading("sec_people", "Who runs it");

text("rm_name", "Regional Manager name");
// Asked for because a name is not access. trg_sync_user_permissions keys off
// the ADDRESS, so a site created without one is a site its RM cannot open.
email("rm_email", "Regional Manager email", "This is what grants them access to the site. A name alone does not.");
text("am_name", "Regional Director / Area Manager name");
email("am_email", "Regional Director / Area Manager email", "Same again: the address is what grants access.");

// ---------------------------------------------------------------------------
heading("sec_packages", "Packages");

// The package families are the single biggest determinant of what the slugs
// will be -- ext_* at an exterior site, fs_* at a full-service one -- and the
// RM knows which this is without being asked to know the slugs.
push({
  key: "site_type",
  id: idFor("site_type"),
  type: "radio",
  label: "Site type",
  required: true,
  layout: "inline",
  options: [
    { label: "Exterior only", value: "exterior" },
    { label: "Full service", value: "full_service" },
    { label: "Both", value: "both" }
  ]
} as Field);

// FREE TEXT, ON PURPOSE. There are 38 distinct package slugs live across the
// estate -- ext_*, fs_*, college_*, suny_*, plus casing variants like "Express"
// beside "express" -- so a fixed set of fields would be wrong for most sites and
// a dropdown would be a list nobody can keep current. The approver reads this
// and chooses the slugs, which is a judgement rather than a transcription.
longText("packages", "Unlimited packages offered", {
  max: 2000,
  help:
    "One package per line, in the form:  name | single wash price | monthly unlimited price. " +
    "Example:  Bubble Bath | 25.00 | 49.00. Only packages that offer an unlimited plan."
});

longText("notes", "Anything else we should know", {
  required: false,
  max: 2000,
  help: "Opening date, pricing that differs from the rest of the region, anything unusual."
});

// ---------------------------------------------------------------------------
// One approver, who then makes the entries by hand.
// ---------------------------------------------------------------------------
const workflow: FormWorkflow = {
  default_stage: "review",
  stages: [
    {
      id: "review",
      label: "Pricing setup",
      kind: "approval",
      approver_source: {
        type: "static_emails",
        emails: ["josh.copp@splashcarwashes.com"]
      },
      transitions: [
        { to: "entered", label: "Entered in pricing", requires: { typed_name: true } },
        { to: "needs_info", label: "Need more detail", requires: { note: true } }
      ]
    },
    { id: "entered", label: "Entered in pricing", kind: "outcome", tint: "success", transitions: [] },
    {
      id: "needs_info",
      label: "Need more detail",
      kind: "outcome",
      tint: "warning",
      transitions: []
    }
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
for (const k of keys) {
  if (!/^[a-z][a-z0-9_]*$/.test(k)) throw new Error(`malformed key: ${k}`);
}
const stageIds = new Set(workflow.stages.map((s) => s.id));
if (!stageIds.has(workflow.default_stage)) throw new Error("default_stage is not a stage");
for (const s of workflow.stages) {
  for (const t of s.transitions) {
    if (!stageIds.has(t.to)) throw new Error(`transition ${s.id} -> ${t.to} has no destination`);
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

const out = process.argv[2] ?? "site-onboarding.json";
writeFileSync(out, JSON.stringify(schema));
console.log(
  `ok  fields=${fields.length}` +
    ` headings=${fields.filter((f) => f.type === "heading").length}` +
    ` stages=${workflow.stages.length}  -> ${out}`
);
