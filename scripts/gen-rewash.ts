// Generator for the "Rewash" form (slug: rewash).
// Replaces JotForm 250165655616055 (~3,000 submissions / 30 days, 50,000
// since May 2025 -- the highest-volume form we have).
//
// WHAT IT IS FOR. The site records every rewash and why, at the tablet, while
// the car is there. It is a RECORD, not a request: no approval step, no
// emails, no workflow (operator, 2026-11-14 -- at ~100 a day emails would be
// noise). Submissions are viewed / exported from /admin/forms.
//
// FIELDS ARE THE ONES ACTUALLY USED. Over the last 90 days of JotForm rows,
// each reason used only its own one or two fields; JotForm's customer name,
// phone, barcode and "photo of barcode/plate" were filled on ZERO rows and are
// gone. The JotForm "Date" (defaulted to now, never changed) is the
// submission timestamp here.
//
//   Member 2nd+ Wash          -> member account plate/barcode
//   Still Dirty               -> what's still dirty
//   Employee Wash             -> employee (roster search) + employee signature
//   Comp Wash                 -> reason + manager signature (signed on the
//                                tablet, as today -- operator, 2026-11-14)
//   Member from non-MLA site  -> home location + plate + member account
//   Wash Book Ticket          -> photo of the ticket
//   Auto Care Network         -> nothing extra
//
// ONE "REASON" QUESTION drives every conditional field, and nothing hangs off
// a conditional field (forms-public.js does not cascade visibility).
//
// LINK-ONLY: filled on the site tablets without signing in. Location-scoped by
// the site_number field, so site admins see their own sites' rewashes.
//
// ROLLOUT (operator, 2026-11-14): pilot at a few sites, then every site. The
// JotForm history stays in the JotForm viewer.

import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { Field, FormSchema } from "@splash/forms-schema";
import { formSchemaSchema, draftFormSchemaSchema } from "@splash/forms-schema";

const SITE_KEY = "site_number"; // handlePublish finds the scope field by THIS key

function idFor(key: string): string {
  return createHash("sha1").update(`rewash:${key}`).digest("hex").slice(0, 8);
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

// --- Every rewash ----------------------------------------------------------------
push({
  key: "greeter_code",
  type: "short_text",
  label: "Greeter code",
  required: true,
  maxLength: 10,
  placeholder: "0000",
  show_in_queue: true
} as Field);

const MEMBER_2ND = "member_2nd";
const STILL_DIRTY = "still_dirty";
const EMPLOYEE = "employee_wash";
const COMP = "comp_wash";
const NON_MLA = "non_mla_member";
const WASH_BOOK = "wash_book";
const ACN = "auto_care_network";
push({
  key: "reason",
  type: "radio",
  label: "Rewash reason",
  required: true,
  layout: "vertical",
  options: [
    // Most-used first (last 90 days of JotForm rows).
    { label: "Member 2nd+ wash", value: MEMBER_2ND },
    { label: "Still dirty", value: STILL_DIRTY },
    { label: "Employee wash", value: EMPLOYEE },
    { label: "Comp wash (manager signs)", value: COMP },
    { label: "Splash member from a non-MLA site (no account fix needed)", value: NON_MLA },
    { label: "Wash book ticket", value: WASH_BOOK },
    { label: "Auto Care Network redemption", value: ACN }
  ],
  show_in_queue: true
} as Field);
const when = (...v: string[]) => ({ visible_if: { field_key: "reason", equals: v } });

// --- Per reason ----------------------------------------------------------------
push({
  key: "member_account",
  type: "short_text",
  label: "Member account plate or barcode",
  required: true,
  maxLength: 40,
  ...when(MEMBER_2ND, NON_MLA)
} as Field);
push({
  key: "members_home",
  type: "short_text",
  label: "Member's home location",
  required: true,
  maxLength: 80,
  ...when(NON_MLA)
} as Field);
push({
  key: "license_plate",
  type: "short_text",
  label: "License plate",
  required: true,
  maxLength: 20,
  ...when(NON_MLA)
} as Field);
push({
  key: "whats_dirty",
  type: "long_text",
  label: "What's still dirty?",
  required: true,
  maxLength: 1000,
  rows: 2,
  ...when(STILL_DIRTY)
} as Field);
push({
  key: "employee",
  type: "employee",
  label: "Employee",
  helpText: "Start typing their name. Not listed yet (new hire)? Type their full name and use it.",
  required: true,
  keyFieldKey: SITE_KEY,
  keyColumn: "pricing_simple.site",
  allowTyped: true,
  ...when(EMPLOYEE)
} as Field);
push({
  key: "employee_signature",
  type: "signature",
  label: "Employee signature",
  required: true,
  format: "png",
  ...when(EMPLOYEE)
} as Field);
push({
  key: "comp_reason",
  type: "short_text",
  label: "Reason for comp wash",
  required: true,
  maxLength: 200,
  ...when(COMP)
} as Field);
push({
  key: "manager_signature",
  type: "signature",
  label: "Manager signature",
  helpText: "A manager approves the comp wash by signing here.",
  required: true,
  format: "png",
  ...when(COMP)
} as Field);
push({
  key: "wash_book_photo",
  type: "file",
  label: "Photo of the wash book ticket",
  required: true,
  allowedMimeTypes: ["image/*"],
  maxSizeMb: 10,
  ...when(WASH_BOOK)
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

const out = process.argv[2] ?? "rewash.json";
writeFileSync(out, JSON.stringify(schema));
console.log(`ok  fields=${fields.length}  -> ${out}`);
