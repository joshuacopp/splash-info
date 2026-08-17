// =============================================================================
// POST /manage/api/seed/jotform-photos — task #7, the second pass over the
// 2026 JotForm submissions.
//
// Phase 1 (seed-jotform.ts) deliberately seeded `photos: []` — it had ~1,100
// claims to write and adding a per-file outbound fetch + R2 put to each row
// would have blown the subrequest budget and made a partial failure much
// harder to reason about. The files stayed behind on JotForm's CDN. This pass
// walks the same submissions, pulls each uploaded file, and lands it in R2
// with a claim_photos row pointing at it.
//
// WHY NOT SQL: same reason as the paper-claim seed. `claim_photos` requires a
// real R2 object (r2_key / filename are NOT NULL), only the worker holds the
// R2_BUCKET binding, and the bytes have to be fetched from an external host.
// None of that is expressible in D1 SQL.
//
// PHOTO TYPES — no new ClaimPhotoType is needed. The existing enum already
// covers all three upload fields on this form:
//   qid 15 `fourCorners`            → "Vehicle Overview"  (the 4-corner set)
//   qid 39 `supportingPhotographs39`→ "Damage"
//   qid 48 `registrationOr`         → "VIN"
// The last one is not a guess: seed-jotform.ts:127 already documents qid 48 as
// a VIN *photo* (which is why it can't fill claims.license_plate). Adding a
// "Photo"/"Registration" member would have meant a types change, a UI change
// in every photo-category picker, and a D1 CHECK rebuild — for categories the
// system already has.
//
// IDEMPOTENCY: `claim_photos` has no idempotency_key column, so dedup is on a
// DETERMINISTIC r2_key:
//   claims/{claim_id}/jotform/{qid}/{sanitised original filename}
// Re-running a page re-derives the same key and the row is skipped. The
// existing keys are read once per claim (one SELECT), not once per file.
//
// CLAIM RESOLUTION is two-path, mirroring the seed:
//   1. idempotency_key = `jotform:{uniqueId}`  — everything the seed inserted.
//   2. staff_notes `JOT# {digits}`             — the nine hand-migrated Copp
//      locations, whose idempotency_key is NULL.
// Path 2 is not optional. Skipping it would leave every pre-cutover Copp claim
// with no photos and no error to explain why.
//
// PROFILE BEFORE YOU TRUST: `?dry_run=1` resolves claims and parses the file
// answers but performs no fetch, no R2 write and no D1 write; it echoes the
// raw answer values verbatim so the actual stored shape can be read off the
// response rather than assumed. `?probe=1` additionally fetches the first few
// URLs to prove they are reachable and to measure content-type / size. The
// field map in seed-jotform.ts carries an explicit "DO NOT add a name here
// from memory — profile it first" warning; the same applies here, and these
// two flags are how you honour it.
// =============================================================================

import { getClaimByIdempotencyKey } from "@splash/db-d1";
import type { SupabaseEnv } from "@splash/db-supabase";
import { json, jsonError } from "@splash/http";
import type { ClaimPhotoType } from "@splash/types/claims";
import {
  DAMAGE_FORM_ID,
  fetchClaimIdsByJotNumber,
  fetchSubmissionPage,
  jotNumberOf,
  type SubmissionRow
} from "./seed-jotform.js";

/**
 * Page size ceiling. Each submission costs 1 D1 read (existing r2_keys) plus,
 * per file, 1 outbound fetch + 1 R2 put, plus one D1 batch at the end. A
 * submission with the full 4-corner set can easily carry 6-10 files, so 50
 * submissions is already ~500-1,000 subrequests against the 1,000 limit.
 * Keep this low and page; the caller loops on `has_more`.
 */
const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 10;

/** How many raw answer values a dry run echoes back for shape inspection. */
const MAX_SAMPLES = 8;

/** How many URLs `probe=1` actually fetches. Just enough to prove reachability. */
const MAX_PROBES = 3;

/**
 * Largest single file we will pull. JotForm accepts phone photos, which are
 * routinely 3-8 MB; 25 MB is well clear of that while still refusing anything
 * pathological that would blow the worker's memory.
 */
const MAX_FILE_BYTES = 25 * 1024 * 1024;

const UPLOADED_BY = "JotForm import";

/**
 * qid → claim_photos.photo_type for this form's upload fields.
 *
 * Keyed by question id rather than builder `name` because these three are
 * stable on this form and the qid is the answers-map key, so no name lookup
 * is needed. `name` is recorded alongside purely so a mismatch shows up in the
 * dry-run output.
 */
