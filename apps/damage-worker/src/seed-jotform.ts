// Historic damage-claim seed from JotForm form 250653826954971
// ("Customer Experience Report").
//
// WHY THIS LIVES IN damage-worker: `claims` is D1, `jotform_submissions` is
// Supabase Postgres. There is no cross-database join, so the match has to
// happen in code — and damage-worker is the only worker bound to both.
//
// TWO-PHASE BY DESIGN (operator decision, 2026-08-17):
//   Phase 1 (this file) seeds every submission at its *initial* status, the
//     one implied by the JotForm determination field. It deliberately does
//     NOT try to reproduce the final status: the record-keeping workbooks
//     ("2026 (new) Damage Master", "Open Incidents") are the authority for
//     what actually happened, and ~1,051 of these are already closed.
//   Phase 2 is generated SQL run against D1, keyed on `idempotency_key`,
//     which applies the workbook status / lifecycle_state / cost.
// So `writeClaimBatch` hardcoding lifecycle_state='Open' is CORRECT here —
// do not fork the shared insert to work around it.
//
// IDEMPOTENCY: `idempotency_key = 'jotform:' + uniqueId` (e.g.
// `jotform:DC20260812`). Backed by the partial unique index on
// claims.idempotency_key, and pre-checked per row via
// getClaimByIdempotencyKey, so the endpoint is safe to re-run and safe to
// page through in any order.
//
// PHOTOS ARE NOT SEEDED HERE. Fields 15 / 39 / 48 are fileupload arrays;
// ~1,100 claims x 4-8 files each is far past one request's budget. That gets
// its own paged endpoint (task #7) writing via uploadClaimPhoto.

import {
  determinationToClaimStatus,
  getClaimByIdempotencyKey,
  writeClaimBatch,
  type ClaimInsert
} from "@splash/db-d1";
import type { SupabaseEnv } from "@splash/db-supabase";
import { json, jsonError } from "@splash/http";
import { generateClaimIdAt } from "@splash/storage-r2";
import type { ClaimStatus } from "@splash/types/claims";
import { loadOverlay } from "./overlay.js";

/** The only form this endpoint will seed from. */
export const DAMAGE_FORM_ID = "250653826954971";

/** Page size ceiling. Each row costs 2 D1 subrequests (dedup SELECT +
 *  writeClaimBatch), so 200 rows ~ 400 subrequests — comfortably under the
 *  1,000-subrequest limit with the two Supabase reads on top. */
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

/** How many fully built rows a dry run echoes back for inspection. */
const MAX_SAMPLES = 5;

/* ============================================================
 * JotForm field resolution
 * ============================================================ */

/**
 * JotForm answer entry as stored in `jotform_submissions.answers` (the raw
 * API entry, minus the noise types stripped by jotform-worker's
 * `stripAnswers`). Keyed by question id; `name` is the builder-authored key.
 */
interface AnswerEntry {
  name?: string;
  text?: string;
  type?: string;
  answer?: unknown;
  prettyFormat?: unknown;
}

type AnswerMap = Record<string, AnswerEntry>;

/**
 * Builder-authored field `name` for each value we consume, NOT the question
 * id. Resolving by name survives question reordering and the two form
 * revisions in this data set; qids do not.
 *
 * Every one of these was read off a `jsonb_each(answers)` inventory of all
 * 1,929 stored submissions. A hand-reconstructed field map was wrong three
 * separate times (missed `siteEmail` entirely, listed 6 of 11 damage types),
 * so DO NOT add a name here from memory — profile it first.
 *
 * Empty string = this form has no such field, which is legitimate for three
 * claims columns (see OPTIONAL_UNMAPPED). `unresolvedFields` turns any
 * *unexpected* blank into a 501 rather than a silently-null column.
 */
