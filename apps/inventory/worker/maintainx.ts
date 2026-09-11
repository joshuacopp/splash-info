// MaintainX work requests for the inventory app.
//
// Requests are filed STRAIGHT TO MAINTAINX and nothing about them is stored in
// Supabase. There is no inventory-side requests table, no photo bucket and no
// pending queue: the create POST returns a MaintainX request id, the photos PUT
// against that id, and the list route reads them back out of MaintainX. The one
// piece of local state is `locations.maintainx_id`, which already existed.
//
// This mirrors the path apps/workorders-worker has run in production since
// Brief 74/76 — see apps/workorders-worker/src/index.ts. The two hard-won
// details from those briefs carry over and must not be re-litigated here:
//
//   1. The attachment URL segment is PLURAL (`/attachments/{filename}`) even
//      though the MaintainX doc heading reads singular. Brief 74 shipped
//      singular and every upload 404'd. @splash/maintainx owns that mapping.
//   2. There is NO IDEMPOTENCY KEY on the create endpoint. A double-submit
//      makes two work requests. The SPA disables its submit button while a
//      request is in flight; that is the only guard there is.
//
// Every @splash/maintainx call is fail-soft — it resolves with `ok:false` and
// an `error` string rather than throwing — so the code below checks `.ok` and
// never wraps these in try/catch.

import {
  createMaintainXWorkRequest,
  fetchMaintainXWorkOrders,
  fetchMaintainXWorkRequests,
  uploadMaintainXWorkRequestFile,
  type RawWorkRequest
} from "@splash/maintainx";
import type { Env } from "./env.js";

/**
 * Marker identifying a request as having been filed from THIS app.
 *
 * MaintainX has no "source" field on a work request, and every request for a
 * location comes back from the list endpoint regardless of who filed it or
 * where. So origin is stamped into the description on create and matched on
 * read — this page shows only what was filed through the inventory app, not
 * everything happening at the site (which is what /workorders is for).
 *
 * KNOWN FRAGILITY: this is a text match. If someone edits a request's
 * description inside MaintainX and drops this line, the request stops
 * appearing here. A MaintainX custom field (`extraFields` on the create
 * endpoint, which @splash/maintainx does not send today) would be a firmer
 * key and is the upgrade path if that turns out to matter.
 *
 * Do not reword this token. Requests already in MaintainX carry the current
 * spelling, and changing it orphans every one of them.
 */
export const ORIGIN_TAG = "[splash-inventory]";

/** Separator between the filer's own words and the provenance block that
 *  create appends. Used to strip that block back off for display. */
const PROVENANCE_SEPARATOR = "\n---\n";

/** Photo cap. MaintainX takes one thumbnail plus N attachments, so six photos
 *  is photo[0] → thumbnail and photo[1..5] → attachments. workorders-worker
 *  caps at five; the extra slot here is a UI decision, not an API limit. */
export const REQUEST_MAX_PHOTOS = 6;

/** Per-photo ceiling, matching workorders-worker's REQUEST_PHOTO_MAX_BYTES.
 *  Phone cameras clear 10 MB routinely, so this is deliberately generous. */
export const REQUEST_PHOTO_MAX_BYTES = 15 * 1024 * 1024;

/** Cap on rows pulled back from the list endpoint. The cursor walk stops here
 *  and reports `truncated`, which the page surfaces rather than hiding. */
const LIST_MAX_REQUESTS = 500;

/** Statuses worth showing an inventory operator. A request that MaintainX staff
 *  promoted (APPROVED) or closed (DONE) has left the filer's hands, but it is
 *  still the outcome of something they reported, so all four are listed and the
 *  page filters client-side. */
const LIST_STATUSES = ["PENDING", "APPROVED", "REJECTED", "DONE"];

/** Cap on work orders pulled back to resolve statuses for approved requests. */
const LIST_MAX_WORK_ORDERS = 500;

/**
 * Display order for the request-status groups. Approved work is what an
 * operator is waiting on, so it leads; rejected and completed sink.
 *
 * DONE is a REQUEST status (MaintainX marks a request done once its work is
 * closed out) and is distinct from a work order's DONE below.
 */
const REQUEST_STATUS_RANK: Record<string, number> = {
  APPROVED: 0,
  PENDING: 1,
  REJECTED: 2,
  DONE: 3
};

/**
 * Secondary order INSIDE the approved group, by the status of the work order
 * the request was promoted into. Follows the work lifecycle, with finished
 * work last.
 *
 * An approved request with no resolvable work-order status ranks between
 * ON_HOLD and DONE: it is unusual enough to want visible, but it is not more
 * urgent than work that is genuinely open or in progress.
 */