const UPLOAD_FIELDS: Record<string, { name: string; photoType: ClaimPhotoType }> = {
  "15": { name: "fourCorners", photoType: "Vehicle Overview" },
  "39": { name: "supportingPhotographs39", photoType: "Damage" },
  "48": { name: "registrationOr", photoType: "VIN" }
};

interface AnswerEntry {
  name?: string;
  text?: string;
  type?: string;
  answer?: unknown;
  prettyFormat?: unknown;
}

/* ============================================================
 * Answer parsing
 * ============================================================ */

/**
 * Pull the file URLs out of one answer entry.
 *
 * JotForm's `control_fileupload` answer is an array of URL strings in the
 * common case, but single-file fields are sometimes stored as a bare string,
 * and a few older rows carry a newline- or comma-joined string. All three are
 * accepted; anything else returns [] and the caller records it as skipped with
 * the raw value attached, rather than guessing.
 */
function fileUrlsFrom(entry: AnswerEntry | undefined): string[] {
  if (!entry) return [];
  const raw = entry.answer;
  const out: string[] = [];

  const push = (value: unknown) => {
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    if (!trimmed) return;
    if (!/^https?:\/\//i.test(trimmed)) return;
    out.push(trimmed);
  };

  if (Array.isArray(raw)) {
    for (const item of raw) push(item);
  } else if (typeof raw === "string") {
    // Split on newline/comma before falling back to the whole string, so a
    // joined multi-file answer doesn't become one unusable "URL".
    const parts = raw.split(/[\n,]+/).map((p) => p.trim()).filter(Boolean);
    if (parts.length > 1) {
      for (const part of parts) push(part);
    } else {
      push(raw);
    }
  }

  return out;
}

/**
 * Every upload-type answer on a submission, including ones we have no mapping
 * for. Unmapped fields are returned too so the dry run can surface them —
 * a new upload field silently dropping its files is exactly the failure this
 * pass exists to avoid.
 */
function uploadAnswers(
  answers: Record<string, AnswerEntry> | null
): Array<{ qid: string; entry: AnswerEntry; mapped: boolean }> {
  const out: Array<{ qid: string; entry: AnswerEntry; mapped: boolean }> = [];
  for (const [qid, entry] of Object.entries(answers ?? {})) {
    const isUpload =
      entry?.type === "control_fileupload" || Object.hasOwn(UPLOAD_FIELDS, qid);
    if (!isUpload) continue;
    out.push({ qid, entry, mapped: Object.hasOwn(UPLOAD_FIELDS, qid) });
  }
  return out;
}

/**
 * Last path segment of a JotForm upload URL, made safe for an R2 key.
 *
 * JotForm percent-encodes spaces and parentheses in the stored URL, so the
 * name is decoded first — otherwise every filename in the UI reads
 * `IMG_0042%20(1).jpg`.
 */
function filenameFromUrl(url: string): string {
  let last = url.split("?")[0]?.split("/").pop() ?? "";
  try {
    last = decodeURIComponent(last);
  } catch {
    // Malformed escape sequence — keep the encoded form rather than throwing.
  }
  const cleaned = last.replace(/[^\w.\-]+/g, "_").replace(/_{2,}/g, "_");
  return cleaned || "upload";
}

function contentTypeFor(filename: string, headerValue: string | null): string {
  if (headerValue && headerValue !== "application/octet-stream") return headerValue;
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "png") return "image/png";
  if (ext === "gif") return "image/gif";
  if (ext === "webp") return "image/webp";
  if (ext === "heic") return "image/heic";
  if (ext === "pdf") return "application/pdf";
  return "application/octet-stream";
}

/* ============================================================
 * Handler
 * ============================================================ */

interface FileOutcome {
  qid: string;
  photo_type: string;
  filename: string;
  r2_key: string;
  outcome: "uploaded" | "already_present" | "failed" | "dry_run";
  bytes?: number;
  content_type?: string;
  reason?: string;
}

interface SubmissionOutcome {
  id: string;
  unique_id: string | null;
  claim_id?: string;
  outcome: "processed" | "skipped";
  reason?: string;
  files?: FileOutcome[];
}

/**
 * POST /manage/api/seed/jotform-photos?from=&to=&limit=&offset=&dry_run=1&probe=1
 *
 * super_admin only, same bar as the claim seed — this writes to R2 and
 * claim_photos in bulk.
 *
 * Paged exactly like the claim seed: loop on `has_more`, bumping `offset` by
 * the returned `page_size`. Re-running a page is free; every file is keyed on
 * its deterministic r2_key and skipped if already present.
 */