const FIELD = {
  /** qid 52 `control_autoincrement`, "Sequence". `DC` + 8 or 9 digits; the
   *  join key to the workbooks' JOT# column. Answered on 1,928/1,929 — the
   *  one gap is a 2025 row. */
  uniqueId: "uniqueId",
  /** qid 9 "Date and Time of Initial Visit" → claims.incident_date. */
  incidentDate: "dateAnd",
  /** qid 17 prose radio → ClaimStatus. See DETERMINATION_TO_STATUS. */
  determination: "determination",
  /** qid 20 `control_scale`, 1-5 → "Poor" | "Fair" | "Good" | "Excellent". */
  vehicleCondition: "vehicleCondition",
  /** qid 64 `control_dropdown` "Type of Incident"; 11 values + 20 nulls. */
  damageType: "typeOf",
  /** qid 82 'Description of "Other"' → claims.damage_other (638 answered). */
  damageOther: "descriptionOf",

  /** qid 45 `control_widget` — the auto-fill box the staffer types the
   *  location number into. Primary site source (1,910 answered). */
  siteNumber: "typeA",
  /** qid 51 `control_textbox` "Site Number" — the auto-fill's output, and
   *  answered on 3 MORE rows than typeA (1,913), so it's the fallback rather
   *  than redundant as an earlier pass concluded. */
  siteNumberAlt: "siteNumber",

  /** qid 5 `control_fullname` — prettyFormat is "First Last". */
  customerName: "name",
  /** qid 8 `control_phone`; digits are extracted at the call site. */
  customerPhone: "phoneNumber",
  /** qid 6 `control_email`. */
  customerEmail: "email",
  /** qid 7 `control_address` — prettyFormat is the flattened address. */
  mailingAddress: "address",

  /** qid 14 `control_number`. */
  vehicleYear: "vehicleYear",
  /** qid 12. */
  vehicleMake: "vehicleMake",
  /** qid 13. */
  vehicleModel: "vehicleModel",
  /** No such field on this form — see OPTIONAL_UNMAPPED. */
  vehicleColor: "",
  /** No such field. qid 48 `registrationOr` is a VIN *photo*, not a plate
   *  string, so it cannot fill this column — see OPTIONAL_UNMAPPED. */
  licensePlate: "",

  /** qid 10 `control_textarea` "Guest Description of Issue". */
  damageDescription: "guestDescription",
  /** No such field. The 1-5 `vehicleCondition` scale is this form's only
   *  pre-existing-condition signal — see OPTIONAL_UNMAPPED. */
  preexistingDamage: "",

  /** qid 21 `control_fullname` "Name of person completing form"
   *  → claims.submitted_by. */
  employeeName: "nameOf",

  /** qid 57 `control_radio` — "Was this approved damage caused by the car
   *  washing equipment/equipment malfunction?" This is a YES/NO answer, not
   *  the equipment name. Answered on only 358 rows. */
  equipmentRelated: "damageEquipment",
  /** qid 60 `control_textarea` "What piece of equipment? How did the
   *  equipment cause damage?" (194 answered) → claims.equipment_piece. An
   *  earlier pass wrongly mapped equipment_piece to the qid 57 radio. */
  equipmentPiece: "whatPiece",

  /** qid 16 `control_textarea` "What did we tell the customer to
   *  expect/do?" → folded into staff_notes, mirroring the live claim form's
   *  "Told customer: …" convention. */
  toldCustomer: "whatDid",
  /** qid 23 (960 answered) → staff_notes; the wash account, when the
   *  customer had one. */
  accountBarcode: "accountBarcode",
  /** qid 58 (195 answered) → staff_notes. The MaintainX WO was raised
   *  manually back then; there's no id to write to
   *  claims.maintainx_work_order_id, only this free-text title. */
  maintainxRequest: "maintainxRequest"
} as const;

/**
 * Keys whose blank is deliberate: this form has no field that can fill the
 * corresponding claims column, and inventing one is worse than a null.
 * Listing them explicitly means a *new* blank still trips the 501.
 */
const OPTIONAL_UNMAPPED = new Set<keyof typeof FIELD>([
  "vehicleColor",
  "licensePlate",
  "preexistingDamage"
]);

function unresolvedFields(): string[] {
  return (Object.keys(FIELD) as Array<keyof typeof FIELD>).filter(
    (k) => !FIELD[k] && !OPTIONAL_UNMAPPED.has(k)
  );
}

/**
 * Index an answers map by field `name`. Built once per submission; the maps
 * carry ~90 entries so a linear scan per lookup would be 20x the work.
 */
function indexByName(answers: AnswerMap): Map<string, AnswerEntry> {
  const out = new Map<string, AnswerEntry>();
  for (const key of Object.keys(answers ?? {})) {
    const entry = answers[key];
    if (!entry || typeof entry !== "object") continue;
    const name = typeof entry.name === "string" ? entry.name : "";
    if (name && !out.has(name)) out.set(name, entry);
  }
  return out;
}

