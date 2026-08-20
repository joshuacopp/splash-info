// =============================================================================
// POST /manage/api/seed/check-requests — task #13, the 2026 check-request
// backfill.
//
// WHAT THIS IS FOR: the damage form (250653826954971) captured the incident.
// Payment was requested on a SEPARATE form, 250654062100038, and that form's
// output — the filled check-request PDF, the estimate the payment was based on,
// the payee name and address, the two signatures — never made it into D1. So
// every paid 2026 claim currently shows a dollar amount with no paperwork
// behind it.
//
// WHY REBUILD RATHER THAN HUNT: JotForm does keep a rendered PDF per
// submission, but it lives behind a per-submission download endpoint, it is a
// JotForm-branded render rather than the company template, and matching one to
// a claim still requires parsing the same incident-number field this importer
// parses anyway. Since the worker already owns a check-request generator
// driven by the company AcroForm template, regenerating from the submission
// answers produces a *better* document than the original for no extra work,
// and it lands on the same R2/claim_photos path as every live check request.
//
// Josh's framing, which sets the fidelity bar: the Box incidents folder is the
// source of truth for these documents, not the dashboard. So the rebuild aims
// at "faithful and useful", not "byte-identical to what AP filed". That is why
// the payee is written as a customer throughout (pay_to_type 'customer') even
// though a handful were probably vendor cheques — the name and address on the
// face of the document are taken verbatim from the submission, which is the
// part that matters, and mislabelling the *type* on a historic row has no
// downstream effect.
//
// SOURCE IS THE JOTFORM API, NOT SUPABASE. The photo/claim seeds read
// `jotform_submissions` in Supabase, but that mirror is scoped to the damage
// form; this form is not in it. The JotForm API is authoritative and the
// JOTFORM_API_KEY secret is already bound (see seed-jotform-photos.ts for the
// auth posture — same key, same host allow-list, same manual redirect
// handling for file downloads).
//
// CLAIM RESOLUTION is the weak point and is treated as such. Field 11
// (`incidentNumber`) is free text and shows real drift: mixed case ("Dc..."
// vs "DC..."), stray whitespace, "n/a" where the submitter had no number to
// hand. Measured on the real form, about an eighth still do not join. Those
// are NOT dropped silently and NOT guessed at — they come back in `unresolved`
// with the raw string, for Josh to eyeball. Four paths, cheapest first:
//   1. the normalised digits as a literal claim_id — this covers the
//      site/year/sequence numbers used outside JotForm (e.g. 1342026010),
//      which are stored as claim_id on the seeded paper claims
//   2. idempotency_key = `jotform:DC{digits}` — anything the claim seed wrote
//   3. staff_notes `JOT# {digits}` — the hand-migrated Copp claims
//   4. payee name + amount against paid 2026 claims, unique match only —
//      the only way to place the submissions that left field 11 blank
//
// RESUBMITS: the same request was sometimes filed twice, typically to fix a
// typo in the payee name minutes later. Collapsing on
// (incidentNumber, amount) and keeping the LATER submission is what a human
// would do — the pair observed in the sample is a "Berindino" → "Berardino"
// correction three minutes apart, and the later spelling is the one that
// matches the customer's email address on the claim.
//
// IDEMPOTENCY: no idempotency column on claim_photos, so — as with the photo
// pass — dedup is on a deterministic r2_key. The attachment lands at
// `claims/{claim_id}/checkreq/{submissionId}/{filename}` and the rebuilt PDF
// at `claims/{claim_id}/Req_{claim_id}_jotform-{submissionId}.pdf`. Both are
// derived purely from the submission, so a re-run recomputes the same key and
// skips. Note this importer, like the photo one, cannot see files written by
// the live upload path under `claims/{claim_id}/{filename}` — but that is the
// point of this backfill: those claims have no check request to collide with.
//
// PROFILE BEFORE YOU TRUST: `?dry_run=1` reads the form, parses every field,
// resolves claims and reports — without a single fetch, R2 put or D1 write.
// Run it first and read `incident_shapes` and `unresolved`; the whole risk of
// this pass is in how well field 11 joins.
// =============================================================================

import { getClaimById, getClaimByIdempotencyKey } from "@splash/db-d1";
import { json, jsonError } from "@splash/http";
import type { ClaimPhotoRow, ClaimPhotoType, ClaimRow } from "@splash/types/claims";
import type { ImagesBinding } from "@splash/storage-r2";
import { storeCheckRequestPdf } from "./pdf.js";
import { fetchClaimIdsByJotNumber } from "./seed-jotform.js";

