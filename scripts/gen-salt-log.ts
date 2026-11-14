// Generator for the "Salt Log" form (slug: salt-log).
// Replaces JotForm 243523811897060 (2,960 submissions, Nov 2025 - Mar 2026,
// 31 sites; ~900 a month at the peak of winter).
//
// WHAT IT IS FOR. Each time a site puts down ice melt it records how much and
// where. A RECORD, not a request: no approval, no emails, no workflow
// (operator, 2026-11-14, same posture as Rewash). Submissions are viewed /
// exported from /admin/forms.
//
// FIELDS ARE THE JOTFORM'S, all of them used (site, date+time, pounds, areas,
// name -- every one filled on 96%+ of rows). Changes from the JotForm:
//   * The name is the site roster search (employee field) instead of a free
//     typed name, so the same person is spelled the same way every time.
//     Typing a name still works for someone not on the roster yet.
//   * Pounds must be a whole number, 1-2,000. The JotForm took anything: 104
//     rows are blank and 13 are over 1,000 lb (one is 9,530,658), which makes
//     any total useless. 99% of real entries are 543 lb or less.
//   * Date and time are separate and default to now, but stay editable: about
//     30% of logs are entered hours or days after the salt went down.
//   * The JotForm's "Site Email" text field is gone; the site comes from the
//     site number.
//
// LINK-ONLY: filled on the site tablets without signing in. Location-scoped by
// the site_number field, so site admins see their own sites' logs.

import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { Field, FormSchema } from "@splash/forms-schema";
import { formSchemaSchema, draftFormSchemaSchema } from "@splash/forms-schema";

const SITE_KEY = "site_number"; // handlePublish finds the scope field by THIS key

function idFor(key: string): string {
  return createHash("sha1").update(`salt-log:${key}`).digest("hex").slice(0, 8);
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

// --- When ------------------------------------------------------------------
push({
  key: "applied_date",
  type: "date",
  label: "Date applied",
  helpText: "Change it if you're logging salt that went down earlier.",
  required: true,
  defaultToToday: true,
  show_in_queue: true
} as Field);
push({
  key: "applied_time",
  type: "time",
  label: "Time applied",
  required: true,
  defaultToNow: true
} as Field);

// --- What and where ----------------------------------------------------------
push({
  key: "pounds",
  type: "short_text",
  label: "Pounds of ice melt used",
  required: true,
  maxLength: 5,
  placeholder: "50",
  numeric: { integer: true, min: 1, max: 2000 },
  show_in_queue: true
} as Field);
push({
  key: "areas",
  type: "multi",
  label: "Areas ice melt applied",
  helpText: "Tick every one that applies.",
  required: true,
  minSelected: 1,
  options: [
    // The JotForm's order.
    { label: "Entrance pad", value: "entrance_pad" },
    { label: "Exit pad", value: "exit_pad" },
    { label: "Vacuums", value: "vacuums" },
    { label: "Sidewalks", value: "sidewalks" },
    { label: "Driveway", value: "driveway" },
    { label: "Full property", value: "full_property" }
  ],
  show_in_queue: true
} as Field);

// --- Who -------------------------------------------------------------------------
push({
  key: "applied_by",
  type: "employee",
  label: "Your name",
  helpText: "Start typing your name. Not listed yet (new hire)? Type your full name and use it.",
  required: true,
  keyFieldKey: SITE_KEY,
  keyColumn: "pricing_simple.site",
  allowTyped: true
} as Field);

const schema: FormSchema = { fields };

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

const out = process.argv[2] ?? "salt-log.json";
writeFileSync(out, JSON.stringify(schema));
console.log(`ok  fields=${fields.length}  -> ${out}`);