/**
 * `prettyFormat` is JotForm's *email-rendering* of a composite control, so it
 * is HTML — `control_address` comes through as
 * "Street Address: 45 Raymond Terrace<br>City: Norwalk<br>...".
 *
 * Storing that raw puts markup in a DB column that the admin UI renders as
 * text, so staff would read literal "<br>" tags. Flatten to newlines and drop
 * any other tags. Applied ONLY to prettyFormat values, never to `answer` —
 * `answer` is customer free-text where "<" is a character, not a tag, and
 * stripping there could eat part of a damage description.
 */
function flattenPrettyHtml(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&amp;/gi, "&")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

/**
 * Read one answer as a trimmed string, or null. Prefers `prettyFormat` —
 * JotForm renders composite controls (name, address, datetime) there, while
 * `answer` holds an object that stringifies to "[object Object]".
 */
function str(byName: Map<string, AnswerEntry>, field: string): string | null {
  if (!field) return null;
  const entry = byName.get(field);
  if (!entry) return null;
  const candidates: Array<{ raw: unknown; pretty: boolean }> = [
    { raw: entry.prettyFormat, pretty: true },
    { raw: entry.answer, pretty: false }
  ];
  for (const { raw, pretty } of candidates) {
    if (typeof raw === "string") {
      const value = pretty ? flattenPrettyHtml(raw) : raw.trim();
      if (value) return value;
    }
    if (typeof raw === "number") return String(raw);
  }
  return null;
}

/* ============================================================
 * Value mappers
 * ============================================================ */

/**
 * Prose determination → ClaimStatus.
 *
 * The shared `determinationToClaimStatus` switches on the three
 * `ClaimDetermination` slugs and defaults everything else to
 * "New — Pending Review". These rows hold the radio's *prose*, so routing
 * them through it unchanged would flatten all 1,929 to "New". The
 * normaliser therefore belongs here, in the seed path — NOT in the shared
 * function, which the live form legitimately depends on.
 *
 * Counts are from the full 1,929-row profile. Em-dashes are U+2014; the
 * claims CHECK constraint rejects the hyphen lookalike.
 *
 * "Needs RM Review" (319) has no slug in `ClaimDetermination` at all, and
 * "Approved" / "Denied" (4 / 2) are from an old form revision. Operator
 * accepted importing all of them at their initial status because phase 2
 * closes them: "good to import as needs rm review as long as a second pass
 * updates to spreadsheet statuses".
 */
const DETERMINATION_TO_STATUS: ReadonlyArray<
  readonly [RegExp, ClaimStatus, string | null]
> = [
  // Order matters: "Requested Customer Get Quotes" is tested before the
  // bare /approved/ pattern so it doesn't get swallowed.
  [
    /^requested customer get quotes/i,
    "Approved — Pending Quotes",
    "customer_get_quotes"
  ],
  [/^no responsibility/i, "No Responsibility — Pending Review", "no_responsibility"],
  [/^needs gm review/i, "Pending GM Review", "requires_gm_review"],
  [/^needs rm review/i, "Pending RM Review", null],
  [/^denied/i, "Closed — Denied", null],
  [/^approved/i, "Approved — Pending Quotes", null]
];

/**
 * Map the prose radio to an initial status plus the slug to persist in
 * `claims.determination` (null where no slug exists — the column is
 * nullable and honesty beats inventing one).
 *
 * Unknown / blank prose → "New — Pending Review", matching what the shared
 * helper does for an unrecognised value. 17 rows have a null determination.
 */
export function normalizeDetermination(prose: string | null): {
  status: ClaimStatus;
  slug: string | null;
} {
  const value = (prose ?? "").trim();
  if (!value) {
    return { status: determinationToClaimStatus(null), slug: null };
  }
  for (const [pattern, status, slug] of DETERMINATION_TO_STATUS) {
    if (pattern.test(value)) return { status, slug };
  }
  return { status: determinationToClaimStatus(null), slug: null };
}

/**
 * JotForm's 1-5 condition scale → the four-bucket string the claims column
 * accepts. 1 and 2 both collapse to "Poor" — the scale has five points and
 * the column has four, and the operator confirmed the bottom two are the
 * pair to merge.
 */