const WORK_ORDER_STATUS_RANK: Record<string, number> = {
  OPEN: 0,
  IN_PROGRESS: 1,
  ON_HOLD: 2,
  // Terminal states last, done first among them. Cancelled and skipped work
  // is the least actionable thing on the page.
  DONE: 4,
  CANCELED: 5,
  SKIPPED: 6
};
const WORK_ORDER_STATUS_RANK_UNKNOWN = 3;

function requestStatusRank(status: string): number {
  return REQUEST_STATUS_RANK[status] ?? 90;
}

function workOrderStatusRank(status: string | null): number {
  if (!status) return WORK_ORDER_STATUS_RANK_UNKNOWN;
  return WORK_ORDER_STATUS_RANK[status] ?? WORK_ORDER_STATUS_RANK_UNKNOWN;
}

export interface MaintainXConfig {
  apiKey: string;
  baseUrl: string;
}

/** Resolve credentials, or null when the worker has no MaintainX binding.
 *  Callers turn null into `{ configured: false }` rather than an error — an
 *  unconfigured integration is a deployment state, not a failure. */
export function maintainxConfig(env: Env): MaintainXConfig | null {
  const apiKey = env.MAINTAINX_API_KEY;
  const baseUrl = env.MAINTAINX_BASE_URL;
  if (!apiKey || !apiKey.trim()) return null;
  if (!baseUrl || !baseUrl.trim()) return null;
  return { apiKey: apiKey.trim(), baseUrl: baseUrl.trim() };
}

/* ============================================================
 * Filename sanitising — ported from workorders-worker.
 *
 * The filename lands in a URL path segment. Anything exotic either breaks the
 * PUT or gives MaintainX a name nobody can read in the app, so squash to a
 * conservative charset and keep the extension.
 * ============================================================ */

const SAFE_FILENAME = /[^a-zA-Z0-9._-]/g;