export const CHECK_REQUEST_FORM_ID = "250654062100038";

/**
 * Page size ceiling. Each submission costs up to: 1 D1 read (existing keys),
 * 1 attachment fetch, 2 signature fetches, 1 R2 template get, 2 R2 puts and a
 * D1 batch — call it ~10 subrequests against the 1,000/request limit. 25 is a
 * comfortable page; the caller loops on `has_more`.
 */
const MAX_LIMIT = 25;
const DEFAULT_LIMIT = 10;

const MAX_FILE_BYTES = 25 * 1024 * 1024;
/** Signatures are small PNGs; anything larger is not a signature. */
const MAX_SIGNATURE_BYTES = 2 * 1024 * 1024;

const UPLOADED_BY = "JotForm check-request import";

const ALLOWED_ASSET_HOSTS = new Set([
  "splashcarwashes.jotform.com",
  "www.jotform.com",
  "jotform.com"
]);

/* ============================================================
 * Field map — form 250654062100038
 *
 * Profiled from a live API read, not from memory. Do NOT add or change a qid
 * here without re-reading the form; a wrong qid fails silently as a blank
 * field on a document nobody will look at again for a year.
 * ============================================================ */
const QID = {
  date: "2", // datetime; prettyFormat "08/14/2026"
  location: "4", // textbox; mixed — site names AND site numbers
  email: "5",
  phone: "8", // { full: "(555) 555-5555" }
  explanation: "10", // textarea
  incidentNumber: "11", // free text; the join key, and it drifts
  checkMade: "15", // fullname { first, last }
  address: "16", // { addr_line1, addr_line2, city, state, postal }
  requestorSignature: "17", // signature PNG url
  approval: "18", // signature PNG url
  upload: "19", // file upload — estimates / receipts
  estimate1: "20",
  estimate2: "21",
  estimate3: "22",
  approvedEstimate: "23", // radio "Estimate 1|2|3"
  amount: "24", // authoritative cheque amount
  kind: "27" // "Check Request" vs Divvy receipt
} as const;

interface AnswerEntry {
  name?: string;
  text?: string;
  type?: string;
  answer?: unknown;
  prettyFormat?: unknown;
}

interface JotSubmission {
  id: string;
  created_at?: string;
  answers?: Record<string, AnswerEntry>;
}

/* ============================================================
 * JotForm API reads
 * ============================================================ */

/**
 * One page of submissions for the check-request form.
 *
 * `filter` is JotForm's own JSON filter param — the date bounds are applied
 * server-side so a 2026-only run does not page through 2025 to find them.
 * Ordered by id (ascending, the submission order) so paging is stable.
 */