export function normalizeVehicleCondition(raw: string | null): string | null {
  const digits = (raw ?? "").match(/[1-5]/);
  if (!digits) return null;
  switch (digits[0]) {
    case "5":
      return "Excellent";
    case "4":
      return "Good";
    case "3":
      return "Fair";
    default:
      return "Poor";
  }
}

/**
 * Read a yes/no radio answer as a boolean-ish. Only an explicit yes counts;
 * "No", blank, and anything unrecognised are all false. Written this way
 * because the qid 57 option labels weren't in the field inventory (which
 * reports names and types, not choices) — an unexpected label therefore
 * falls through to the equipment_piece fallback rather than silently
 * flagging 1,571 unanswered claims as equipment-caused.
 */
function isAffirmative(raw: string | null): boolean {
  return /^\s*(y|yes|true|1)\b/i.test(raw ?? "");
}

/** `DC` + 8 or 9 digits. The 9-digit series is legacy and straddles the year
 *  boundary (last one 2026-02-11, the same day the 8-digit series starts) —
 *  so NEVER infer the year from the id shape, only from the timestamp. */
function normalizeUniqueId(raw: string | null): string | null {
  const value = (raw ?? "").trim().toUpperCase();
  return /^DC\d{8,9}$/.test(value) ? value : null;
}

/**
 * Postgres hands timestamps back as "2026-01-02T13:38:33+00:00", but every
 * claim written by the live form uses `toISOString()` —
 * "2026-01-02T13:38:33.000Z". Two formats in one column means any lexicographic
 * ORDER BY or string equality on `submitted_at` behaves differently for seeded
 * rows than for real ones, so normalise to the `Z` form on the way in.
 */
function toIsoInstant(raw: string | null | undefined): string {
  const parsed = raw ? new Date(raw) : null;
  if (parsed && !Number.isNaN(parsed.getTime())) return parsed.toISOString();
  return new Date().toISOString();
}

/**
 * JotForm date answers arrive as "YYYY-MM-DD", "MM/DD/YYYY", or
 * "MM-DD-YYYY" depending on form revision. Returns "YYYY-MM-DD" or null;
 * never guesses a time (the column tolerates date-only for backfill rows).
 */
function normalizeIncidentDate(raw: string | null): string | null {
  const value = (raw ?? "").trim();
  if (!value) return null;
  const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    const [, y = "", m = "", d = ""] = iso;
    return `${y}-${m}-${d}`;
  }
  const us = value.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (us) {
    // Capture groups index as `string | undefined` under
    // noUncheckedIndexedAccess even though a successful match guarantees all
    // three. Destructuring with defaults satisfies the checker without adding
    // a runtime branch that can never be taken.
    const [, mm = "", dd = "", yyyy = ""] = us;
    return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
  }
  return null;
}

/* ============================================================
 * Supabase reads
 * ============================================================ */

function supabaseHeaders(env: SupabaseEnv & { SUPABASE_SERVICE_KEY?: string }) {
  const key = env.SUPABASE_SERVICE_KEY ?? "";
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    Accept: "application/json"
  };
}

export interface SubmissionRow {
  id: string;
  site_number: string | null;
  site: string | null;
  jotform_created_at: string | null;
  answers: AnswerMap | null;
}

/**
 * One page of submissions for the damage form, ordered by
 * `jotform_created_at` then `id` so paging is stable across calls.
 * `from` / `to` bound the submission timestamp — the ONLY safe way to split
 * 2026 from 2025, given the overlapping id series.
 */
export async function fetchSubmissionPage(
  env: SupabaseEnv & { SUPABASE_SERVICE_KEY?: string },
  opts: { from: string; to: string; limit: number; offset: number }
): Promise<SubmissionRow[]> {
  const url = new URL("/rest/v1/jotform_submissions", env.SUPABASE_URL);
  url.searchParams.set("select", "id,site_number,site,jotform_created_at,answers");
  url.searchParams.set("form_id", `eq.${DAMAGE_FORM_ID}`);
  url.searchParams.append("jotform_created_at", `gte.${opts.from}`);
  url.searchParams.append("jotform_created_at", `lt.${opts.to}`);
  url.searchParams.set("order", "jotform_created_at.asc,id.asc");
  url.searchParams.set("limit", String(opts.limit));
  url.searchParams.set("offset", String(opts.offset));

  const resp = await fetch(url.toString(), { headers: supabaseHeaders(env) });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(
      `jotform_submissions read failed (${resp.status}): ${detail.slice(0, 300)}`
    );
  }
  return ((await resp.json()) as SubmissionRow[]) ?? [];
}

