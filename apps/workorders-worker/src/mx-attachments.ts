// Copy MaintainX attachment bytes into R2.
//
// WHY A COPY, AND WHY IT HAS TO HAPPEN AT FETCH TIME
//
//   MaintainX returns attachments as presigned S3 URLs carrying
//   X-Amz-Expires=3600. There is no GET-attachment-by-id route and no key to
//   re-sign with -- the signature is AWS-side. So a stored URL is dead an hour
//   after the response that produced it, and "fetch the image when the
//   operator opens the row" cannot work: by then the link has almost always
//   expired.
//
//   The bytes therefore have to be taken while the link is live. This pass
//   does the fetch and the download TOGETHER for that reason: it single-GETs a
//   work order and immediately downloads what that response points at, so the
//   URLs it uses are seconds old and the expiry never comes into play. An
//   earlier design captured metadata in one pass and downloaded in another,
//   which reintroduced the expiry as a problem it then had to re-fetch to
//   solve. Doing both at once removes the problem instead of handling it.
//
// WHY A SINGLE-GET PER WORK ORDER
//
//   PROBED 2026-09-14: `expand=attachments` on the LIST endpoint is a 400 and
//   the error names the valid set -- attachments are not in it. The only way
//   to see the full set is `GET /workorders/{id}`, which returns them with no
//   expand token at all. `expand=thumbnail` DOES work on the list, and that
//   half is already captured for free by the ingest walk (see INGEST_EXPAND);
//   this pass exists for everything beyond the primary photo.
//
// SCOPE
//
//   Operator-chosen: active NON-PREVENTIVE work orders. 364 of them, versus
//   3,722 preventives -- and reactive work is where someone photographs a
//   broken thing, whereas preventives are routine checklists. The narrow scope
//   is what makes a per-work-order call affordable at all.

import {
  fetchMaintainXWorkOrder,
  fetchMaintainXWorkRequest,
  SINGLE_WORK_ORDER_EXPAND,
  SINGLE_WORK_REQUEST_EXPAND
} from "@splash/maintainx";
import {
  fetchMxLocationMap,
  getMxSyncState,
  recordMxAttachmentMirror,
  upsertMxWorkOrderAttachments,
  writeMxSyncState,
  type SupabaseEnv
} from "@splash/db-supabase";
import { mapWorkOrder, mapWorkRequestAttachments } from "./mx-map.js";

/** Bookkeeping key in mx_sync_state. */
export const MX_PASS_ATTACHMENTS = "work_order_attachments";

export interface MxAttachmentEnv extends SupabaseEnv {
  MAINTAINX_API_KEY?: string;
  MAINTAINX_BASE_URL: string;
  /** Optional so an unbound bucket degrades to "do nothing" rather than
   *  throwing on every tick. The pass reports it and skips. */
  WORKORDER_FILES?: R2Bucket;
}

/**
 * Wall-clock budget. Shares the 5-minute tick with the webhook drain and the
 * ingest, and it is the LAST of the three for a reason: images are the least
 * urgent thing on that tick, and a slow download must not delay the sweep that
 * keeps the work orders themselves current.
 */
const BUDGET_MS = 25_000;

/** Work orders inspected per pass. Each costs one MaintainX call plus one
 *  download per un-mirrored attachment, so this is the real throttle. At 12 a
 *  tick the 364-work-order backfill finishes in about 2.5 hours. */
const WORK_ORDERS_PER_PASS = 12;

/** Refuse anything larger. Attachments are phone photos (~200 KB-2 MB
 *  measured); something at 25 MB is a video or a mistake, and either way it is
 *  not what an expanded row should be loading. */
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** Give up on an attachment after this many failed copies. Without a ceiling a
 *  permanently-broken one is retried every five minutes forever. */
const MAX_MIRROR_ATTEMPTS = 4;

/**
 * Work-request statuses whose photos are mirrored.
 *
 * PENDING only, operator-chosen. There are 15 of them against 1,443 REJECTED,
 * and a rejected request is work that will not happen -- its photos are not
 * what anyone opens the page to see. Widening is a one-line edit here, but it
 * is 1,443 API calls and roughly 3 GB at the ~2 MB/photo measured on the
 * work-order side, so it should be a deliberate decision rather than a drift.
 *
 * A request that becomes a WORK ORDER carries its photos onto that work order
 * (verified on 118834534), so promoted requests are already covered by the
 * work-order sweep and are not double-mirrored here.
 */
const REQUEST_STATUSES_TO_MIRROR = ["PENDING"] as const;