async function fetchCheckRequestPage(
  apiKey: string,
  opts: { from: string; to: string; limit: number; offset: number }
): Promise<JotSubmission[]> {
  const url = new URL(
    `https://splashcarwashes.jotform.com/API/form/${CHECK_REQUEST_FORM_ID}/submissions`
  );
  url.searchParams.set("apikey", apiKey);
  url.searchParams.set("limit", String(opts.limit));
  url.searchParams.set("offset", String(opts.offset));
  url.searchParams.set("orderby", "id");
  url.searchParams.set(
    "filter",
    JSON.stringify({
      "created_at:gt": `${opts.from} 00:00:00`,
      "created_at:lt": `${opts.to} 00:00:00`
    })
  );

  const resp = await fetch(url.toString(), {
    headers: { APIKEY: apiKey, Accept: "application/json" },
    signal: AbortSignal.timeout(30_000)
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(
      `jotform submissions read failed (${resp.status}): ${detail.slice(0, 300)}`
    );
  }
  const body = (await resp.json()) as { content?: JotSubmission[] };
  return body.content ?? [];
}

interface AssetFetchResult {
  ok: boolean;
  contentType: string | null;
  bytes: ArrayBuffer | null;
  reason?: string;
}

/** Types that are actually a file — see seed-jotform-photos.ts for why an
 *  HTTP 200 is not evidence of success on this account. */
function isUsableAssetType(contentType: string | null): boolean {
  if (!contentType) return false;
  const ct = contentType.toLowerCase();
  return (
    ct.startsWith("image/") ||
    ct.startsWith("application/pdf") ||
    ct.startsWith("application/octet-stream")
  );
}

/**
 * Fetch one JotForm-hosted file (attachment or signature PNG).
 *
 * Auth posture is copied verbatim from the photo importer: key on BOTH the
 * header and the query string, redirects followed manually with a host check
 * at every hop so the key never leaves JotForm, and success judged by content
 * type rather than status — an unauthenticated GET here returns 200 with a
 * ~2.7 KB HTML interstitial.
 */
async function fetchJotformFile(
  fileUrl: string,
  apiKey: string
): Promise<AssetFetchResult> {
  let current: URL;
  try {
    current = new URL(fileUrl);
  } catch {
    return { ok: false, contentType: null, bytes: null, reason: "invalid url" };
  }
  if (!ALLOWED_ASSET_HOSTS.has(current.host)) {
    return {
      ok: false,
      contentType: null,
      bytes: null,
      reason: `host not allowed: ${current.host}`
    };
  }
  current.searchParams.set("apikey", apiKey);

  for (let hop = 0; hop < 4; hop++) {
    let resp: Response;
    try {
      resp = await fetch(current.toString(), {
        method: "GET",
        redirect: "manual",
        headers: { APIKEY: apiKey },
        signal: AbortSignal.timeout(20_000)
      });
    } catch (err) {
      return {
        ok: false,
        contentType: null,
        bytes: null,
        reason: err instanceof Error ? err.message : "fetch failed"
      };
    }

    if (resp.status >= 300 && resp.status < 400) {
      const location = resp.headers.get("Location");
      if (!location) {
        return { ok: false, contentType: null, bytes: null, reason: "redirect missing Location" };
      }
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        return { ok: false, contentType: null, bytes: null, reason: "redirect unparseable" };
      }
      if (!ALLOWED_ASSET_HOSTS.has(next.host)) {
        return {
          ok: false,
          contentType: null,
          bytes: null,
          reason: `redirect off-host: ${next.host}`
        };
      }
      next.searchParams.set("apikey", apiKey);
      current = next;
      continue;
    }

    const contentType = resp.headers.get("content-type");
    if (!resp.ok) {
      return { ok: false, contentType, bytes: null, reason: `http ${resp.status}` };
    }
    if (!isUsableAssetType(contentType)) {
      return {
        ok: false,
        contentType,
        bytes: null,
        reason: `non-file content-type ${contentType ?? "(none)"} — not authenticated?`
      };
    }
    return { ok: true, contentType, bytes: await resp.arrayBuffer() };
  }
  return { ok: false, contentType: null, bytes: null, reason: "redirect loop" };
}

/* ============================================================
 * Answer parsing
 * ============================================================ */

function str(entry: AnswerEntry | undefined): string {
  const raw = entry?.answer;
  return typeof raw === "string" ? raw.trim() : "";
}

/** Full name from a JotForm `control_fullname` answer, or the raw string. */
function fullName(entry: AnswerEntry | undefined): string {
  const raw = entry?.answer;
  if (typeof raw === "string") return raw.trim();
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    return [o.first, o.last]
      .map((v) => (typeof v === "string" ? v.trim() : ""))
      .filter(Boolean)
      .join(" ");
  }
  return "";
}

/** Phone answers are `{ full: "..." }` on this form; tolerate a bare string. */
function phoneOf(entry: AnswerEntry | undefined): string {
  const raw = entry?.answer;
  if (typeof raw === "string") return raw.trim();
  if (raw && typeof raw === "object") {
    const full = (raw as Record<string, unknown>).full;
    if (typeof full === "string") return full.trim();
  }
  return "";
}

/**
 * The four address lines for the cheque, from JotForm's address sub-fields.
 * Line 2 is dropped when blank rather than left as an empty middle line, so
 * the city/state/zip line does not float down the form.
 */
function addressLinesOf(entry: AnswerEntry | undefined): string[] {
  const raw = entry?.answer;
  if (!raw || typeof raw !== "object") return [];
  const o = raw as Record<string, unknown>;
  const pick = (k: string) => (typeof o[k] === "string" ? (o[k] as string).trim() : "");
  const cityStateZip = [
    [pick("city"), pick("state")].filter(Boolean).join(", "),
    pick("postal")
  ]
    .filter(Boolean)
    .join(" ");
  return [pick("addr_line1"), pick("addr_line2"), cityStateZip]
    .filter(Boolean)
    .slice(0, 4);
}

/**
 * Money out of a free-text field. The estimate boxes hold everything from
 * "$610.69" to a bare "$" to "610.69 (parts only)", so anything that does not
 * yield a positive number returns null and the caller flags it rather than
 * writing a zero-dollar cheque record.
 */