/**
 * site_number → { location_code, location_pretty } from pricing_simple.
 *
 * Keyed on BOTH the padded and unpadded forms: pricing_simple.site holds
 * '019' while other systems carry 19, and a raw match silently misses every
 * site under 100.
 *
 * Exported for seed-paper-claims.ts, which needs the identical resolution
 * (pricing_simple + the second-profit-centre overlay, padded and unpadded).
 * Duplicating it there would be a second place for the overlay to be
 * forgotten, and a paper claim that lands on the wrong location_code is
 * invisible to the admin who owns it.
 */
export async function fetchSiteMap(
  env: SupabaseEnv & { SUPABASE_SERVICE_KEY?: string }
): Promise<Map<string, { code: string; pretty: string }>> {
  const url = new URL("/rest/v1/pricing_simple", env.SUPABASE_URL);
  url.searchParams.set("select", "site,location_code,location_pretty");

  const resp = await fetch(url.toString(), { headers: supabaseHeaders(env) });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(
      `pricing_simple read failed (${resp.status}): ${detail.slice(0, 300)}`
    );
  }
  const rows = ((await resp.json()) as Array<{
    site: string | number | null;
    location_code: string | null;
    location_pretty: string | null;
  }>) ?? [];

  const out = new Map<string, { code: string; pretty: string }>();
  const add = (site: string, value: { code: string; pretty: string }) => {
    for (const variant of [site, site.replace(/^0+/, ""), site.padStart(3, "0")]) {
      if (variant && !out.has(variant)) out.set(variant, value);
    }
  };

  for (const row of rows) {
    const code = (row.location_code ?? "").trim().toLowerCase();
    if (!code) continue;
    const site = String(row.site ?? "").trim();
    if (!site) continue;
    add(site, { code, pretty: (row.location_pretty ?? "").trim() || code });
  }

  // Second profit centres — lubes, in-bay automatics, self-serve banks. They
  // cannot have a pricing_simple row (that table is the customer-facing
  // membership catalogue, so a row there becomes a buyable plan on the signup
  // page), but they file damage claims under their own site number: Bridgeport
  // Lube is site 23 while the Bridgeport tunnel is 22.
  //
  // Added AFTER pricing_simple and via the same `add`, which never overwrites,
  // so a real wash always wins a site-number collision.
  //
  // Inactive rows are included deliberately: a sold site's historic claims
  // still have to resolve, or backfilling them silently drops the location.
  for (const row of await loadOverlay(env)) {
    const code = (row.code ?? "").trim().toLowerCase();
    const site = row.site_number == null ? "" : String(row.site_number).trim();
    if (!code || !site) continue;
    add(site, { code, pretty: (row.name ?? "").trim() || code });
  }

  return out;
}

/* ============================================================
 * Legacy-backfill collision guard
 * ============================================================ */

/**
 * The nine Copp-region locations were migrated into D1 by hand *before* this
 * seed existed, from each site's own spreadsheet — which covers the whole year,
 * including the claims those sites filed through JotForm before they moved to
 * the damage worker. Those rows carry `idempotency_key = NULL`, so the
 * `jotform:` dedup cannot see them and every pre-cutover Copp submission would
 * be inserted a second time.
 *
 * What saves us is that the manual backfill wrote the JotForm id into
 * staff_notes in a fixed shape:
 *
 *   Legacy backfill — JOT# 202600026 · Paperwork: https://...box.com/file/...
 *
 * JOT# is the JotForm `uniqueId` minus its `DC` prefix, so it maps 1:1 back to
 * a submission. Read them once per request (not per row — this is one query
 * for the whole page) and skip any submission already represented.
 *
 * Deliberately unscoped by location or date: any future hand-migrated site
 * using the same note format is protected for free, and the 2025 pass gets it
 * without a change.
 */