/** Requests inspected per pass. Smaller than the work-order budget because
 *  they ride the same tick AFTER it -- the 15 pending requests clear in two
 *  passes, and the point is to not starve the work-order sweep. */
const REQUESTS_PER_PASS = 8;

export interface AttachmentMirrorResult {
  workOrdersScanned: number;
  requestsScanned: number;
  attachmentsFound: number;
  mirrored: number;
  failed: number;
  /**
   * Parents whose attachment METADATA write failed, so nothing could be
   * copied for them.
   *
   * Counted separately from `failed` (which is per-attachment download
   * failures) because it has a different cause and a different fix. It exists
   * at all because a metadata failure used to be invisible: the code logged
   * and moved on, leaving no attempt and no error on any row, so a PGRST102
   * 400 on every tick looked exactly like "not reached yet". A non-zero here
   * means look at the worker log, not at mirror_error.
   */
  metadataFailures: number;
  skipped: string | null;
  backfillComplete: boolean;
}

/** Which entity an attachment hangs off. The prefix keeps the two apart in R2
 *  so a listing is readable and a future cleanup can scope to one kind. */
export interface AttachmentOwner {
  kind: "work-orders" | "work-requests";
  id: number;
}

/** R2 object key. Namespaced by owner so a prefix listing is useful and a
 *  future cleanup can scope itself. The attachment id is unique account-wide
 *  and is what the serve route looks up. */
export function attachmentR2Key(
  owner: AttachmentOwner,
  attachmentId: number,
  mimeType: string | null
): string {
  const ext = extensionFor(mimeType);
  return `${owner.kind}/${owner.id}/${attachmentId}${ext}`;
}

function extensionFor(mimeType: string | null): string {
  switch ((mimeType ?? "").toLowerCase()) {
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    case "image/heic":
    case "image/heif":
      return ".heic";
    case "application/pdf":
      return ".pdf";
    default:
      // No extension rather than a guessed one. The stored mime_type column is
      // what the serve route sets Content-Type from, so the key's suffix is
      // cosmetic and a wrong one would be worse than none.
      return "";
  }
}

interface ScopeRow {
  id: number;
}

/**
 * The next work orders to inspect, ordered by id so the cursor is monotonic.
 *
 * Scope is the operator's: active and NOT preventive. `deleted_at is null`
 * matters here too -- mirroring images for a work order nobody can see would
 * spend the budget on rows the page will never render.
 */