function amountOf(entry: AnswerEntry | undefined): number | null {
  const raw = str(entry);
  if (!raw) return null;
  const match = raw.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const n = Number.parseFloat(match[0]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** MM/DD/YYYY for the PDF date box, preferring JotForm's own prettyFormat. */
function dateOf(entry: AnswerEntry | undefined, createdAt: string | undefined): string {
  const pretty = entry?.prettyFormat;
  if (typeof pretty === "string" && /^\d{2}\/\d{2}\/\d{4}$/.test(pretty.trim())) {
    return pretty.trim();
  }
  const raw = entry?.answer;
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    const [m, d, y] = [o.month, o.day, o.year].map((v) =>
      typeof v === "string" || typeof v === "number" ? String(v) : ""
    );
    if (m && d && y) return `${m.padStart(2, "0")}/${d.padStart(2, "0")}/${y}`;
  }
  // Fall back to the submission timestamp — always present, and closer to the
  // truth than today's date on a document being rebuilt years later.
  if (createdAt) {
    const parsed = new Date(createdAt.replace(" ", "T"));
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toLocaleDateString("en-US", {
        timeZone: "America/New_York",
        month: "2-digit",
        day: "2-digit",
        year: "numeric"
      });
    }
  }
  return "";
}

/** URLs from a file-upload answer (array in the common case, string sometimes). */
function fileUrlsFrom(entry: AnswerEntry | undefined): string[] {
  const raw = entry?.answer;
  const out: string[] = [];
  const push = (v: unknown) => {
    if (typeof v !== "string") return;
    const t = v.trim();
    if (t && /^https?:\/\//i.test(t)) out.push(t);
  };
  if (Array.isArray(raw)) for (const item of raw) push(item);
  else if (typeof raw === "string") {
    const parts = raw.split(/[\n,]+/).map((p) => p.trim()).filter(Boolean);
    if (parts.length > 1) for (const p of parts) push(p);
    else push(raw);
  }
  return out;
}

function filenameFromUrl(url: string): string {
  let last = url.split("?")[0]?.split("/").pop() ?? "";
  try {
    last = decodeURIComponent(last);
  } catch {
    /* malformed escape — keep encoded */
  }
  return last.replace(/[^\w.\-]+/g, "_").replace(/_{2,}/g, "_") || "upload";
}

function contentTypeFor(filename: string, headerValue: string | null): string {
  if (headerValue && headerValue !== "application/octet-stream") return headerValue;
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "png") return "image/png";
  if (ext === "heic") return "image/heic";
  if (ext === "pdf") return "application/pdf";
  return "application/octet-stream";
}

/**
 * `Dc 2020 1087 ` → `20201087`. Case and whitespace drift are the two
 * failure modes actually present in the data; a leading DC prefix is stripped
 * so the digits can be tried against every id scheme in turn. A leading `#`
 * goes too — `#772024025` is a site/year/sequence number someone hash-prefixed,
 * and left in place it fails the digits test and loses an otherwise good join.
 */