async function fetchMigratedJotNumbers(db: D1Database): Promise<Set<string>> {
  const out = new Set<string>();
  const { results } = await db
    .prepare("SELECT staff_notes FROM claims WHERE staff_notes LIKE '%JOT#%'")
    .all<{ staff_notes: string | null }>();
  for (const row of results ?? []) {
    for (const match of (row.staff_notes ?? "").matchAll(/JOT#\s*(\d{6,12})/g)) {
      const digits = match[1];
      if (!digits) continue;
      out.add(digits);
      // Guard against a transcriber padding or trimming a leading zero.
      out.add(digits.replace(/^0+/, ""));
    }
  }
  return out;
}

/** `DC202600026` → `202600026`, the shape the workbooks and staff_notes use. */
export function jotNumberOf(uniqueId: string): string {
  return uniqueId.replace(/^DC/i, "");
}

/**
 * JOT# → claim_id for the hand-migrated claims, i.e. the same rows
 * `fetchMigratedJotNumbers` finds, but carrying the claim_id.
 *
 * The seed only ever needed "does this exist" (a Set). The photo pass needs
 * "which claim does this submission's files belong to", and for the nine
 * hand-migrated Copp locations the `jotform:` idempotency key is NULL — the
 * staff_notes JOT# is the only link back to the submission. Without this,
 * every pre-cutover Copp claim would silently get zero photos: the 2026 run
 * proved it out, attaching photo sets to 134 claims that had none.
 *
 * Any new caller: those claims are reachable by this join but NOT covered by
 * the photo importer's r2_key dedup, which only recognises keys it wrote
 * itself. Check for pre-existing rows before you attach anything in bulk.
 */
export async function fetchClaimIdsByJotNumber(
  db: D1Database
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const { results } = await db
    .prepare(
      "SELECT claim_id, staff_notes FROM claims WHERE staff_notes LIKE '%JOT#%' AND deleted_at IS NULL"
    )
    .all<{ claim_id: string; staff_notes: string | null }>();
  for (const row of results ?? []) {
    for (const match of (row.staff_notes ?? "").matchAll(/JOT#\s*(\d{6,12})/g)) {
      const digits = match[1];
      if (!digits) continue;
      // First writer wins: if two claims somehow cite the same JOT#, attaching
      // the files to one of them beats duplicating onto both.
      if (!out.has(digits)) out.set(digits, row.claim_id);
      const trimmed = digits.replace(/^0+/, "");
      if (!out.has(trimmed)) out.set(trimmed, row.claim_id);
    }
  }
  return out;
}

/* ============================================================
 * Handler
 * ============================================================ */

type RowOutcome =
  | { id: string; unique_id: string; outcome: "inserted"; claim_id: string }
  | { id: string; unique_id: string; outcome: "already_seeded"; claim_id: string }
  | { id: string; unique_id: string; outcome: "already_migrated" }
  | { id: string; unique_id: string | null; outcome: "skipped"; reason: string };

/**
 * POST /manage/api/seed/jotform?from=&to=&limit=&offset=&dry_run=1
 *
 * super_admin only — this writes claims rows in bulk, which is a strictly
 * higher bar than checkToolAccess("claims") at the gate.
 *
 * Paged like the jotform-worker backfill: the caller loops on `has_more`,
 * bumping `offset` by the returned `page_size`. Offset paging (not
 * cursor-by-id) because the ordering key is the timestamp, and re-running a
 * page is free — every row is idempotency-checked.
 */
export async function handleJotformSeed(
  request: Request,
  env: SupabaseEnv & { DB: D1Database; SUPABASE_SERVICE_KEY?: string },
  dcRole: string | null
): Promise<Response> {
  if (dcRole !== "super_admin") {
    return jsonError(403, "seed requires super_admin");
  }
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) {
    return jsonError(500, "seed not configured (SUPABASE_SERVICE_KEY unbound)");
  }

  const missing = unresolvedFields();
  if (missing.length > 0) {
    // Deliberate 501 rather than seeding 1,100 claims with null customer
    // names. Fill FIELD from the answers inventory, then redeploy.
    return jsonError(
      501,
      `seed field map incomplete — unmapped: ${missing.join(", ")}`
    );
  }

  const url = new URL(request.url);
  const from = url.searchParams.get("from") ?? "2026-01-01";
  const to = url.searchParams.get("to") ?? "2027-01-01";
  const dryRun = url.searchParams.get("dry_run") === "1";
  const offset = Math.max(0, Number.parseInt(url.searchParams.get("offset") ?? "0", 10) || 0);
  const requested = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
  const limit = Math.min(
    MAX_LIMIT,
    Number.isFinite(requested) && requested > 0 ? requested : DEFAULT_LIMIT
  );

  let rows: SubmissionRow[];
  let siteMap: Map<string, { code: string; pretty: string }>;
  let migratedJotNumbers: Set<string>;
  try {
    [rows, siteMap, migratedJotNumbers] = await Promise.all([
      fetchSubmissionPage(env, { from, to, limit, offset }),
      fetchSiteMap(env),
      fetchMigratedJotNumbers(env.DB)
    ]);
  } catch (err) {
    console.error("[damage.seed] upstream read failed:", err);
    return jsonError(500, err instanceof Error ? err.message : "upstream read failed");
  }

  const outcomes: RowOutcome[] = [];
  // Dry-run only: the fully built rows, so the operator can eyeball the field
  // mapping before writing ~1,100 claims. Capped because a 200-row page of
  // full ClaimInsert objects is unreadable in a console.
  const samples: ClaimInsert[] = [];
  let inserted = 0;
  let alreadySeeded = 0;
  let alreadyMigrated = 0;
  let skipped = 0;

  for (const row of rows) {
    const answers = (row.answers ?? {}) as AnswerMap;
    const byName = indexByName(answers);
    const uniqueId = normalizeUniqueId(str(byName, FIELD.uniqueId));

    if (!uniqueId) {
      skipped += 1;
      outcomes.push({
        id: row.id,
        unique_id: null,
        outcome: "skipped",
        reason: "no usable uniqueId"
      });
      continue;
    }

    // Checked before the idempotency lookup: a hand-migrated claim has a NULL
    // idempotency_key, so the lookup below would miss it and we would insert a
    // duplicate of a claim that is already live.
    if (migratedJotNumbers.has(jotNumberOf(uniqueId))) {
      alreadyMigrated += 1;
      outcomes.push({
        id: row.id,
        unique_id: uniqueId,
        outcome: "already_migrated"
      });
      continue;
    }

    const idempotencyKey = `jotform:${uniqueId}`;
    const existing = await getClaimByIdempotencyKey(env.DB, idempotencyKey);
    if (existing) {
      alreadySeeded += 1;
      outcomes.push({
        id: row.id,
        unique_id: uniqueId,
        outcome: "already_seeded",
        claim_id: existing.claim_id
      });
      continue;
    }

    // Site resolution is a HARD requirement, not a fallback. A claim with a
    // guessed location_code leaks into the wrong location admin's queue,
    // which is worse than an unseeded row the reconciliation will flag.
    const siteNumber =
      str(byName, FIELD.siteNumber) ??
      str(byName, FIELD.siteNumberAlt) ??
      row.site_number ??
      "";
    const location = siteMap.get(siteNumber.trim());
    if (!location) {
      skipped += 1;
      outcomes.push({
        id: row.id,
        unique_id: uniqueId,
        outcome: "skipped",
        reason: `unknown site_number ${JSON.stringify(siteNumber)}`
      });
      continue;
    }

    const customerName = str(byName, FIELD.customerName);
    if (!customerName) {
      skipped += 1;
      outcomes.push({
        id: row.id,
        unique_id: uniqueId,
        outcome: "skipped",
        reason: "no customer name"
      });
      continue;
    }

    const submittedAt = toIsoInstant(row.jotform_created_at);
    const { status, slug } = normalizeDetermination(str(byName, FIELD.determination));
    const yearRaw = str(byName, FIELD.vehicleYear);
    const yearDigits = yearRaw?.match(/\d{4}/)?.[0];
    const equipmentPiece = str(byName, FIELD.equipmentPiece);

    // Fold the three free-text fields that have no column of their own into
    // staff_notes, plus a provenance line so a reader can trace any seeded
    // claim back to its JotForm submission. "Told customer:" matches the
    // prefix the live claim form writes, so the manage page reads the same
    // whether a claim was seeded or submitted.
    const noteParts = [`Seeded from JotForm submission ${row.id} (${uniqueId}).`];
    const told = str(byName, FIELD.toldCustomer);
    if (told) noteParts.push(`Told customer: ${told}`);
    const barcode = str(byName, FIELD.accountBarcode);
    if (barcode) noteParts.push(`Account barcode: ${barcode}`);
    const mxTitle = str(byName, FIELD.maintainxRequest);
    if (mxTitle) noteParts.push(`MaintainX request title: ${mxTitle}`);

    const insert: ClaimInsert = {
      // Encode the submission timestamp, not the run date — see
      // generateClaimIdAt.
      claim_id: generateClaimIdAt(location.code, new Date(submittedAt)),
      location_code: location.code,
      location_pretty: location.pretty,
      customer_name: customerName,
      customer_phone: str(byName, FIELD.customerPhone)?.replace(/\D/g, "") || null,
      customer_email: str(byName, FIELD.customerEmail),
      customer_mailing_address: str(byName, FIELD.mailingAddress),
      vehicle_year: yearDigits ? Number.parseInt(yearDigits, 10) : null,
      vehicle_make: str(byName, FIELD.vehicleMake),
      vehicle_model: str(byName, FIELD.vehicleModel),
      vehicle_color: str(byName, FIELD.vehicleColor),
      license_plate: str(byName, FIELD.licensePlate),
      damage_description: str(byName, FIELD.damageDescription),
      preexisting_damage: str(byName, FIELD.preexistingDamage),
      vehicle_condition: normalizeVehicleCondition(str(byName, FIELD.vehicleCondition)),
      staff_notes: noteParts.join("\n\n"),
      determination: slug,
      submitted_by: str(byName, FIELD.employeeName) ?? "JotForm import",
      // `equipment_related` is 0|1 and not nullable, and the qid 57 radio was
      // answered on only 358 of 1,929 rows — unanswered has to read as 0, so
      // equipment reporting on seeded claims undercounts. That is known and
      // accepted. Read the radio's text rather than its mere presence (it's a
      // yes/no question); fall back to "did they describe a piece of
      // equipment", which is a stronger signal than a blank radio.
      equipment_related: isAffirmative(str(byName, FIELD.equipmentRelated))
        ? 1
        : equipmentPiece
          ? 1
          : 0,
      equipment_piece: equipmentPiece,
      damage_type: str(byName, FIELD.damageType),
      damage_other: str(byName, FIELD.damageOther),
      initial_status: status,
      submitted_at: submittedAt,
      incident_date: normalizeIncidentDate(str(byName, FIELD.incidentDate)),
      idempotency_key: idempotencyKey,
      // Phase 1 seeds no photos — see the header note on task #7.
      photos: []
    };

    // NOTE: `fault_category` is intentionally absent. JotForm field 79
    // (`failureBy`) is null on all 1,929 rows — it was never once filled —
    // so fault cannot be derived here. It arrives with the fault column in
    // the location migration spreadsheets.

    if (dryRun) {
      if (samples.length < MAX_SAMPLES) samples.push(insert);
      outcomes.push({
        id: row.id,
        unique_id: uniqueId,
        outcome: "inserted",
        claim_id: `${insert.claim_id} (dry run)`
      });
      inserted += 1;
      continue;
    }

    try {
      await writeClaimBatch(env.DB, insert);
      inserted += 1;
      outcomes.push({
        id: row.id,
        unique_id: uniqueId,
        outcome: "inserted",
        claim_id: insert.claim_id
      });
    } catch (err) {
      console.error(`[damage.seed] write failed for ${uniqueId}:`, err);
      skipped += 1;
      outcomes.push({
        id: row.id,
        unique_id: uniqueId,
        outcome: "skipped",
        reason: `d1 write failed: ${err instanceof Error ? err.message : "unknown"}`
      });
    }
  }

  return json({
    ok: true,
    dry_run: dryRun,
    form_id: DAMAGE_FORM_ID,
    from,
    to,
    offset,
    page_size: limit,
    fetched: rows.length,
    has_more: rows.length === limit,
    next_offset: offset + rows.length,
    inserted,
    already_seeded: alreadySeeded,
    // Present in D1 already via the hand-run legacy backfill (matched on the
    // JOT# in staff_notes, not on idempotency_key, which is NULL on those).
    already_migrated: alreadyMigrated,
    migrated_jot_numbers_known: migratedJotNumbers.size,
    skipped,
    // Only the non-clean rows are enumerated — a 200-row page of "inserted"
    // outcomes is noise the operator has to scroll past to find the one that
    // failed.
    problems: outcomes.filter((o) => o.outcome === "skipped"),
    ...(dryRun ? { samples } : {})
  });
}