export async function handleJotformPhotoSeed(
  request: Request,
  env: SupabaseEnv & {
    DB: D1Database;
    R2_BUCKET: R2Bucket;
    SUPABASE_SERVICE_KEY?: string;
  },
  dcRole: string | null
): Promise<Response> {
  if (dcRole !== "super_admin") {
    return jsonError(403, "seed requires super_admin");
  }
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) {
    return jsonError(500, "seed not configured (SUPABASE_SERVICE_KEY unbound)");
  }

  const url = new URL(request.url);
  const from = url.searchParams.get("from") ?? "2026-01-01";
  const to = url.searchParams.get("to") ?? "2027-01-01";
  const dryRun = url.searchParams.get("dry_run") === "1";
  const probe = url.searchParams.get("probe") === "1";
  const offset = Math.max(
    0,
    Number.parseInt(url.searchParams.get("offset") ?? "0", 10) || 0
  );
  const requested = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
  const limit = Math.min(
    MAX_LIMIT,
    Number.isFinite(requested) && requested > 0 ? requested : DEFAULT_LIMIT
  );

  let rows: SubmissionRow[];
  let jotToClaimId: Map<string, string>;
  try {
    [rows, jotToClaimId] = await Promise.all([
      fetchSubmissionPage(env, { from, to, limit, offset }),
      fetchClaimIdsByJotNumber(env.DB)
    ]);
  } catch (err) {
    console.error("[damage.seed.photos] upstream read failed:", err);
    return jsonError(500, err instanceof Error ? err.message : "upstream read failed");
  }

  const outcomes: SubmissionOutcome[] = [];
  // Dry-run only: raw answer values, so the stored shape can be read off the
  // response instead of assumed.
  const samples: Array<{
    id: string;
    qid: string;
    name?: string;
    type?: string;
    mapped: boolean;
    raw: unknown;
  }> = [];
  const probes: Array<{
    url: string;
    status: number | null;
    content_type: string | null;
    bytes: number | null;
    error?: string;
  }> = [];
  // Upload fields present in the data that UPLOAD_FIELDS doesn't cover. A
  // non-empty list here means files would be dropped on the floor.
  const unmappedFields = new Map<string, { name?: string; count: number }>();

  let processed = 0;
  let skipped = 0;
  let uploaded = 0;
  let alreadyPresent = 0;
  let failed = 0;
  let filesSeen = 0;

  for (const row of rows) {
    const answers = (row.answers ?? {}) as Record<string, AnswerEntry>;
    const uniqueId =
      typeof answers["52"]?.answer === "string"
        ? (answers["52"].answer as string).trim()
        : null;

    if (!uniqueId) {
      skipped += 1;
      outcomes.push({
        id: row.id,
        unique_id: null,
        outcome: "skipped",
        reason: "no uniqueId (qid 52) — cannot resolve a claim"
      });
      continue;
    }

    // Two-path claim resolution (see the header note).
    const existing = await getClaimByIdempotencyKey(env.DB, `jotform:${uniqueId}`);
    const claimId =
      existing?.claim_id ?? jotToClaimId.get(jotNumberOf(uniqueId)) ?? null;

    if (!claimId) {
      skipped += 1;
      outcomes.push({
        id: row.id,
        unique_id: uniqueId,
        outcome: "skipped",
        reason: "no claim in D1 for this submission — run the claim seed first"
      });
      continue;
    }

    const uploads = uploadAnswers(answers);
    const fileOutcomes: FileOutcome[] = [];

    // One read per submission for the keys already attached to this claim.
    // Per-file existence checks would multiply D1 reads by the file count for
    // no extra information.
    const existingKeys = new Set<string>();
    if (!dryRun) {
      const { results } = await env.DB.prepare(
        "SELECT r2_key FROM claim_photos WHERE claim_id = ? AND deleted_at IS NULL"
      )
        .bind(claimId)
        .all<{ r2_key: string }>();
      for (const r of results ?? []) existingKeys.add(r.r2_key);
    }

    const inserts: D1PreparedStatement[] = [];

    for (const { qid, entry, mapped } of uploads) {
      if (!mapped) {
        const seen = unmappedFields.get(qid);
        unmappedFields.set(qid, {
          name: entry.name,
          count: (seen?.count ?? 0) + 1
        });
      }
      if (samples.length < MAX_SAMPLES) {
        samples.push({
          id: row.id,
          qid,
          name: entry.name,
          type: entry.type,
          mapped,
          raw: entry.answer
        });
      }
      if (!mapped) continue;

      const field = UPLOAD_FIELDS[qid];
      if (!field) continue;
      const urls = fileUrlsFrom(entry);

      for (const fileUrl of urls) {
        filesSeen += 1;
        const filename = filenameFromUrl(fileUrl);
        const r2Key = `claims/${claimId}/jotform/${qid}/${filename}`;

        if (dryRun) {
          if (probe && probes.length < MAX_PROBES) {
            try {
              const resp = await fetch(fileUrl);
              const buf = resp.ok ? await resp.arrayBuffer() : null;
              probes.push({
                url: fileUrl,
                status: resp.status,
                content_type: resp.headers.get("content-type"),
                bytes: buf ? buf.byteLength : null
              });
            } catch (err) {
              probes.push({
                url: fileUrl,
                status: null,
                content_type: null,
                bytes: null,
                error: err instanceof Error ? err.message : "fetch failed"
              });
            }
          }
          fileOutcomes.push({
            qid,
            photo_type: field.photoType,
            filename,
            r2_key: r2Key,
            outcome: "dry_run"
          });
          continue;
        }

        if (existingKeys.has(r2Key)) {
          alreadyPresent += 1;
          fileOutcomes.push({
            qid,
            photo_type: field.photoType,
            filename,
            r2_key: r2Key,
            outcome: "already_present"
          });
          continue;
        }

        try {
          const resp = await fetch(fileUrl);
          if (!resp.ok) {
            failed += 1;
            fileOutcomes.push({
              qid,
              photo_type: field.photoType,
              filename,
              r2_key: r2Key,
              outcome: "failed",
              reason: `fetch ${resp.status}`
            });
            continue;
          }
          const bytes = await resp.arrayBuffer();
          if (bytes.byteLength === 0 || bytes.byteLength > MAX_FILE_BYTES) {
            failed += 1;
            fileOutcomes.push({
              qid,
              photo_type: field.photoType,
              filename,
              r2_key: r2Key,
              outcome: "failed",
              reason: `unusable size ${bytes.byteLength}`
            });
            continue;
          }
          const contentType = contentTypeFor(
            filename,
            resp.headers.get("content-type")
          );

          // R2 first, D1 after — an orphaned object is cheap to sweep, but a
          // claim_photos row pointing at a missing key renders as a broken
          // thumbnail in the UI with no way to tell it from a real failure.
          await env.R2_BUCKET.put(r2Key, bytes, {
            httpMetadata: { contentType }
          });

          inserts.push(
            env.DB.prepare(
              `INSERT INTO claim_photos (
                claim_id, photo_type, r2_key, filename, content_type,
                size_bytes, notes, uploaded_by
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
            ).bind(
              claimId,
              field.photoType,
              r2Key,
              filename,
              contentType,
              bytes.byteLength,
              `Imported from JotForm submission ${uniqueId}.`,
              UPLOADED_BY
            )
          );
          existingKeys.add(r2Key);
          uploaded += 1;
          fileOutcomes.push({
            qid,
            photo_type: field.photoType,
            filename,
            r2_key: r2Key,
            outcome: "uploaded",
            bytes: bytes.byteLength,
            content_type: contentType
          });
        } catch (err) {
          failed += 1;
          fileOutcomes.push({
            qid,
            photo_type: field.photoType,
            filename,
            r2_key: r2Key,
            outcome: "failed",
            reason: err instanceof Error ? err.message : "upload failed"
          });
        }
      }
    }

    if (inserts.length > 0) {
      await env.DB.batch(inserts);
    }

    processed += 1;
    outcomes.push({
      id: row.id,
      unique_id: uniqueId,
      claim_id: claimId,
      outcome: "processed",
      files: fileOutcomes
    });
  }

  return json({
    ok: true,
    form_id: DAMAGE_FORM_ID,
    dry_run: dryRun,
    from,
    to,
    offset,
    page_size: limit,
    rows_read: rows.length,
    has_more: rows.length === limit,
    processed,
    skipped,
    files_seen: filesSeen,
    uploaded,
    already_present: alreadyPresent,
    failed,
    // Non-empty means this form has an upload field UPLOAD_FIELDS doesn't
    // know about, and its files are being dropped. Map it before a real run.
    unmapped_upload_fields: Array.from(unmappedFields.entries()).map(
      ([qid, v]) => ({ qid, name: v.name, count: v.count })
    ),
    samples: dryRun ? samples : undefined,
    probes: dryRun && probe ? probes : undefined,
    outcomes
  });
}