async function nextWorkOrders(
  env: MxAttachmentEnv,
  afterId: number,
  limit: number
): Promise<ScopeRow[] | null> {
  const url =
    `${env.SUPABASE_URL}/rest/v1/mx_work_order` +
    `?select=id` +
    `&status=in.(OPEN,IN_PROGRESS,ON_HOLD)` +
    `&deleted_at=is.null` +
    `&type=not.eq.PREVENTIVE` +
    `&id=gt.${afterId}` +
    `&order=id.asc` +
    `&limit=${limit}`;
  try {
    const res = await fetch(url, {
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`
      }
    });
    if (!res.ok) {
      console.error(`[mx-attach] scope read failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
      return null;
    }
    return (await res.json()) as ScopeRow[];
  } catch (err) {
    console.error("[mx-attach] scope read threw:", err);
    return null;
  }
}

/** Which attachments on this work order already have bytes in R2, and how many
 *  times each has been tried. Read before downloading so a re-run costs no
 *  transfer and a repeatedly-failing object eventually stops being retried. */
async function existingMirrorState(
  env: MxAttachmentEnv,
  workOrderId: number
): Promise<Map<number, { mirrored: boolean; attempts: number }>> {
  const out = new Map<number, { mirrored: boolean; attempts: number }>();
  const url =
    `${env.SUPABASE_URL}/rest/v1/mx_work_order_attachment` +
    `?select=id,r2_key,mirror_attempts&work_order_id=eq.${workOrderId}`;
  try {
    const res = await fetch(url, {
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`
      }
    });
    if (!res.ok) return out;
    const rows = (await res.json()) as Array<{
      id: number;
      r2_key: string | null;
      mirror_attempts: number | null;
    }>;
    for (const r of rows) {
      out.set(r.id, { mirrored: r.r2_key !== null, attempts: r.mirror_attempts ?? 0 });
    }
  } catch {
    // Treated as "nothing known", which re-downloads at worst. Failing the
    // whole pass over a bookkeeping read would be worse.
  }
  return out;
}

/**
 * Download one attachment and put it in R2.
 *
 * `url` must be fresh -- it comes from the single-GET this pass just made.
 * Never persisted anywhere; see the header.
 */
async function copyOne(
  env: MxAttachmentEnv,
  bucket: R2Bucket,
  owner: AttachmentOwner,
  attachmentId: number,
  mimeType: string | null,
  url: string,
  priorAttempts: number
): Promise<{ ok: boolean; bytes: number; error: string | null }> {
  const attempts = priorAttempts + 1;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      const error = `download ${res.status}`;
      await recordMxAttachmentMirror(env, attachmentId, {
        mirror_error: error,
        mirror_attempts: attempts
      });
      return { ok: false, bytes: 0, error };
    }

    const declared = Number(res.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > MAX_ATTACHMENT_BYTES) {
      const error = `too large: ${declared} bytes`;
      await recordMxAttachmentMirror(env, attachmentId, {
        mirror_error: error,
        mirror_attempts: MAX_MIRROR_ATTEMPTS // terminal; size will not change
      });
      return { ok: false, bytes: 0, error };
    }

    const body = await res.arrayBuffer();
    if (body.byteLength > MAX_ATTACHMENT_BYTES) {
      const error = `too large after read: ${body.byteLength} bytes`;
      await recordMxAttachmentMirror(env, attachmentId, {
        mirror_error: error,
        mirror_attempts: MAX_MIRROR_ATTEMPTS
      });
      return { ok: false, bytes: 0, error };
    }

    const key = attachmentR2Key(owner, attachmentId, mimeType);
    await bucket.put(key, body, {
      httpMetadata: { contentType: mimeType ?? "application/octet-stream" }
    });

    // Written only after the PUT resolves. Recording the key first and the
    // bytes later would leave a row claiming a copy that does not exist, which
    // the serve route would answer as a 404 forever.
    await recordMxAttachmentMirror(env, attachmentId, {
      r2_key: key,
      r2_bytes: body.byteLength,
      mirrored_at: new Date().toISOString(),
      mirror_error: null,
      mirror_attempts: attempts
    });
    return { ok: true, bytes: body.byteLength, error: null };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await recordMxAttachmentMirror(env, attachmentId, {
      mirror_error: error.slice(0, 500),
      mirror_attempts: attempts
    });
    return { ok: false, bytes: 0, error };
  }
}

/**
 * Pending work requests with at least one attachment still un-mirrored.
 *
 * Unlike the work-order scope this is NOT cursor-driven. There are 15 pending
 * requests; a cursor would be machinery for a set that fits in two passes, and
 * it would also go stale the moment a request stops being pending. Instead the
 * pass asks each time for requests it has not finished, which is
 * self-correcting: a request that gets approved simply stops being returned.
 *
 * "Not finished" cannot be expressed as a join in PostgREST, so this returns
 * candidates and the caller skips the ones already complete. With 15 rows that
 * is cheaper than being clever.
 */
async function nextWorkRequests(
  env: MxAttachmentEnv,
  limit: number
): Promise<Array<{ id: number }> | null> {
  const url =
    `${env.SUPABASE_URL}/rest/v1/mx_work_request` +
    `?select=id` +
    `&request_status=in.(${REQUEST_STATUSES_TO_MIRROR.join(",")})` +
    `&order=mx_created_at.desc.nullslast` +
    `&limit=${limit}`;
  try {
    const res = await fetch(url, {
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`
      }
    });
    if (!res.ok) {
      console.error(
        `[mx-attach] request scope read failed: ${res.status} ${(await res.text()).slice(0, 200)}`
      );
      return null;
    }
    return (await res.json()) as Array<{ id: number }>;
  } catch (err) {
    console.error("[mx-attach] request scope read threw:", err);
    return null;
  }
}