export function sanitizeFilename(raw: string, fallbackIndex: number): string {
  const trimmed = (raw || "").trim();
  const dot = trimmed.lastIndexOf(".");
  let stem = dot > 0 ? trimmed.slice(0, dot) : trimmed;
  let ext = dot > 0 ? trimmed.slice(dot + 1) : "";

  stem = stem.replace(SAFE_FILENAME, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  ext = ext.replace(SAFE_FILENAME, "").toLowerCase();

  if (!stem) stem = `photo-${fallbackIndex + 1}`;
  // Cap the stem so a pathological 400-char filename can't push the PUT URL
  // past what MaintainX will accept.
  if (stem.length > 60) stem = stem.slice(0, 60);

  return ext ? `${stem}.${ext}` : stem;
}

/* ============================================================
 * READ — list requests for the caller's locations.
 * ============================================================ */

export interface ListedRequest {
  id: number;
  title: string;
  description: string;
  priority: string | null;
  status: string;
  createdAt: string | null;
  updatedAt: string | null;
  locationId: number | null;
  locationName: string | null;
  workOrderId: number | null;
  /** Status of the work order this request was promoted into (OPEN /
   *  IN_PROGRESS / ON_HOLD / DONE). Null when the request has no work order,
   *  or when the work order exists but wasn't in the fetched page. */
  workOrderStatus: string | null;
  /** Name typed into the filing form, recovered from the provenance block.
   *  Null for a request whose description no longer carries one. */
  filedBy: string | null;
}

export interface ListRequestsResult {
  configured: true;
  ok: boolean;
  requests: ListedRequest[];
  /** True when MaintainX had more rows than LIST_MAX_REQUESTS. Surfaced so the
   *  page can say the list is partial instead of quietly showing a prefix. */
  truncated: boolean;
  error: string | null;
}

/** True when this request was filed through the inventory app. Matched against
 *  the RAW description, before the provenance block is stripped for display. */
function isFiledFromInventory(raw: RawWorkRequest): boolean {
  return (raw.description || "").includes(ORIGIN_TAG);
}

/** Pull the typed filer name back out of the provenance block. Returns null
 *  rather than guessing when the line isn't there. */
function extractFiledBy(description: string): string | null {
  const m = description.match(/^Filed by:\s*(.+?)\s*(?:\(|$)/m);
  const name = m?.[1]?.trim();
  return name ? name : null;
}

function normalize(
  raw: RawWorkRequest,
  nameById: Map<number, string>,
  woStatusById: Map<number, string>
): ListedRequest {
  const locationId =
    typeof raw.locationId === "number"
      ? raw.locationId
      : typeof raw.location?.id === "number"
        ? raw.location.id
        : null;

  const fullDescription = (raw.description || "").trim();
  // Show the filer's own words, not the machine-appended footer. The footer is
  // still what MaintainX staff see in the request itself, which is where the
  // attribution is actually needed.
  const idx = fullDescription.indexOf(PROVENANCE_SEPARATOR);
  const body = idx === -1 ? fullDescription : fullDescription.slice(0, idx).trim();

  return {
    id: raw.id,
    title: (raw.title || "").trim() || "(untitled request)",
    description: body,
    filedBy: extractFiledBy(fullDescription),
    priority: raw.priority ? String(raw.priority).toUpperCase() : null,
    // requestStatus is the work-REQUEST field; a work ORDER's `type`/`status`
    // is a different axis and must not be read here (see work-requests.ts).
    status: (raw.requestStatus || "PENDING").toUpperCase(),
    createdAt: raw.createdAt ?? null,
    updatedAt: raw.updatedAt ?? null,
    locationId,
    // Prefer OUR name for the site over MaintainX's. The operator navigates
    // this app by Splash location names; showing MaintainX's spelling of the
    // same place ("SPLASH #19 EXPRESS") would read as a different site.
    locationName:
      (locationId != null ? nameById.get(locationId) : null) ??
      (raw.location?.name ? String(raw.location.name) : null),
    workOrderId: typeof raw.workOrderId === "number" ? raw.workOrderId : null,
    workOrderStatus:
      typeof raw.workOrderId === "number"
        ? (woStatusById.get(raw.workOrderId) ?? null)
        : null
  };
}

/**
 * Resolve work-order id → status for the approved requests in `raw`.
 *
 * Returns null (not an empty Map) when the lookup was skipped or failed, but
 * callers treat both the same: an unresolved status sorts to the middle of the
 * approved group rather than failing the page. Work-order status is ordering
 * detail — it is not worth a 500.
 */
async function fetchWorkOrderStatuses(
  config: MaintainXConfig,
  allowedLocationIds: number[],
  raw: RawWorkRequest[]
): Promise<Map<number, string> | null> {
  // Only APPROVED requests need this. Verified against live data 2026-09-10:
  // MaintainX moves a request to DONE when its work order closes, so a request
  // still sitting at APPROVED has, by definition, a work order that is still
  // open. DONE requests are ordered by their own group and need no lookup.
  //
  // That is why this uses the client's DEFAULT status filter (OPEN /
  // IN_PROGRESS / ON_HOLD) rather than asking for every status. Requesting
  // closed work too would drag back every work order those locations have ever
  // completed, and with a 500-row cap the ones we actually need could fall off
  // the end — the lookup would get slower AND less correct as history grows.
  const wanted = new Set(
    raw
      .filter((r) => (r.requestStatus || "").toUpperCase() === "APPROVED")
      .map((r) => r.workOrderId)
      .filter((id): id is number => typeof id === "number" && Number.isFinite(id))
  );
  if (wanted.size === 0) return null;

  const result = await fetchMaintainXWorkOrders({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    maintainxLocationIds: allowedLocationIds,
    paginate: true,
    maxWorkOrders: LIST_MAX_WORK_ORDERS
  });

  const out = new Map<number, string>();
  for (const wo of result.workOrders) {
    if (!wanted.has(wo.id)) continue;
    const status = (wo.status || "").trim().toUpperCase();
    if (status) out.set(wo.id, status);
  }

  if (!result.ok) {
    console.error("[inventory.maintainx] work-order status lookup partial:", result.error);
  }
  return out;
}

/**
 * Group by request status (approved, pending, rejected, then done), and inside
 * the approved group order by work-order status with finished work last.
 * Newest first within any tie.
 */
function compareRequests(a: ListedRequest, b: ListedRequest): number {
  const byStatus = requestStatusRank(a.status) - requestStatusRank(b.status);
  if (byStatus !== 0) return byStatus;

  // Work-order status only orders the approved group. Applying it to pending
  // requests would be meaningless (they have no work order) and to rejected
  // ones misleading.
  if (a.status === "APPROVED") {
    const byWo = workOrderStatusRank(a.workOrderStatus) - workOrderStatusRank(b.workOrderStatus);
    if (byWo !== 0) return byWo;
  }

  return (b.createdAt || "").localeCompare(a.createdAt || "");
}

/**
 * Fetch the caller's work requests.
 *
 * `allowedLocationIds` is the set of MaintainX location ids the session may
 * see, derived from the operator's inventory scope. It is passed to MaintainX
 * as a server-side filter AND re-applied to the response, which is the posture
 * work-requests.ts documents: the param keeps the cursor walk short, the
 * caller-side filter is what actually enforces scope.
 */
export async function listWorkRequests(
  config: MaintainXConfig,
  allowedLocationIds: number[],
  nameById: Map<number, string>
): Promise<ListRequestsResult> {
  // No mapped locations means nothing to ask about. Skipping the call also
  // avoids the failure mode where an empty `locations` filter is treated as
  // "no filter" and returns the whole organisation's requests.
  if (allowedLocationIds.length === 0) {
    return { configured: true, ok: true, requests: [], truncated: false, error: null };
  }

  const result = await fetchMaintainXWorkRequests({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    maintainxLocationIds: allowedLocationIds,
    statuses: LIST_STATUSES,
    maxWorkRequests: LIST_MAX_REQUESTS
  });

  // Origin filter FIRST, on the raw rows: this page reports what was filed
  // from the inventory app, not everything happening at the site. Requests
  // filed from /workorders or typed directly into MaintainX are that page's
  // business and would be noise here.
  const mine = result.workRequests.filter(isFiledFromInventory);

  // Work-order statuses, only when something actually needs one. Requests are
  // promoted by MaintainX staff, so on a fresh install nothing has a work
  // order and this second round trip is pure waste — skip it.
  const woStatusById = (await fetchWorkOrderStatuses(config, allowedLocationIds, mine)) ?? new Map();

  const allowed = new Set(allowedLocationIds);
  const requests = mine
    .map((raw) => normalize(raw, nameById, woStatusById))
    // Defense in depth: drop anything outside scope even if the server-side
    // `locations` filter was ignored. A request with no resolvable location id
    // can't be proven in-scope, so it goes too.
    .filter((r) => r.locationId != null && allowed.has(r.locationId))
    .sort(compareRequests);

  return {
    configured: true,
    // fetch is fail-soft and returns partial rows with ok:false; pass both
    // through so the page can show what arrived AND say the read was partial.
    ok: result.ok,
    requests,
    truncated: result.truncated,
    error: result.error
  };
}

/* ============================================================
 * WRITE — create a request, then attach its photos.
 * ============================================================ */

export interface CreateRequestInput {
  title: string;
  description: string;
  priority: "HIGH" | "MEDIUM" | "LOW";
  locationId: number;
  creatorContactInfo: string;
  photos: File[];
}

export interface CreateRequestResult {
  ok: boolean;
  requestId: number | null;
  /** How many photos failed to attach. The request still exists in MaintainX
   *  when this is non-zero — photo failure is deliberately non-fatal. */
  photosFailed: number;
  photosTotal: number;
  error: string | null;
}

export async function createWorkRequest(
  config: MaintainXConfig,
  input: CreateRequestInput
): Promise<CreateRequestResult> {
  // Phase 1 — create. Everything else keys on the id this returns, so a
  // failure here is fatal and nothing is uploaded.
  const created = await createMaintainXWorkRequest({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    title: input.title,
    description: input.description,
    priority: input.priority,
    locationId: input.locationId,
    creatorContactInfo: input.creatorContactInfo
  });

  if (!created.ok || created.requestId == null) {
    return {
      ok: false,
      requestId: null,
      photosFailed: 0,
      photosTotal: input.photos.length,
      error: created.error || "MaintainX did not accept the request."
    };
  }

  const requestId = created.requestId;

  // Phase 2 — photos. photo[0] becomes the thumbnail (what shows on the
  // request card in MaintainX), the rest attach. Failures are counted, not
  // thrown: the request already exists upstream, and losing it over a failed
  // JPEG would be worse than an incomplete one the filer can add to later.
  let photosFailed = 0;
  for (let i = 0; i < input.photos.length; i += 1) {
    const file = input.photos[i]!;
    const endpoint: "thumbnail" | "attachment" = i === 0 ? "thumbnail" : "attachment";

    let body: ArrayBuffer;
    try {
      body = await file.arrayBuffer();
    } catch (e) {
      console.error(
        `[inventory.maintainx] request ${requestId} photo ${i} (${endpoint}) read failed:`,
        e instanceof Error ? e.message : String(e)
      );
      photosFailed += 1;
      continue;
    }

    const uploaded = await uploadMaintainXWorkRequestFile({
      requestId,
      filename: sanitizeFilename(file.name, i),
      body,
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      endpoint
    });

    if (!uploaded.ok) {
      console.error(
        `[inventory.maintainx] request ${requestId} photo ${i} (${endpoint}) failed: status=${uploaded.status} error=${uploaded.error}`
      );
      photosFailed += 1;
    }
  }

  return {
    ok: true,
    requestId,
    photosFailed,
    photosTotal: input.photos.length,
    error: null
  };
}