function normaliseIncident(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .replace(/^#\s*/, "")
    .replace(/^DC[\s-]*/, "")
    .replace(/[\s-]+/g, "");
}

/** Divvy receipts are recorded, but no cheque was raised, so no PDF is built. */
function isReceiptSubmission(entry: AnswerEntry | undefined): boolean {
  return /receipt/i.test(str(entry)) && !/check\s*request/i.test(str(entry));
}

/* ============================================================
 * Parsed shape
 * ============================================================ */

interface ParsedRequest {
  submissionId: string;
  createdAt: string;
  incidentRaw: string;
  incidentKey: string;
  isReceipt: boolean;
  date: string;
  location: string;
  email: string;
  phone: string;
  explanation: string;
  payee: string;
  addressLines: string[];
  amount: number | null;
  amountSource: "amountOf" | "approvedEstimate" | "none";
  fileUrls: string[];
  requestorSignatureUrl: string;
  approvalSignatureUrl: string;
}

function parseSubmission(sub: JotSubmission): ParsedRequest {
  const a = sub.answers ?? {};
  const incidentRaw = str(a[QID.incidentNumber]);

  // Amount: field 24 is what AP paid and wins. When it is blank or unparseable
  // (a bare "$" happens), fall back to whichever estimate the approver ticked
  // — that is the number the cheque was cut from.
  let amount = amountOf(a[QID.amount]);
  let amountSource: ParsedRequest["amountSource"] = amount === null ? "none" : "amountOf";
  if (amount === null) {
    const choice = str(a[QID.approvedEstimate]);
    const qid =
      /3/.test(choice) ? QID.estimate3 : /2/.test(choice) ? QID.estimate2 : QID.estimate1;
    const fromEstimate = amountOf(a[qid]);
    if (fromEstimate !== null) {
      amount = fromEstimate;
      amountSource = "approvedEstimate";
    }
  }

  return {
    submissionId: sub.id,
    createdAt: sub.created_at ?? "",
    incidentRaw,
    incidentKey: normaliseIncident(incidentRaw),
    isReceipt: isReceiptSubmission(a[QID.kind]),
    date: dateOf(a[QID.date], sub.created_at),
    location: str(a[QID.location]),
    email: str(a[QID.email]),
    phone: phoneOf(a[QID.phone]),
    explanation: str(a[QID.explanation]),
    payee: fullName(a[QID.checkMade]),
    addressLines: addressLinesOf(a[QID.address]),
    amount,
    amountSource,
    fileUrls: fileUrlsFrom(a[QID.upload]),
    requestorSignatureUrl: str(a[QID.requestorSignature]),
    approvalSignatureUrl: str(a[QID.approval])
  };
}

/**
 * Drop earlier duplicates of the same (incident, amount) pair.
 *
 * The observed case is a payee-spelling correction filed three minutes after
 * the original. Keeping the later one keeps the corrected spelling. Anything
 * with a different amount is a genuinely separate payment and is kept — two
 * cheques against one incident is normal (parts, then labour).
 */
function collapseResubmits(rows: ParsedRequest[]): {
  kept: ParsedRequest[];
  superseded: Array<{ submission_id: string; superseded_by: string; incident: string }>;
} {
  const bestByPair = new Map<string, ParsedRequest>();
  const superseded: Array<{ submission_id: string; superseded_by: string; incident: string }> = [];

  for (const row of rows) {
    // Unjoinable rows have no meaningful pair key; never collapse them into
    // each other or every "n/a" submission would fold into one.
    const key = row.incidentKey
      ? `${row.incidentKey}|${row.amount ?? "null"}|${row.isReceipt ? "r" : "c"}`
      : `__unkeyed__${row.submissionId}`;
    const prior = bestByPair.get(key);
    if (!prior) {
      bestByPair.set(key, row);
      continue;
    }
    const priorIsOlder = (prior.createdAt || "") <= (row.createdAt || "");
    const loser = priorIsOlder ? prior : row;
    const winner = priorIsOlder ? row : prior;
    superseded.push({
      submission_id: loser.submissionId,
      superseded_by: winner.submissionId,
      incident: loser.incidentRaw
    });
    bestByPair.set(key, winner);
  }

  return { kept: Array.from(bestByPair.values()), superseded };
}

/* ============================================================
 * Claim resolution
 * ============================================================ */

/**
 * Four paths, cheapest first. Returns the claim_id and which path found it,
 * so the dry run can show how the join actually behaves rather than just how
 * many succeeded.
 *
 * Paths 1-3 all key off the incident number. Path 4 exists because a sixth of
 * the submissions have no incident number at all — the field was left blank or
 * filled in as "n/a" — and those are not junk rows, they are real payments.
 * The check is deliberately narrow: the payee has to be the exact customer name
 * on exactly one paid 2026 claim, and the amount has to agree to the cent.
 * Measured against the live data it recovered 8 of 13 blanks with no ambiguity.
 */
async function resolveClaimId(
  db: D1Database,
  incidentKey: string,
  jotToClaimId: Map<string, string>,
  payee?: string,
  amount?: number | null
): Promise<{ claimId: string; via: string } | null> {
  if (incidentKey && /^\d{6,12}$/.test(incidentKey)) {
    const direct = await getClaimById(db, incidentKey);
    if (direct) return { claimId: direct.claim_id, via: "claim_id" };

    const seeded = await getClaimByIdempotencyKey(db, `jotform:DC${incidentKey}`);
    if (seeded) return { claimId: seeded.claim_id, via: "idempotency_key" };

    const migrated =
      jotToClaimId.get(incidentKey) ?? jotToClaimId.get(incidentKey.replace(/^0+/, ""));
    if (migrated) return { claimId: migrated, via: "staff_notes JOT#" };
  }

  const byPayee = await resolveByPayee(db, payee, amount);
  if (byPayee) return { claimId: byPayee, via: "payee + amount" };

  return null;
}

/**
 * Last-resort join for submissions with no usable incident number.
 *
 * Requires a unique hit, so a customer with two claims in 2026 falls through
 * rather than getting the wrong one attached. The cent tolerance is there
 * because the workbook and the submission disagree by a penny in at least one
 * case (249.20 vs 249.21) — rounding somewhere upstream, not a different claim.
 */
async function resolveByPayee(
  db: D1Database,
  payee: string | undefined,
  amount: number | null | undefined
): Promise<string | null> {
  const name = (payee ?? "").trim().replace(/\s+/g, " ").toLowerCase();
  if (!name || amount === null || amount === undefined || !(amount > 0)) return null;

  const rows = await db
    .prepare(
      `SELECT claim_id, approved_amount FROM claims
        WHERE deleted_at IS NULL
          AND submitted_at >= '2026-01-01'
          AND claim_status = 'Closed — Paid'
          AND LOWER(TRIM(REPLACE(REPLACE(customer_name, '  ', ' '), '  ', ' '))) = ?1
        LIMIT 5`
    )
    .bind(name)
    .all<{ claim_id: string; approved_amount: number | null }>();

  const hits = (rows.results ?? []).filter(
    (r) => r.approved_amount !== null && Math.abs(r.approved_amount - amount) <= 0.02
  );
  return hits.length === 1 ? (hits[0]?.claim_id ?? null) : null;
}

/* ============================================================
 * Handler
 * ============================================================ */

interface RequestOutcome {
  submission_id: string;
  incident_raw: string;
  incident_key: string;
  claim_id?: string;
  resolved_via?: string;
  kind: "check_request" | "receipt";
  amount: number | null;
  amount_source: string;
  payee: string;
  outcome: "imported" | "skipped" | "failed" | "dry_run";
  attachment?: { filename: string; r2_key: string; outcome: string; reason?: string };
  pdf?: { filename: string; r2_key: string; outcome: string; reason?: string };
  reason?: string;
}

/**
 * POST /manage/api/seed/check-requests?from=&to=&limit=&offset=&dry_run=1
 *
 * super_admin only — bulk R2 + claim_photos writes, same bar as the other
 * seeds. Paged: loop on `has_more`, bumping `offset` by `page_size`.
 * Re-running a page is free (deterministic r2_keys, checked before any fetch).
 */
export async function handleCheckRequestSeed(
  request: Request,
  env: {
    DB: D1Database;
    R2_BUCKET: R2Bucket;
    IMAGES?: ImagesBinding;
    JOTFORM_API_KEY?: string;
  },
  dcRole: string | null
): Promise<Response> {
  if (dcRole !== "super_admin") {
    return jsonError(403, "seed requires super_admin");
  }
  if (!env.JOTFORM_API_KEY) {
    return jsonError(
      503,
      "JOTFORM_API_KEY unbound — this form and its files are not readable without it"
    );
  }

  const url = new URL(request.url);
  const from = url.searchParams.get("from") ?? "2026-01-01";
  const to = url.searchParams.get("to") ?? "2027-01-01";
  const dryRun = url.searchParams.get("dry_run") === "1";
  const offset = Math.max(
    0,
    Number.parseInt(url.searchParams.get("offset") ?? "0", 10) || 0
  );
  const requested = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
  const limit = Math.min(
    MAX_LIMIT,
    Number.isFinite(requested) && requested > 0 ? requested : DEFAULT_LIMIT
  );

  let subs: JotSubmission[];
  let jotToClaimId: Map<string, string>;
  try {
    [subs, jotToClaimId] = await Promise.all([
      fetchCheckRequestPage(env.JOTFORM_API_KEY, { from, to, limit, offset }),
      fetchClaimIdsByJotNumber(env.DB)
    ]);
  } catch (err) {
    console.error("[damage.seed.checkreq] upstream read failed:", err);
    return jsonError(500, err instanceof Error ? err.message : "upstream read failed");
  }

  const parsed = subs.map(parseSubmission);
  const { kept, superseded } = collapseResubmits(parsed);

  const outcomes: RequestOutcome[] = [];
  const unresolved: Array<{ submission_id: string; incident_raw: string; payee: string; amount: number | null }> = [];
  // Distinct raw shapes of field 11, with counts — the single most useful
  // thing a dry run can tell you, because the join lives or dies on it.
  const incidentShapes = new Map<string, number>();

  let imported = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of kept) {
    const shape = row.incidentRaw || "(blank)";
    incidentShapes.set(shape, (incidentShapes.get(shape) ?? 0) + 1);

    const base: RequestOutcome = {
      submission_id: row.submissionId,
      incident_raw: row.incidentRaw,
      incident_key: row.incidentKey,
      kind: row.isReceipt ? "receipt" : "check_request",
      amount: row.amount,
      amount_source: row.amountSource,
      payee: row.payee,
      outcome: "skipped"
    };

    const resolution = await resolveClaimId(
      env.DB,
      row.incidentKey,
      jotToClaimId,
      row.payee,
      row.amount
    );
    if (!resolution) {
      skipped += 1;
      unresolved.push({
        submission_id: row.submissionId,
        incident_raw: row.incidentRaw,
        payee: row.payee,
        amount: row.amount
      });
      outcomes.push({
        ...base,
        reason:
          "no claim matched — tried claim_id, jotform: idempotency key, " +
          "staff_notes JOT# and payee + amount"
      });
      continue;
    }

    base.claim_id = resolution.claimId;
    base.resolved_via = resolution.via;

    if (dryRun) {
      outcomes.push({ ...base, outcome: "dry_run" });
      continue;
    }

    const claim = await getClaimById(env.DB, resolution.claimId);
    if (!claim) {
      skipped += 1;
      outcomes.push({ ...base, reason: "claim vanished between resolve and read" });
      continue;
    }

    const existingKeys = new Set<string>();
    {
      const { results } = await env.DB.prepare(
        "SELECT r2_key FROM claim_photos WHERE claim_id = ? AND deleted_at IS NULL"
      )
        .bind(resolution.claimId)
        .all<{ r2_key: string }>();
      for (const r of results ?? []) existingKeys.add(r.r2_key);
    }

    try {
      const result = await importOne(env, claim, row, existingKeys);
      base.attachment = result.attachment;
      base.pdf = result.pdf;
      imported += 1;
      outcomes.push({ ...base, outcome: "imported" });
    } catch (err) {
      failed += 1;
      outcomes.push({
        ...base,
        outcome: "failed",
        reason: err instanceof Error ? err.message : "import failed"
      });
    }
  }

  return json({
    ok: true,
    form_id: CHECK_REQUEST_FORM_ID,
    dry_run: dryRun,
    from,
    to,
    offset,
    page_size: limit,
    rows_read: subs.length,
    has_more: subs.length === limit,
    kept: kept.length,
    imported,
    skipped,
    failed,
    // Earlier duplicates of the same (incident, amount) pair, dropped in
    // favour of the later filing. Non-empty is normal.
    superseded,
    // The whole risk surface of this pass. Read this before a real run.
    unresolved,
    incident_shapes: dryRun
      ? Array.from(incidentShapes.entries())
          .sort((a, b) => b[1] - a[1])
          .map(([value, count]) => ({ value, count }))
      : undefined,
    outcomes
  });
}

