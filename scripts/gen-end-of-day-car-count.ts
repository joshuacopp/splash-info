// Generator for the "End of Day Car Count" form (slug: end-of-day-car-count).
// Replaces JotForm 251036310236039 (273 submissions in 30 days; ~1 a day from
// each of 11 sites: Binghamton, Cortland, Elmira Heights, Newark, Seneca
// Falls, Vestal, Watertown, Williamsville, Fairport, LeRay, Johnson City).
//
// WHY THESE SITES. Ten of the eleven are missing from the automated daily car
// counts (apps/damage-worker/daily/build_car_counts.py -- sales export, DRB
// POS, camera): this form is their only record of the day's count. Feeding
// the typed number into the Car Counts page is deliberately LATER (operator,
// 2026-11-14) -- build the form, see it used, then decide.
//
// WHAT CHANGED FROM THE JOTFORM. The JotForm took only a photo per bay, so
// somebody had to read every picture. Sites now TYPE the day's cars washed
// and still attach the photo as proof (operator, 2026-11-14). Two kinds of
// counter exist: the tunnel controller screen shows "Cars Washed / Today's
// Total" directly; a mechanical counter (LeRay) is a running total, and the
// site subtracts yesterday's reading. One number for the whole site, all bays
// added together, so it can be totalled and charted (digests).
//
// Photos are shrunk in the browser to 2048px before upload (resizeImages):
// they are 2-5 MB off a phone, and the email queue drops attachments over
// 5 MB. 2048px still reads a counter clearly.
//
// DELIVERY: each submission emails Wendy Wandtke with the photos attached
// (operator, 2026-11-14). While testing (the default) it goes to TEST_TO only;
// regenerate with LIVE=1 for the real recipient.
//
// LINK-ONLY, location-scoped by site_number, like Rewash and Salt Log.

import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { ApproverSource, Field, FormSchema, FormWorkflow } from "@splash/forms-schema";
import { formSchemaSchema, draftFormSchemaSchema } from "@splash/forms-schema";

const LIVE = process.env.LIVE === "1";
const TEST_TO = process.env.TEST_TO || "josh.copp@splashcarwashes.com";
const WENDY = "wendy.wandtke@splashcarwashes.com";

const SITE_KEY = "site_number"; // handlePublish finds the scope field by THIS key

function idFor(key: string): string {
  return createHash("sha1").update(`end-of-day-car-count:${key}`).digest("hex").slice(0, 8);
}

const fields: Field[] = [];
function push(f: Omit<Field, "id"> & { id?: string }) {
  fields.push({ ...f, id: f.id ?? idFor(f.key) } as Field);
}

// --- Site and day ----------------------------------------------------------------
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
push({
  key: "count_date",
  type: "date",
  label: "Date of the count",
  helpText: "Leave as today unless this count is for an earlier day.",
  required: true,
  defaultToToday: true,
  show_in_queue: true
} as Field);

// --- The count ---------------------------------------------------------------------
push({
  key: "cars_washed",
  type: "short_text",
  label: "Cars washed today (all bays added together)",
  helpText:
    "Tunnel screen: the Cars Washed row, Today's Total column. Counter that only shows a running total: today's reading minus yesterday's.",
  required: true,
  maxLength: 5,
  placeholder: "0",
  numeric: { integer: true, min: 0, max: 5000 },
  show_in_queue: true
} as Field);
push({
  key: "bays",
  type: "radio",
  label: "Number of bays",
  required: true,
  layout: "inline",
  defaultValue: "1",
  options: [
    { label: "1", value: "1" },
    { label: "2", value: "2" }
  ]
} as Field);
const photo = (n: number) =>
  ({
    key: `bay${n}_photo`,
    type: "file",
    label: `Bay ${n} counter photo`,
    helpText: n === 1 ? "A photo of the screen or counter showing the count." : undefined,
    required: true,
    allowedMimeTypes: ["image/*"],
    maxSizeMb: 15,
    resizeImages: 2048
  }) as const;
push(photo(1) as unknown as Field);
push({ ...photo(2), visible_if: { field_key: "bays", equals: ["2"] } } as unknown as Field);

// --- Workflow: email Wendy with the photos, then done ---------------------------------
const recipients: ApproverSource[] = LIVE
  ? [{ type: "static_emails", emails: [WENDY] }]
  : [{ type: "static_emails", emails: [TEST_TO] }];

const workflow: FormWorkflow = {
  default_stage: "send",
  stages: [
    {
      id: "send",
      label: "Email Wendy",
      kind: "email",
      recipients,
      attach_files: true,
      subject_template: `${LIVE ? "" : "[TEST] "}Car count {field.site_name} {field.count_date}: {field.cars_washed} cars`,
      body_template: [
        LIVE ? "" : "TEST - when live this goes to Wendy Wandtke.",
        "{field.site_name} reported {field.cars_washed} cars washed on {field.count_date}.",
        "{payload.summary}",
        "The counter photo is attached."
      ]
        .filter(Boolean)
        .join("\n\n"),
      transitions: [{ to: "recorded", label: "Sent" }]
    },
    { id: "recorded", label: "Recorded", kind: "outcome", tint: "neutral", transitions: [] }
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

const out = process.argv[2] ?? "end-of-day-car-count.json";
writeFileSync(out, JSON.stringify(schema));
console.log(`ok  ${LIVE ? "LIVE" : "TEST -> " + TEST_TO}  fields=${fields.length} stages=${workflow.stages.length}  -> ${out}`);