/** Mirror state for one request's attachments, keyed by attachment id. */
async function existingRequestMirrorState(
  env: MxAttachmentEnv,
  workRequestId: number
): Promise<Map<number, { mirrored: boolean; attempts: number }>> {
  const out = new Map<number, { mirrored: boolean; attempts: number }>();
  const url =
    `${env.SUPABASE_URL}/rest/v1/mx_work_order_attachment` +
    `?select=id,r2_key,mirror_attempts&work_request_id=eq.${workRequestId}`;
  try {
    const res = await fetch(url, {
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`
      }
    });
    if (!res.ok) return out;
    const rows = (await res.json()) as Array<{
      id: number;
      r2_key: string | null;
      mirror_attempts: number | null;
    }>;
    for (const r of rows) {
      out.set(r.id, { mirrored: r.r2_key !== null, attempts: r.mirror_attempts ?? 0 });
    }
  } catch {
    // "Nothing known" -- re-downloads at worst.
  }
  return out;
}

/**
 * Mirror photos for pending work requests. Same shape as the work-order sweep:
 * single-GET for fresh presigned URLs, download immediately, record state.
 *
 * Returns how many requests it looked at. Runs AFTER the work-order sweep on
 * the shared budget, so it gets whatever time is left -- work orders are the
 * page's primary content and must not be starved by 15 requests.
 */
async function mirrorPendingRequests(
  env: MxAttachmentEnv,
  bucket: R2Bucket,
  apiKey: string,
  startedAt: number,
  result: AttachmentMirrorResult
): Promise<void> {
  if (Date.now() - startedAt > BUDGET_MS) return;

  const requests = await nextWorkRequests(env, REQUESTS_PER_PASS);
  if (requests === null || requests.length === 0) return;

  for (const row of requests) {
    if (Date.now() - startedAt > BUDGET_MS) break;

    const known = await existingRequestMirrorState(env, row.id);

    const fetched = await fetchMaintainXWorkRequest({
      id: row.id,
      apiKey,
      baseUrl: env.MAINTAINX_BASE_URL,
      expand: SINGLE_WORK_REQUEST_EXPAND
    });
    if (!fetched.ok || !fetched.workRequest) continue;
    result.requestsScanned += 1;

    const attachments = mapWorkRequestAttachments(
      fetched.workRequest,
      new Date().toISOString()
    );
    if (attachments.length === 0) continue;
    result.attachmentsFound += attachments.length;

    // Everything already copied? Skip the metadata write too -- a no-op upsert
    // every five minutes on every pending request is pure noise.
    const pending = attachments.filter((a) => {
      const prior = known.get(a.id);
      return !prior?.mirrored && (prior?.attempts ?? 0) < MAX_MIRROR_ATTEMPTS;
    });
    if (pending.length === 0) continue;

    const meta = await upsertMxWorkOrderAttachments(env, attachments);
    if (!meta.ok) {
      result.metadataFailures += 1;
      console.error(`[mx-attach] metadata upsert failed for request ${row.id}: ${meta.error}`);
      continue;
    }

    const rawBag = fetched.workRequest as unknown as Record<string, unknown>;
    const urlById = collectAttachmentUrls(rawBag);

    for (const att of pending) {
      if (Date.now() - startedAt > BUDGET_MS) break;
      const url = urlById.get(att.id);
      if (!url) continue;
      const copied = await copyOne(
        env,
        bucket,
        { kind: "work-requests", id: row.id },
        att.id,
        att.mime_type ?? null,
        url,
        known.get(att.id)?.attempts ?? 0
      );
      if (copied.ok) result.mirrored += 1;
      else result.failed += 1;
    }
  }
}

/**
 * One bounded pass. Never throws -- the caller is a scheduled handler shared
 * with two other jobs.
 */
export async function runMxAttachmentMirror(
  env: MxAttachmentEnv
): Promise<AttachmentMirrorResult> {
  const startedAt = Date.now();
  const result: AttachmentMirrorResult = {
    workOrdersScanned: 0,
    requestsScanned: 0,
    attachmentsFound: 0,
    mirrored: 0,
    failed: 0,
    metadataFailures: 0,
    skipped: null,
    backfillComplete: false
  };

  const bucket = env.WORKORDER_FILES;
  if (!bucket) {
    result.skipped = "WORKORDER_FILES bucket not bound";
    return result;
  }
  const apiKey = env.MAINTAINX_API_KEY;
  if (!apiKey) {
    result.skipped = "MAINTAINX_API_KEY not bound";
    return result;
  }

  const state = await getMxSyncState(env, MX_PASS_ATTACHMENTS);
  if (!state.ok) {
    result.skipped = `sync state: ${state.error}`;
    return result;
  }
  // The `cursor` column, which is text. NOT `watermark` -- that one is
  // timestamptz, and putting a work-order id in it is a 400 from PostgREST.
  // The failure mode was worse than a lost write: the id never advanced, so
  // the pass re-did the same 12 work orders every five minutes, doing real
  // MaintainX calls each time and never reaching the 13th.
  //
  // `cursor` is also what the backfill passes use, but this key is
  // deliberately not a member of MX_BACKFILL_PASSES, so the dispatcher's
  // isComplete() never reads it.
  const cursor = Number(state.state?.cursor ?? "0");
  const afterId = Number.isFinite(cursor) ? cursor : 0;

  const scope = await nextWorkOrders(env, afterId, WORK_ORDERS_PER_PASS);
  if (scope === null) {
    result.skipped = "scope read failed";
    return result;
  }

  if (scope.length === 0) {
    // Walked the whole scope. Reset to 0 so the next pass sweeps again and
    // picks up attachments added to work orders already visited -- the webhook
    // records their metadata but only this pass can copy the bytes.
    result.backfillComplete = true;
    // Requests are swept even on the work-order wrap-up tick. They are not
    // cursor-driven, so skipping them here would mean they only ever run on
    // ticks that happen to have work-order scope left.
    await mirrorPendingRequests(env, bucket, apiKey, startedAt, result);
    await writeMxSyncState(env, MX_PASS_ATTACHMENTS, {
      cursor: "0",
      last_run_at: new Date().toISOString(),
      last_success_at: new Date().toISOString(),
      last_status: "OK",
      stats: { note: "scope exhausted; cursor reset for the next sweep" }
    });
    return result;
  }

  const locations = await fetchMxLocationMap(env);
  if (!locations.ok) {
    result.skipped = `location map: ${locations.error}`;
    return result;
  }

  let lastId = afterId;
  for (const row of scope) {
    if (Date.now() - startedAt > BUDGET_MS) break;
    lastId = row.id;
    result.workOrdersScanned += 1;

    // Single-GET: the only way to see the full attachment set, and the source
    // of the fresh URLs used immediately below.
    const fetched = await fetchMaintainXWorkOrder({
      id: row.id,
      apiKey,
      baseUrl: env.MAINTAINX_BASE_URL,
      expand: SINGLE_WORK_ORDER_EXPAND
    });
    if (!fetched.ok || !fetched.workOrder) {
      // A 404 means it was deleted; the webhook and the re-fetch path own
      // that. Nothing to mirror either way.
      continue;
    }

    const mapped = mapWorkOrder(fetched.workOrder, locations.map, new Date().toISOString());
    if (!mapped || mapped.attachments.length === 0) continue;
    result.attachmentsFound += mapped.attachments.length;

    // Metadata first: the mirror PATCH below targets rows by id, so they have
    // to exist. Dropping `categories` for the same reason processWorkOrder
    // does is not needed here -- only the attachment rows are written.
    const meta = await upsertMxWorkOrderAttachments(env, mapped.attachments);
    if (!meta.ok) {
      result.metadataFailures += 1;
      console.error(`[mx-attach] metadata upsert failed for work order ${row.id}: ${meta.error}`);
      continue;
    }

    const known = await existingMirrorState(env, row.id);
    // The raw payload is where the fresh URLs live. Read from the fetched
    // response rather than from the row we just wrote, because the row
    // deliberately does not carry them.
    const rawBag = fetched.workOrder as unknown as Record<string, unknown>;
    const urlById = collectAttachmentUrls(rawBag);

    for (const att of mapped.attachments) {
      if (Date.now() - startedAt > BUDGET_MS) break;
      const prior = known.get(att.id);
      if (prior?.mirrored) continue;
      if ((prior?.attempts ?? 0) >= MAX_MIRROR_ATTEMPTS) continue;

      const url = urlById.get(att.id);
      if (!url) continue;

      const copied = await copyOne(
        env,
        bucket,
        { kind: "work-orders", id: row.id },
        att.id,
        att.mime_type ?? null,
        url,
        prior?.attempts ?? 0
      );
      if (copied.ok) result.mirrored += 1;
      else result.failed += 1;
    }
  }

  // After the work orders, with whatever budget is left. Work orders are the
  // page's primary content; 15 pending requests must not starve them.
  await mirrorPendingRequests(env, bucket, apiKey, startedAt, result);

  await writeMxSyncState(env, MX_PASS_ATTACHMENTS, {
    cursor: String(lastId),
    last_run_at: new Date().toISOString(),
    last_success_at: new Date().toISOString(),
    last_status: "OK",
    stats: {
      work_orders_scanned: result.workOrdersScanned,
      requests_scanned: result.requestsScanned,
      attachments_found: result.attachmentsFound,
      mirrored: result.mirrored,
      failed: result.failed,
      metadata_failures: result.metadataFailures
    }
  });

  return result;
}

/** Attachment id -> presigned URL, from the live response. Includes the
 *  thumbnail, which arrives on its own key rather than inside `attachments`. */
function collectAttachmentUrls(bag: Record<string, unknown>): Map<number, string> {
  const out = new Map<number, string>();
  const add = (entry: unknown): void => {
    if (!entry || typeof entry !== "object") return;
    const rec = entry as Record<string, unknown>;
    const id = typeof rec.id === "number" ? rec.id : Number(rec.id);
    const url = rec.url;
    if (Number.isFinite(id) && typeof url === "string" && url !== "") {
      out.set(id, url);
    }
  };
  add(bag.thumbnail);
  if (Array.isArray(bag.attachments)) for (const a of bag.attachments) add(a);
  return out;
}