/* ============================================================
 * One submission → R2 + D1
 * ============================================================ */

async function importOne(
  env: { DB: D1Database; R2_BUCKET: R2Bucket; IMAGES?: ImagesBinding; JOTFORM_API_KEY?: string },
  claim: ClaimRow,
  row: ParsedRequest,
  existingKeys: Set<string>
): Promise<{
  attachment?: RequestOutcome["attachment"];
  pdf?: RequestOutcome["pdf"];
}> {
  const apiKey = env.JOTFORM_API_KEY as string;

  // The supporting document (estimate, or the Divvy receipt) becomes the
  // Quote/Receipt row: it carries the amount and the payee, which is what the
  // check-request generator reads. Only the first file is treated as the
  // quote of record — extra files ride along as further rows of the same type
  // so nothing is lost, but the PDF is built from the first.
  const docType: ClaimPhotoType = row.isReceipt ? "Receipt" : "Quote";
  let quoteRow: ClaimPhotoRow | null = null;
  let attachment: RequestOutcome["attachment"] | undefined;

  for (const [index, fileUrl] of row.fileUrls.entries()) {
    const filename = filenameFromUrl(fileUrl);
    const r2Key = `claims/${claim.claim_id}/checkreq/${row.submissionId}/${filename}`;

    if (existingKeys.has(r2Key)) {
      const existing = await env.DB.prepare(
        "SELECT * FROM claim_photos WHERE claim_id = ? AND r2_key = ? AND deleted_at IS NULL LIMIT 1"
      )
        .bind(claim.claim_id, r2Key)
        .first<ClaimPhotoRow>();
      if (index === 0 && existing) quoteRow = existing;
      if (index === 0) {
        attachment = { filename, r2_key: r2Key, outcome: "already_present" };
      }
      continue;
    }

    const fetched = await fetchJotformFile(fileUrl, apiKey);
    if (!fetched.ok || !fetched.bytes || fetched.bytes.byteLength === 0) {
      if (index === 0) {
        attachment = {
          filename,
          r2_key: r2Key,
          outcome: "failed",
          reason: fetched.reason ?? "fetch failed"
        };
      }
      continue;
    }
    if (fetched.bytes.byteLength > MAX_FILE_BYTES) {
      if (index === 0) {
        attachment = {
          filename,
          r2_key: r2Key,
          outcome: "failed",
          reason: `oversized ${fetched.bytes.byteLength}`
        };
      }
      continue;
    }

    const contentType = contentTypeFor(filename, fetched.contentType);
    // R2 first, D1 second — an orphaned object is cheap to sweep; a row
    // pointing at a missing key renders as a broken document in the UI.
    await env.R2_BUCKET.put(r2Key, fetched.bytes, {
      httpMetadata: { contentType }
    });

    const inserted = await env.DB.prepare(
      `INSERT INTO claim_photos (
         claim_id, photo_type, r2_key, filename, content_type, size_bytes,
         vendor, amount, notes, uploaded_by, pay_to_type, vendor_address
       ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 'customer', NULL)
       RETURNING *`
    )
      .bind(
        claim.claim_id,
        docType,
        r2Key,
        filename,
        contentType,
        fetched.bytes.byteLength,
        index === 0 ? row.amount : null,
        `Imported from JotForm check request ${row.submissionId}` +
          (row.incidentRaw ? ` (incident "${row.incidentRaw}")` : "") +
          ".",
        UPLOADED_BY
      )
      .first<ClaimPhotoRow>();

    existingKeys.add(r2Key);
    if (index === 0) {
      quoteRow = inserted;
      attachment = { filename, r2_key: r2Key, outcome: "uploaded" };
    }
  }

  // A Divvy receipt is a record of a payment already made — there was never a
  // check request behind it, so generating one would invent a document.
  if (row.isReceipt) return { attachment };

  // No attachment at all still deserves a check request: the amount, payee and
  // signatures are on the submission regardless of whether a file came with it.
  // Synthesise the minimum row the generator needs.
  const quote: ClaimPhotoRow =
    quoteRow ??
    ({
      id: 0,
      claim_id: claim.claim_id,
      photo_type: "Quote",
      filename: "",
      r2_key: "",
      content_type: null,
      size_bytes: null,
      uploaded_by: UPLOADED_BY,
      vendor: null,
      amount: row.amount,
      notes: null,
      pay_to_type: "customer",
      vendor_address: null
    } as unknown as ClaimPhotoRow);

  const pdfFilenameStem = `Req_${claim.claim_id}_jotform-${row.submissionId}`;
  const pdfKey = `claims/${claim.claim_id}/${pdfFilenameStem}.pdf`;
  if (existingKeys.has(pdfKey)) {
    return {
      attachment,
      pdf: { filename: `${pdfFilenameStem}.pdf`, r2_key: pdfKey, outcome: "already_present" }
    };
  }

  const signatures = {
    requestor: await fetchSignature(row.requestorSignatureUrl, apiKey),
    approval: await fetchSignature(row.approvalSignatureUrl, apiKey)
  };

  const stored = await storeCheckRequestPdf(
    env.DB,
    env.R2_BUCKET,
    claim,
    quote,
    // The submitter's identity is not on this form beyond the signature image,
    // so the text fallback names the import. When a signature PNG loaded, the
    // image is drawn instead and this text is never rendered.
    "JotForm check request",
    "JotForm check request",
    `JotForm import ${row.submissionId}`,
    env.IMAGES,
    null,
    {
      date: row.date,
      makeOutTo: row.payee,
      addressLines: row.addressLines,
      explanation: row.explanation,
      email: row.email,
      phone: row.phone,
      location: row.location
    },
    signatures,
    pdfFilenameStem
  );

  return {
    attachment,
    pdf: { filename: stored.filename, r2_key: stored.r2Key, outcome: "generated" }
  };
}

/** Signature PNG bytes, or null. Never throws — a missing signature is a
 *  cosmetic loss and must not fail the import. */
async function fetchSignature(
  url: string,
  apiKey: string
): Promise<Uint8Array | null> {
  if (!url) return null;
  try {
    const result = await fetchJotformFile(url, apiKey);
    if (!result.ok || !result.bytes) return null;
    if (result.bytes.byteLength === 0 || result.bytes.byteLength > MAX_SIGNATURE_BYTES) {
      return null;
    }
    return new Uint8Array(result.bytes);
  } catch {
    return null;
  }
}
