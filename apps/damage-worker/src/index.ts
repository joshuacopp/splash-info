
// SECURITY POSTURE (full):
//   - Every authenticated write endpoint goes through:
//       1. isOriginAllowed (CSRF)               — 403 bad origin
//       2. checkToolAccess "claims" (at gate)   — 401/403
//       3. loadAndScopeCheck (dc_role + scope)  — 403/404 (anti-leak)
//       4. Endpoint-specific validation         — 400
//   - State transitions use the explicit CLAIM_TRANSITIONS table from
//     ./transitions.ts. Authorization order is locked.
//   - Power Automate POSTs are best-effort: failures are logged + swallowed.
//     R2 has canonical record (saveClaimSubmission, saveFailedSubmission).
//   - Vestigial CEO_APPROVAL_THRESHOLD / requiresAmount / ceoEligible /
//     gm/rm stamps are preserved per directive — separate cleanup pass later.
//
// =============================================================================
// ROUTE TABLE (post-Step-7 cutover; production paths in comments)
// =============================================================================
//
// PUBLIC (no auth gate):
//   GET  /claims/{location-slug}                            — render claim form HTML (Brief 23)
//   GET  /claims/{location-slug}/thanks                     — render success confirmation HTML (Brief 23)
//   POST /claims-api/submit-claim                           — customer form submission
//                                                            (Brief 23: detects browser submit via
//                                                            Accept: text/html and 302s to
//                                                            /claims/{slug}/thanks?id=... or
//                                                            /claims/{slug}?error=...; programmatic
//                                                            JSON callers continue to receive JSON.
//                                                            Brief 146: now accepts EITHER multipart
//                                                            /form-data (legacy back-compat) OR
//                                                            application/json with `photo_refs`
//                                                            pointing at OOB-uploaded R2 keys.)
//   POST /claims-api/upload                                 — Brief 146 OOB per-photo upload
//                                                            (multipart, returns r2_key)
//   GET  /claims-api/photo/{r2-key-suffix...}               — serve R2 photo (handles both
//                                                            legacy `claims/...` keys and
//                                                            Brief 146 `claim-uploads/...` keys)
//
// AUTH-GATED (checkToolAccess "claims" — super-admin bypasses):
//   POST /manage/api/claim/{id}/note                        — add note
//   POST /manage/api/claim/{id}/transition                  — status change
//   POST /manage/api/claim/{id}/document                    — upload Quote/Receipt
//   POST /manage/api/claim/{id}/document/{docId}/delete     — soft-delete doc
//   POST /manage/api/claim/{id}/document/{docId}/edit       — edit doc metadata
//   GET  /manage/api/claim/{id}/quote/{quoteId}/preview-check-request.pdf
//                                                            — render PDF preview
//
// READ ENDPOINTS for apps/web SSR (added in Chunk 2):
//   GET  /manage/api/claims                                 — list claims (filtered)
//   GET  /manage/api/claim/{id}                             — claim detail JSON
//   GET  /manage/api/contact-roster?role=...                — Brief 59 RD/RM list
//   GET  /manage/api/reporting?...                          — Brief 59 reporting aggregates
//
// =============================================================================
// AUTH GATE POSITION
// =============================================================================
// /claims-api/*        — public endpoints; no gate. Customer-facing.
// /manage/api/*        — checkToolAccess(request, env, "claims") FIRST,
//                        before any handler logic. Super-admin bypasses;
//                        otherwise requires user_tool_access row with
//                        tool="claims".
//
// Handlers receive `session` from the gate result. dc_role and dcLocations
// are now first-class fields on Session (sourced from auth_unified — see
// the security contract in @splash/auth/index.ts), so the per-user scope
// filter lives at the call site of each read endpoint. No worker-local
// auth helper needed.
//
// =============================================================================
// LEGACY ROUTES NOT PORTED (retired in favor of SSO consolidation)
// =============================================================================
// Legacy /manage/login + /manage/change-password were standalone auth flows
// per-tool. Those are retired: the dashboard-worker's /api/login and
// /api/forced-reset are now the canonical SSO + reset flows for every tool.
// The /manage/login HTML page becomes apps/web's /login (shared); the
// /manage/change-password HTML page becomes apps/web's /change-password
// (shared). All flows set the same sb-access-token cookie at Path=/.
// Retirement is a behavior change but reduces three login forms to one.

import { authenticate, checkToolAccess, type Session } from "@splash/auth";
import {
  type ClaimsListFilters,
  countPhotosOfType,
  determinationToClaimStatus,
  getClaimById,
  getClaimByIdempotencyKey,
  insertDocPhoto,
  lifecycleForStatus,
  listActivityForClaim,
  listClaims,
  listPhotosForClaim,
  logActivity,
  logNote,
  softDeletePhoto,
  touchClaim,
  updateDocMetadata,
  updateMaintainXWorkOrderId,
  writeClaimBatch,
  type ClaimInsert
} from "@splash/db-d1";
import {
  type ContactRosterEntry,
  fetchLocationRoster,
  getActiveLocationByCode,
  getLocationContactInfo,
  getMaintainXLocationId,
  listContactRoster,
  listSummaryRecipients,
  type LocationRosterEntry,
  type SummaryRecipient,
  type SupabaseEnv
} from "@splash/db-supabase";
import { isOriginAllowed, json, jsonError, readForm } from "@splash/http";
import { isValidEmail } from "@splash/types/email-validate";
import {
  buildPhotoResponse,
  generateClaimId,
  type ImagesBinding,
  saveClaimSubmission,
  saveFailedSubmission,
  serveClaimPhoto,
  uploadClaimPhoto
} from "@splash/storage-r2";
import {
  AWAITING_PAYMENT_STATUSES,
  type ClaimDetermination,
  type ClaimPhotoRow,
  type ClaimRow,
  type ClaimStatus,
  type DamageRole,
  type FaultCategory,
  FAULT_CATEGORIES,
  type LifecycleState,
  type PayToType,
  displayLifecycleForStatus
} from "@splash/types/claims";
import {
  CEO_APPROVAL_THRESHOLD,
  type ClaimTransitionDef,
  findTransition
} from "./transitions.js";
import {
  STATUS_NOTIFIES_NEXT,
  fireClaimUpdateWebhook,
  resolveRecipients,
  type ClaimUpdateChangeType,
  type ClaimUpdateWebhookPayload,
  fireInternalNewClaimWebhook,
  resolveInternalRecipients,
  type ClaimPhotoForWebhook,
  type InternalNewClaimPayload,
  fireD1FailureAlert
} from "./notifications.js";
import {
  buildCheckRequestFields,
  generateCheckRequestPdf,
  runCheckRequestPdfStep
} from "./pdf.js";
import {
  htmlResponse,
  renderClaimForm,
  renderClaimNotFound,
  renderThanksPage
} from "./render/claim-form.js";
import {
  generateClaimSummaryPdf,
  type ClaimSummaryPdfInput
} from "./render/claim-summary-pdf.js";
import { createMaintainXWorkOrder, type MaintainXResult } from "./maintainx.js";
import { resolveAdminBase } from "./admin-url.js";
import { ASSETS } from "@splash/storage-r2";
import {
  handleClaimPhotoUpload,
  runClaimUploadsCleanup
} from "./uploads.js";

interface Env extends SupabaseEnv {
  DB: D1Database;
  R2_BUCKET: R2Bucket;
  /** Cloudflare Images binding for HEIC→JPEG conversion. Optional —
   *  uploadClaimPhoto stores HEIC pass-through when unbound. */
  IMAGES?: ImagesBinding;
  /** Power Automate webhook URL — receives the claim submission JSON.
   *  Legacy/damagemanager.js:9 hardcoded this with an embedded signature;
   *  moved to a secret binding for the new worker. Set via
   *  `wrangler secret put POWER_AUTOMATE_URL`. */
  POWER_AUTOMATE_URL?: string;
  /** Webhook URL fired after RM approves a quote — INCIDENTS desk receives
   *  the auto-generated Check Request PDF. Optional; fail-soft. */
  INCIDENTS_WEBHOOK_URL?: string;
  /** Webhook URL fired after Incidents submits for payment — AP desk
   *  receives the fully-signed Check Request PDF. Optional; fail-soft. */
  AP_WEBHOOK_URL?: string;
  /** Webhook URL fired after a customer-submitted claim — PA receives the
   *  claim summary URL + customer email and emails the customer their copy
   *  of the claim (Brief 32). Optional; fail-soft. When unbound the
   *  customer-email path is silently skipped (PDF still generates and
   *  surfaces in the post-submit outcome card). Set via
   *  `wrangler secret put CUSTOMER_CLAIM_WEBHOOK_URL`. */
  CUSTOMER_CLAIM_WEBHOOK_URL?: string;
  /** MaintainX bearer token (Brief 42). Bound on `splash-damage` only.
   *  Set via `wrangler secret put MAINTAINX_API_KEY`. When unbound the
   *  WO-creation hook silently skips and the claim still proceeds. */
  MAINTAINX_API_KEY?: string;
  /** "test" routes WOs only to Josh (Brett/Scott bypassed); "production"
   *  pages the real assignee pair. Defined as a non-secret `[vars]` entry
   *  in wrangler.toml so accidental dev deploys can't page real people. */
  MAINTAINX_MODE: "production" | "test";
  /** REST root (no trailing /workorders). Non-secret; visible in source for
   *  diff-ability. `[vars]` entry; default `https://api.getmaintainx.com/v1`. */
  MAINTAINX_BASE_URL: string;
  /** Used to build the admin URL inside each WO description (Brief 42).
   *  `[vars]` entry; flip to the prod hostname at cutover. */
  APPS_WEB_BASE_URL: string;
  /** Brief 65 — daily open-claims summary webhook (Power Automate). The
   *  scheduled handler POSTs one DigestPayload per recipient. Optional;
   *  when unbound the cron logs and exits cleanly. Bind via
   *  `wrangler secret put DAILY_SUMMARY_WEBHOOK_URL`. */
  DAILY_SUMMARY_WEBHOOK_URL?: string;
  /** Brief 101 — manage-page update notifications. Fires on note adds
   *  (both rm_email + site_email) and on status changes whose `to` is
   *  in `STATUS_NOTIFIES_NEXT`. Optional; when unbound the webhook is
   *  silently skipped. Bind via
   *  `wrangler secret put CLAIM_UPDATE_WEBHOOK_URL`. */
  CLAIM_UPDATE_WEBHOOK_URL?: string;
  /** Brief 102 — internal new-claim notification. Fires after every
   *  successful customer claim submission, parallel to the Brief 32
   *  customer-email webhook. Recipients: location's rm_email +
   *  site_email + am_email + INCIDENTS_EMAIL (below). Optional; when
   *  unbound the internal-notification path is silently skipped (the
   *  customer-email path is unaffected). Bind via
   *  `wrangler secret put INTERNAL_NEW_CLAIM_WEBHOOK_URL`. */
  INTERNAL_NEW_CLAIM_WEBHOOK_URL?: string;
  /** Brief 102 — incidents inbox copied on every customer claim
   *  submission. Non-secret `[vars]` entry; edit in wrangler.toml to
   *  change the address. When unbound or blank the incidents recipient
   *  drops out of `recipients[]` and PA emails only the location's
   *  three contact addresses. */
  INCIDENTS_EMAIL?: string;
}

/** R2 key for the brand logo embedded in the claim summary PDF header band
 *  (Brief 32). Operator must upload an ~36pt-tall white-on-navy PNG to this
 *  key in the damagedocs bucket; the worker falls back to fetching ASSETS.logoWhite
 *  via HTTPS if the R2 object is missing. */
const SUMMARY_LOGO_R2_KEY = "assets/splash-logo-white.png";

/** Soft cap on the base64-encoded PDF that goes into the customer-email
 *  webhook payload. Above this threshold the worker omits `summary_pdf_base64`
 *  and relies on `summary_pdf_url` only (PA fetches by URL). 4 MB is the
 *  brief's stated cutoff; raw bytes ~3 MB encode to ~4 MB base64. */
const CUSTOMER_WEBHOOK_BASE64_MAX_BYTES = 3 * 1024 * 1024;

/** Document types accepted by /manage/api/claim/{id}/document. */
const DOCUMENT_TYPES = new Set<string>(["Quote", "Receipt"]);
const DOCUMENT_MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const DOCUMENT_ALLOWED_MIME = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/heic",
  "image/heif",
  "image/heic-sequence",
  "image/heif-sequence"
]);
const DOCUMENT_ALLOWED_EXT = new Set(["pdf", "jpg", "jpeg", "png", "heic", "heif"]);

/** Photo categories on /claims-api/submit-claim — matches legacy:120-125. */
const PHOTO_CATEGORIES = [
  { field: "fourCornersPhotos", type: "Vehicle Overview" },
  { field: "vinPhoto", type: "VIN" },
  { field: "damagePhotos", type: "Damage" },
  { field: "platePhoto", type: "License Plate" }
] as const;

/**
 * Brief 41 — damage_type allow-list. Mirrors the <option value="..."> set
 * in apps/damage-worker/src/render/claim-form.ts. Adding/removing options
 * requires a coordinated edit to BOTH files (the form HTML and this set);
 * the brief calls out its own option list as the source of truth.
 */
const ALLOWED_DAMAGE_TYPES: ReadonlySet<string> = new Set([
  "License Plate",
  "Wiper",
  "Collision",
  "Roof Rack/Roof Accessory",
  "PS Mirror",
  "DS Mirror",
  "Window",
  "Paint Damage",
  "Rims",
  "Tires",
  "Other"
]);

// Feature 4 — vehicle condition allow-list. Required at submission; the
// claim form renders these as a fixed dropdown and the worker re-validates.
const ALLOWED_VEHICLE_CONDITIONS: ReadonlySet<string> = new Set([
  "Poor",
  "Fair",
  "Good",
  "Excellent"
]);

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/+/, "");
    const parts = path.split("/").filter(Boolean);
    const method = request.method;

    try {
      /* ============================================================
       * Public APIs — no auth gate
       * ============================================================ */

      if (path === "claims-api/submit-claim" && method === "POST") {
        return handleClaimSubmission(request, env, ctx);
      }

      // Brief 146 — out-of-band per-photo upload for the customer claim
      // form. Public (same posture as /claims-api/submit-claim); client
      // pays the upload cost upfront on file-pick so the final submit is
      // a tiny JSON POST that survives flaky cellular.
      if (path === "claims-api/upload" && method === "POST") {
        return handleClaimPhotoUpload(request, env);
      }

      if (parts[0] === "claims-api" && parts[1] === "photo" && parts.length >= 3 && method === "GET") {
        const photoKey = parts.slice(2).join("/");
        // Public read of customer photos. Legacy/damagemanager.js:5666 has
        // no auth check here; preserved. R2 keys include a 4-char random
        // suffix in the claim_id (e.g., BIN-20260502-143055-AB12) which
        // provides obscurity but not real access control. If this becomes
        // a concern, add auth-gating in a follow-up.
        //
        // Brief 146 — also handle the new `claim-uploads/{pendingId}/...`
        // prefix. serveClaimPhoto prepends `claims/` before lookup, which
        // is correct for the legacy key shape but wrong for the new
        // OOB-upload prefix. Detect the prefix and serve directly.
        if (photoKey.startsWith("claim-uploads/")) {
          return serveR2KeyDirect(env.R2_BUCKET, photoKey, env.IMAGES);
        }
        return serveClaimPhoto(env.R2_BUCKET, photoKey, env.IMAGES);
      }

      // GET /claims-api/summary/{claimId} — stream the auto-generated
      // claim summary PDF (Brief 32). No auth gate, mirroring the photo-
      // serving security posture. The URL is unguessable enough (random
      // 4-char suffix in claim_id) and is shared with the customer via
      // PA email + the post-submit outcome card.
      if (
        parts[0] === "claims-api" &&
        parts[1] === "summary" &&
        parts.length === 3 &&
        parts[2] &&
        method === "GET"
      ) {
        return handleServeClaimSummary(env, decodeURIComponent(parts[2]));
      }

      // GET /claims/{slug} — render the public customer claim form.
      // GET /claims/{slug}/thanks — render the post-submit confirmation.
      // Both public; no auth gate. Source: legacy/damagemanager.js:55-60
      // (rendering) ported in Brief 23.
      if (parts[0] === "claims" && parts.length === 2 && parts[1] && method === "GET") {
        return handleRenderClaimForm(env, decodeURIComponent(parts[1]), url);
      }
      if (
        parts[0] === "claims" &&
        parts.length === 3 &&
        parts[1] &&
        parts[2] === "thanks" &&
        method === "GET"
      ) {
        return handleRenderThanks(env, decodeURIComponent(parts[1]), url);
      }

      /* ============================================================
       * Auth-gated APIs under /manage/api/*
       * Single gate at the top, then dispatch on the rest of the path.
       * ============================================================ */

      if (parts[0] === "manage" && parts[1] === "api") {
        // Two-step gate: authenticate, then check tool access.
        const auth = await authenticate(request, env);
        if (auth.status !== "authenticated") return jsonError(401, "unauthorized");
        if (!checkToolAccess(auth.session, "claims")) return jsonError(403, "forbidden");

        return dispatchManageApi(request, env, auth.session, parts.slice(2), method, ctx);
      }

      return new Response("Not found", { status: 404 });
    } catch (err) {
      console.error("damage-worker request failed:", path, err);
      return jsonError(500, err instanceof Error ? err.message : "server error");
    }
  },

  // Brief 65 — daily open-claims summary cron. Wrangler trigger
  // `0 13 * * *` (13:00 UTC = 8 AM ET) fires this handler once a day. See
  // runDailySummaryCron below for the per-recipient digest pipeline.
  //
  // Brief 146 — same cron also runs the claim-uploads orphan sweep. Both
  // passes are independent; the summary pass doesn't depend on the upload
  // sweep finishing. Sequencing the sweep AFTER the summary makes the
  // summary fire-and-forget — even if upload cleanup runs long, the digest
  // emails have already gone out.
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runDailySummaryCron(env));
    ctx.waitUntil(runClaimUploadsCleanup(env).then(() => undefined));
  }
} satisfies ExportedHandler<Env>;

/**
 * Dispatch /manage/api/* requests to handlers. `subParts` is the path
 * AFTER stripping `manage/api/`, e.g. for `/manage/api/claim/{id}/note` →
 * `["claim", "{id}", "note"]`.
 */
async function dispatchManageApi(
  request: Request,
  env: Env,
  session: Session,
  subParts: string[],
  method: string,
  ctx: ExecutionContext
): Promise<Response> {
  // GET /manage/api/claims — list claims, dc_role-scoped.
  if (subParts.length === 1 && subParts[0] === "claims" && method === "GET") {
    return getClaimsList(env, session, new URL(request.url));
  }

  // Brief 172 — GET /manage/api/claims.csv — CSV export of the same
  // filter surface. dc_role-scoped via the same resolver. 10000-row
  // safety cap; RFC-4180 quoting; Content-Disposition: attachment.
  if (subParts.length === 1 && subParts[0] === "claims.csv" && method === "GET") {
    return getClaimsCsv(env, session, new URL(request.url));
  }

  // Brief 59 — GET /manage/api/contact-roster?role=regional_director|regional_manager
  if (
    subParts.length === 1 &&
    subParts[0] === "contact-roster" &&
    method === "GET"
  ) {
    return getContactRoster(env, session, new URL(request.url));
  }

  // Brief 59 — GET /manage/api/reporting?...
  if (subParts.length === 1 && subParts[0] === "reporting" && method === "GET") {
    return getReporting(env, session, new URL(request.url));
  }

  // /manage/api/claim/{id}/...
  if (subParts[0] === "claim" && subParts[1]) {
    const claimId = decodeURIComponent(subParts[1]);
    const tail = subParts.slice(2);

    // GET /manage/api/claim/{id} — full detail with photos + activity.
    if (tail.length === 0 && method === "GET") {
      return getClaimDetail(env, session, claimId);
    }

    if (tail.length === 1) {
      const action = tail[0];
      if (action === "note" && method === "POST") {
        return handleAddNote(request, env, session, claimId, ctx);
      }
      if (action === "transition" && method === "POST") {
        return handleStatusTransition(request, env, session, claimId, ctx);
      }
      if (action === "document" && method === "POST") {
        return handleDocumentUpload(request, env, session, claimId);
      }
      // Brief 172 — set / clear the cause/fault-attribution field. Any
      // damage role with the claim in scope can set it. Tolerant of the
      // D1 column being absent during the post-deploy migration window.
      if (action === "fault-category" && method === "POST") {
        return handleSetFaultCategory(request, env, session, claimId);
      }
      // Super-admin hard delete. `purge-preview` (GET) reports the blast
      // radius — every D1 row and R2 object the purge would remove — so
      // the operator confirms against real counts. `purge` (POST) performs
      // the irreversible delete. Both re-gate on dcRole === "super_admin"
      // inside the handler (the /manage/api gate only proves "claims"
      // access; delete-everything is a strictly higher bar).
      if (action === "purge-preview" && method === "GET") {
        return handleClaimPurgePreview(env, session, claimId);
      }
      if (action === "purge" && method === "POST") {
        return handleClaimPurge(request, env, session, claimId);
      }
    }

    // /manage/api/claim/{id}/document/{docId}/{action}
    if (tail[0] === "document" && tail[1] && tail.length === 3) {
      const docId = decodeURIComponent(tail[1]);
      const action = tail[2];
      if (action === "delete" && method === "POST") {
        return handleDocumentDelete(request, env, session, claimId, docId);
      }
      if (action === "edit" && method === "POST") {
        return handleDocumentEdit(request, env, session, claimId, docId);
      }
    }

    // /manage/api/claim/{id}/quote/{quoteId}/preview-check-request.pdf
    if (
      tail[0] === "quote" &&
      tail[1] &&
      tail[2] === "preview-check-request.pdf" &&
      tail.length === 3 &&
      method === "GET"
    ) {
      const quoteId = decodeURIComponent(tail[1]);
      return handleCheckRequestPreview(env, session, claimId, quoteId);
    }
  }

  return new Response("Not found", { status: 404 });
}

/* ============================================================
 * Public render handlers — Brief 23
 *
 * GET /claims/{slug}             → renderClaimForm
 * GET /claims/{slug}/thanks      → renderThanksPage
 *
 * Slug resolves via getActiveLocationByCode(env, slug) — Supabase
 * pricing_simple, post-Brief-33. On miss the worker returns 404 with
 * friendly HTML rather than the bare "Not found" fallback.
 *
 * Bookmarks (per CLAUDE.md): /claims/{location} is load-bearing — saved
 * on hundreds of customer/admin device home screens. Path shape MUST
 * stay /claims/{slug}.
 * ============================================================ */

async function handleRenderClaimForm(
  env: Env,
  slug: string,
  url: URL
): Promise<Response> {
  const location = await getActiveLocationByCode(env, slug);
  if (!location) {
    return htmlResponse(renderClaimNotFound(slug), 404);
  }
  // Optional ?error=... query carries an error message bounced from a
  // failed POST submission (browser path — see handleClaimSubmission's
  // browserMode redirect logic). Cap length so a malicious bounce can't
  // inject a giant banner.
  const errorParam = url.searchParams.get("error");
  const errorMessage = errorParam ? errorParam.slice(0, 240) : null;
  return htmlResponse(
    renderClaimForm({
      locationCode: location.location_code,
      locationPretty: location.location_pretty,
      errorMessage
    })
  );
}

async function handleRenderThanks(
  env: Env,
  slug: string,
  url: URL
): Promise<Response> {
  const location = await getActiveLocationByCode(env, slug);
  if (!location) {
    return htmlResponse(renderClaimNotFound(slug), 404);
  }
  const claimId = url.searchParams.get("id");
  return htmlResponse(
    renderThanksPage({
      locationPretty: location.location_pretty,
      claimId: claimId ? claimId.slice(0, 64) : null
    })
  );
}

/* ============================================================
 * Read handlers (Chunk 2)
 * ============================================================ */

/**
 * Compute the location-code scope for a session's damage reads.
 *
 *   { kind: "global" }                — super_admin / admin: see all claims
 *   { kind: "scoped", codes: [...] }  — gm / rm: restricted to dcLocations
 *   { kind: "denied" }                — no dc_role: 403
 *
 * `codes` may be empty for kind:"scoped" — that means the user IS gm/rm but
 * has no locations assigned, so they should see zero claims (not all of
 * them). Pure data shape so the caller decides response semantics.
 */
type DamageScope =
  | { kind: "global" }
  | { kind: "scoped"; codes: string[] }
  | { kind: "denied" };

function damageScopeForSession(session: Session): DamageScope {
  if (session.dcRole === null) return { kind: "denied" };
  if (session.dcRole === "super_admin" || session.dcRole === "admin") {
    return { kind: "global" };
  }
  // gm / rm — restricted to dcLocations.
  return { kind: "scoped", codes: session.dcLocations };
}

/**
 * GET /manage/api/claims — list claims with dc_role scoping + filters.
 *
 * Query params (matching legacy/damagemanager.js:3318):
 *   search    — substring match on customer_name
 *   location  — single location_code or "All"
 *   status    — full claim_status string or "All"
 *   lifecycle — "Open" | "Closed" | "All"  (default "Open")
 *
 * Brief 59 additions:
 *   regional_director_email — single email; resolved via listContactRoster
 *     to a set of location_codes that gets intersected with the user's
 *     dc_role scope.
 *   regional_manager_email — same pattern for RM.
 *   submitted_from / submitted_to — ISO dates; both inclusive.
 *
 * For gm/rm users, the `location` param is intersected with their
 * dcLocations — out-of-scope filter requests return [] rather than 403,
 * so the existence of locations outside scope isn't leaked.
 */
async function getClaimsList(env: Env, session: Session, url: URL): Promise<Response> {
  const scope = damageScopeForSession(session);
  if (scope.kind === "denied") return jsonError(403, "no damage role assigned");

  const requestedLocation = url.searchParams.get("location") ?? "All";
  const lifecycleParam = url.searchParams.get("lifecycle") ?? "Open";
  const statusParam = url.searchParams.get("status") ?? "All";
  const search = url.searchParams.get("search")?.trim() || undefined;
  const rdEmail = url.searchParams.get("regional_director_email")?.trim().toLowerCase() || null;
  const rmEmail = url.searchParams.get("regional_manager_email")?.trim().toLowerCase() || null;
  const submittedFromParam = url.searchParams.get("submitted_from")?.trim() || null;
  const submittedToParam = url.searchParams.get("submitted_to")?.trim() || null;

  const resolved = await resolveLocationCodesWithFilters(env, scope, {
    requestedLocation,
    rdEmail,
    rmEmail
  });
  if (resolved.kind === "empty") return json([]);

  const filters: ClaimsListFilters = {
    locationCodes: resolved.codes,
    // Brief 172 — accept the new "Awaiting Payment" 3-way bucket
    // alongside the legacy "Open" | "Closed" | "All" values. db-d1's
    // listClaims rewrites the WHERE clause per bucket; stored
    // lifecycle_state stays binary.
    lifecycle: resolveLifecycleParam(lifecycleParam),
    claimStatus: statusParam !== "All" ? (statusParam as ClaimStatus) : undefined,
    search,
    submittedFrom: normalizeSubmittedBound(submittedFromParam, "from"),
    submittedTo: normalizeSubmittedBound(submittedToParam, "to")
  };

  const claims = await listClaims(env.DB, filters);
  return json(claims);
}

/**
 * Brief 172 — validate the `lifecycle` query param. Unknown values fall
 * back to "Open" (the default render bucket); kept tolerant so a typo or
 * legacy bookmark doesn't 400 the list page.
 */
function resolveLifecycleParam(
  raw: string
): LifecycleState | "Awaiting Payment" | "All" {
  if (raw === "Closed" || raw === "All" || raw === "Awaiting Payment") {
    return raw;
  }
  return "Open";
}

/**
 * Brief 59 — resolve the effective `location_codes` filter for a damage
 * read by intersecting (a) the user's dc_role scope, (b) an optional
 * single-location filter, and (c) any RD/RM-email-derived location set.
 *
 *   { kind: "all" }            → no IN-clause; caller passes undefined
 *                                (only valid for global scope).
 *   { kind: "subset", codes }  → caller passes this list as locationCodes.
 *   { kind: "empty" }          → return [] without hitting D1.
 */
type ResolvedCodes =
  | { kind: "all" }
  | { kind: "subset"; codes: string[] }
  | { kind: "empty" };

async function resolveLocationCodesWithFilters(
  env: Env,
  scope: DamageScope,
  args: {
    requestedLocation: string;
    rdEmail: string | null;
    rmEmail: string | null;
  }
): Promise<
  | { kind: "all"; codes?: undefined }
  | { kind: "subset"; codes: string[] }
  | { kind: "empty" }
> {
  if (scope.kind === "denied") return { kind: "empty" };

  // Layer 1 — start with the dc_role scope.
  let working: Set<string> | null = null; // null = "global, no restriction yet"
  if (scope.kind === "scoped") {
    if (scope.codes.length === 0) return { kind: "empty" };
    working = new Set(scope.codes);
  }

  // Layer 2 — single-location filter.
  if (args.requestedLocation && args.requestedLocation !== "All") {
    if (working === null) {
      working = new Set([args.requestedLocation]);
    } else {
      if (!working.has(args.requestedLocation)) return { kind: "empty" };
      working = new Set([args.requestedLocation]);
    }
  }

  // Layer 3 — RD/RM email filters. Resolve each to a set of location_codes
  // and intersect. If both are set the claim must match BOTH (same location
  // must be covered by both the named RD and RM).
  if (args.rdEmail) {
    const set = await resolveRosterCodes(env, "regional_director", args.rdEmail);
    if (set.size === 0) return { kind: "empty" };
    working = working ? intersectSet(working, set) : set;
    if (working.size === 0) return { kind: "empty" };
  }
  if (args.rmEmail) {
    const set = await resolveRosterCodes(env, "regional_manager", args.rmEmail);
    if (set.size === 0) return { kind: "empty" };
    working = working ? intersectSet(working, set) : set;
    if (working.size === 0) return { kind: "empty" };
  }

  if (working === null) return { kind: "all" };
  return { kind: "subset", codes: [...working] };
}

async function resolveRosterCodes(
  env: Env,
  role: "regional_director" | "regional_manager",
  email: string
): Promise<Set<string>> {
  const roster = await listContactRoster(env, role);
  const entry = roster.find((e) => e.email.toLowerCase() === email.toLowerCase());
  return new Set(entry?.location_codes ?? []);
}

function intersectSet(a: Set<string>, b: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const v of a) if (b.has(v)) out.add(v);
  return out;
}

/**
 * Normalize an HTML5-date-style string into an ISO timestamp suitable for
 * `submitted_at >= ?` / `submitted_at <= ?` comparisons. `submitted_at` in
 * D1 is stored as ISO ("YYYY-MM-DD HH:MM:SS" or full "T...Z" form), and
 * lexicographic compare matches chronological compare.
 *
 * - Bare `YYYY-MM-DD`: snap "from" to start-of-day, "to" to end-of-day.
 * - Anything else: pass through (worker-side caller is the only writer;
 *   we trust apps/web's HTML5 date input to produce well-formed strings).
 * - Invalid input (regex miss): undefined → filter skipped.
 */
function normalizeSubmittedBound(
  input: string | null,
  edge: "from" | "to"
): string | undefined {
  if (!input) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    return edge === "from" ? `${input}T00:00:00.000Z` : `${input}T23:59:59.999Z`;
  }
  return input;
}

/**
 * Brief 59 — GET /manage/api/contact-roster?role=regional_director|regional_manager
 *
 * Returns the AM/RM roster (email, name, assigned location_codes), filtered
 * by dc_role scope so a `gm`/`rm` user only sees RDs/RMs who cover at least
 * one of their dcLocations.
 */
async function getContactRoster(env: Env, session: Session, url: URL): Promise<Response> {
  const scope = damageScopeForSession(session);
  if (scope.kind === "denied") return jsonError(403, "no damage role assigned");

  const roleParam = url.searchParams.get("role");
  const role: "regional_director" | "regional_manager" =
    roleParam === "regional_manager" ? "regional_manager" : "regional_director";

  const roster = await listContactRoster(env, role);
  if (scope.kind === "global") return json(roster);

  // scope.kind === "scoped"
  if (scope.codes.length === 0) return json([]);
  const allowed = new Set(scope.codes);
  const filtered: ContactRosterEntry[] = [];
  for (const entry of roster) {
    const codes = entry.location_codes.filter((c) => allowed.has(c));
    if (codes.length === 0) continue;
    filtered.push({ email: entry.email, name: entry.name, location_codes: codes });
  }
  return json(filtered);
}

/* ============================================================
 * Brief 59 — Reporting endpoint
 *
 * GET /manage/api/reporting?location=<code|All>
 *                          &regional_director_email=<email>
 *                          &regional_manager_email=<email>
 *                          &window=current_month|past_month|qtd|past_quarter|ytd
 *
 * Server-side resolves the window relative to "now", then runs a single
 * D1 batch of count + cost aggregates. dc_role scoping applies the same as
 * everywhere else.
 *
 * Brief 67 (2026-05-07) extended the response shape:
 *   - by_location[].avg_days_open: number | null — average age in days of
 *     currently-open claims at that location (NULL when zero open claims).
 *   - by_damage_type_approved[].cost: number — sum of Quote + Receipt
 *     amounts for approved-family claims, grouped by damage_type. Mirrors
 *     the global Repair Cost rollup but split by damage_type.
 *   - by_location_drilldown: 5-bucket per-(location, damage_type) split
 *     (open / denied / approved / closed_approved / closed_other). The
 *     apps/web renderer aggregates `denied + closed_approved + closed_other`
 *     for the operator-facing "Closed" view and `approved + closed_approved`
 *     for the operator-facing "Approved" view, matching the per-location
 *     table's column semantics.
 *
 * Brief 67 also reframes the cost rollup: receipts are paid out, approved
 * quotes are committed; both are real spend, so summing them is the
 * intended behavior (operator confirmed 2026-05-07). The earlier "v2
 * limitation" framing is dropped.
 * ============================================================ */

type ReportingWindow =
  | "current_month"
  | "past_month"
  | "qtd"
  | "past_quarter"
  | "ytd";

const REPORTING_WINDOWS: ReadonlySet<string> = new Set([
  "current_month",
  "past_month",
  "qtd",
  "past_quarter",
  "ytd"
]);

interface ReportingTotals {
  open: number;
  /**
   * Brief 172 — derived bucket. Count of claims whose claim_status is in
   * AWAITING_PAYMENT_STATUSES inside the window+scope. These rows are
   * EXCLUDED from `open` so the three counts don't overlap (open +
   * awaiting_payment + closed = total). `approved` (Approved-family
   * lifetime count) still includes awaiting-payment rows because they
   * ARE approved — different axis.
   */
  awaiting_payment: number;
  closed: number;
  approved: number;
  denied: number;
  repair_cost: number;
}

/**
 * Brief 172 — cause/fault breakdown. One row per category (the three
 * FAULT_CATEGORIES) plus a synthesized `Undetermined` row for
 * `fault_category IS NULL`. Total row count <= 4. Tolerant of the D1
 * column being absent (returns empty array on the `no such column` path).
 */
interface ReportingByFaultCategoryRow {
  fault_category: string;
  count: number;
}

interface ReportingByLocationRow {
  location_code: string;
  location_pretty: string | null;
  open: number;
  /** Brief 172 — derived bucket; carved out of `open`, sits before `closed`. */
  awaiting_payment: number;
  closed: number;
  approved: number;
  denied: number;
  repair_cost: number;
  avg_days_open: number | null;
}

interface ReportingByDamageTypeRow {
  damage_type: string;
  count: number;
}

interface ReportingByDamageTypeApprovedRow {
  damage_type: string;
  count: number;
  cost: number;
}

type ReportingDrilldownBucket =
  | "open"
  | "awaiting_payment"
  | "denied"
  | "approved"
  | "closed_approved"
  | "closed_other";

interface ReportingByLocationDrilldownRow {
  location_code: string;
  location_pretty: string | null;
  outcome_bucket: ReportingDrilldownBucket;
  damage_type: string;
  n: number;
  cost: number;
}

interface ReportingResponse {
  window: ReportingWindow;
  from: string;
  to: string;
  filters: {
    location: string;
    rd_email: string | null;
    rm_email: string | null;
  };
  totals: ReportingTotals;
  by_location: ReportingByLocationRow[];
  by_damage_type_open: ReportingByDamageTypeRow[];
  /** Brief 172 — AP claims carved out of the Open damage-type breakdown. */
  by_damage_type_awaiting_payment: ReportingByDamageTypeRow[];
  by_damage_type_approved: ReportingByDamageTypeApprovedRow[];
  by_damage_type_denied: ReportingByDamageTypeRow[];
  by_location_drilldown: ReportingByLocationDrilldownRow[];
  /** Brief 172 — by-cause/fault-category counts. Empty array when the
   *  D1 fault_category column is absent (pre-migration). */
  by_fault_category: ReportingByFaultCategoryRow[];
}

function resolveReportingWindow(window: ReportingWindow, now: Date): { from: string; to: string } {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth(); // 0-11
  const startOfDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));
  const startOfMonth = (year: number, month: number) => new Date(Date.UTC(year, month, 1, 0, 0, 0, 0));
  const endOfMonth = (year: number, month: number) =>
    new Date(Date.UTC(year, month + 1, 1, 0, 0, 0, 0) - 1);
  const quarterStartMonth = (month: number) => Math.floor(month / 3) * 3;

  if (window === "current_month") {
    return { from: startOfMonth(y, m).toISOString(), to: now.toISOString() };
  }
  if (window === "past_month") {
    const prevMonth = m === 0 ? 11 : m - 1;
    const prevYear = m === 0 ? y - 1 : y;
    return {
      from: startOfMonth(prevYear, prevMonth).toISOString(),
      to: endOfMonth(prevYear, prevMonth).toISOString()
    };
  }
  if (window === "qtd") {
    const qStart = quarterStartMonth(m);
    return { from: startOfMonth(y, qStart).toISOString(), to: now.toISOString() };
  }
  if (window === "past_quarter") {
    const qStart = quarterStartMonth(m);
    const prevQEnd = qStart === 0 ? { year: y - 1, month: 11 } : { year: y, month: qStart - 1 };
    const prevQStartMonth = quarterStartMonth(prevQEnd.month);
    return {
      from: startOfMonth(prevQEnd.year, prevQStartMonth).toISOString(),
      to: endOfMonth(prevQEnd.year, prevQEnd.month).toISOString()
    };
  }
  // ytd
  return { from: startOfMonth(y, 0).toISOString(), to: now.toISOString() };
}

async function getReporting(env: Env, session: Session, url: URL): Promise<Response> {
  const scope = damageScopeForSession(session);
  if (scope.kind === "denied") return jsonError(403, "no damage role assigned");

  const requestedLocation = url.searchParams.get("location") ?? "All";
  const rdEmail = url.searchParams.get("regional_director_email")?.trim().toLowerCase() || null;
  const rmEmail = url.searchParams.get("regional_manager_email")?.trim().toLowerCase() || null;
  const windowParam = url.searchParams.get("window") ?? "qtd";
  const window: ReportingWindow = REPORTING_WINDOWS.has(windowParam)
    ? (windowParam as ReportingWindow)
    : "qtd";

  const { from, to } = resolveReportingWindow(window, new Date());

  const resolved = await resolveLocationCodesWithFilters(env, scope, {
    requestedLocation,
    rdEmail,
    rmEmail
  });

  const filters = {
    location: requestedLocation && requestedLocation !== "All" ? requestedLocation : "All",
    rd_email: rdEmail,
    rm_email: rmEmail
  };

  // For "global + no filters", we still need a finite set of location_codes
  // for the IN clause. Pull the distinct set from the claims table within
  // the window. (Damage-worker has no access to the full Supabase location
  // list here without an extra round-trip; the in-D1 distinct is cheap.)
  let codes: string[];
  if (resolved.kind === "empty") {
    return json(emptyReportingResponse(window, from, to, filters));
  }
  if (resolved.kind === "all") {
    const distinct = await env.DB
      .prepare(
        "SELECT DISTINCT location_code FROM claims WHERE submitted_at BETWEEN ?1 AND ?2 AND deleted_at IS NULL"
      )
      .bind(from, to)
      .all<{ location_code: string }>();
    codes = (distinct.results ?? []).map((r) => r.location_code).filter((c): c is string => !!c);
    if (codes.length === 0) {
      return json(emptyReportingResponse(window, from, to, filters));
    }
  } else {
    codes = resolved.codes;
  }

  const inPlaceholders = codes.map((_, i) => `?${i + 3}`).join(",");
  const baseBindings: unknown[] = [from, to, ...codes];

  // Brief 172 — totals bucketing uses a 3-way CASE so awaiting-payment
  // claims drop out of `open`. The CASE evaluates top-down: closed-status
  // rows go to 'closed' first, then awaiting-payment claim_statuses go to
  // 'awaiting_payment', then anything still with stored lifecycle_state =
  // 'Open' goes to 'open'. Rows whose stored lifecycle is already
  // 'Closed' (CASE branch 1) never reach the awaiting-payment branch.
  // AP claim_status placeholders — bound after baseBindings (from, to, codes)
  // on every statement that carves out or targets the Awaiting Payment bucket.
  const apPlaceholders = AWAITING_PAYMENT_STATUSES.map(
    (_, i) => `?${i + 3 + codes.length}`
  ).join(",");
  const lifecycleSql = `
    SELECT
      CASE
        WHEN lifecycle_state = 'Closed' THEN 'closed'
        WHEN claim_status IN (${apPlaceholders}) THEN 'awaiting_payment'
        WHEN lifecycle_state = 'Open' THEN 'open'
        ELSE 'open'
      END AS bucket,
      COUNT(*) AS n
    FROM claims
    WHERE submitted_at BETWEEN ?1 AND ?2
      AND location_code IN (${inPlaceholders})
      AND deleted_at IS NULL
    GROUP BY bucket
  `;
  const approvedSql = `
    SELECT COUNT(*) AS n
    FROM claims
    WHERE submitted_at BETWEEN ?1 AND ?2
      AND location_code IN (${inPlaceholders})
      AND deleted_at IS NULL
      AND (
        claim_status LIKE 'Approved —%'
        OR claim_status = 'Closed — Paid'
        OR claim_status = 'Closed — Approved/No Response'
      )
  `;
  const deniedSql = `
    SELECT COUNT(*) AS n
    FROM claims
    WHERE submitted_at BETWEEN ?1 AND ?2
      AND location_code IN (${inPlaceholders})
      AND deleted_at IS NULL
      AND claim_status = 'Closed — Denied'
  `;
  const costSql = `
    SELECT COALESCE(SUM(cp.amount), 0) AS cost
    FROM claim_photos cp
    JOIN claims c ON c.claim_id = cp.claim_id
    WHERE c.submitted_at BETWEEN ?1 AND ?2
      AND c.location_code IN (${inPlaceholders})
      AND c.deleted_at IS NULL
      AND cp.deleted_at IS NULL
      AND cp.photo_type IN ('Quote', 'Receipt')
      AND cp.amount IS NOT NULL
      AND (
        c.claim_status LIKE 'Approved —%'
        OR c.claim_status = 'Closed — Paid'
        OR c.claim_status = 'Closed — Approved/No Response'
      )
  `;
  // Brief 172 — per-location lifecycle counts use the same 3-way derived
  // bucket as the KPI totals (Closed / Awaiting Payment / Open), so AP claims
  // are carved out of Open here too.
  const byLocationSql = `
    SELECT location_code,
           MAX(location_pretty) AS location_pretty,
           CASE
             WHEN lifecycle_state = 'Closed' THEN 'closed'
             WHEN claim_status IN (${apPlaceholders}) THEN 'awaiting_payment'
             ELSE 'open'
           END AS bucket,
           COUNT(*) AS n
    FROM claims
    WHERE submitted_at BETWEEN ?1 AND ?2
      AND location_code IN (${inPlaceholders})
      AND deleted_at IS NULL
    GROUP BY location_code, bucket
    ORDER BY location_code
  `;
  const byLocationApprovedSql = `
    SELECT location_code, COUNT(*) AS n
    FROM claims
    WHERE submitted_at BETWEEN ?1 AND ?2
      AND location_code IN (${inPlaceholders})
      AND deleted_at IS NULL
      AND (
        claim_status LIKE 'Approved —%'
        OR claim_status = 'Closed — Paid'
        OR claim_status = 'Closed — Approved/No Response'
      )
    GROUP BY location_code
  `;
  const byLocationDeniedSql = `
    SELECT location_code, COUNT(*) AS n
    FROM claims
    WHERE submitted_at BETWEEN ?1 AND ?2
      AND location_code IN (${inPlaceholders})
      AND deleted_at IS NULL
      AND claim_status = 'Closed — Denied'
    GROUP BY location_code
  `;
  const byLocationCostSql = `
    SELECT c.location_code, COALESCE(SUM(cp.amount), 0) AS cost
    FROM claim_photos cp
    JOIN claims c ON c.claim_id = cp.claim_id
    WHERE c.submitted_at BETWEEN ?1 AND ?2
      AND c.location_code IN (${inPlaceholders})
      AND c.deleted_at IS NULL
      AND cp.deleted_at IS NULL
      AND cp.photo_type IN ('Quote', 'Receipt')
      AND cp.amount IS NOT NULL
      AND (
        c.claim_status LIKE 'Approved —%'
        OR c.claim_status = 'Closed — Paid'
        OR c.claim_status = 'Closed — Approved/No Response'
      )
    GROUP BY c.location_code
  `;
  // Brief 172 — Open damage-type breakdown excludes AP claims (they get their
  // own card below), matching the carve-out applied to the Open KPI/column.
  const byDamageTypeOpenSql = `
    SELECT COALESCE(damage_type, '(none)') AS damage_type, COUNT(*) AS n
    FROM claims
    WHERE submitted_at BETWEEN ?1 AND ?2
      AND location_code IN (${inPlaceholders})
      AND deleted_at IS NULL
      AND lifecycle_state = 'Open'
      AND claim_status NOT IN (${apPlaceholders})
    GROUP BY damage_type
    ORDER BY n DESC
  `;
  const byDamageTypeAwaitingPaymentSql = `
    SELECT COALESCE(damage_type, '(none)') AS damage_type, COUNT(*) AS n
    FROM claims
    WHERE submitted_at BETWEEN ?1 AND ?2
      AND location_code IN (${inPlaceholders})
      AND deleted_at IS NULL
      AND claim_status IN (${apPlaceholders})
    GROUP BY damage_type
    ORDER BY n DESC
  `;
  // Brief 67: by_damage_type_approved gains a `cost` column. LEFT JOIN
  // claim_photos so claims without any photos still surface with cost = 0;
  // COUNT(DISTINCT claim_id) because the join multiplies rows when a claim
  // has multiple photos. cp.deleted_at goes in the JOIN clause to preserve
  // LEFT JOIN semantics on photo-less claims.
  const byDamageTypeApprovedSql = `
    SELECT
      COALESCE(c.damage_type, '(none)') AS damage_type,
      COUNT(DISTINCT c.claim_id) AS n,
      COALESCE(
        SUM(CASE WHEN cp.photo_type IN ('Quote', 'Receipt')
                 AND cp.amount IS NOT NULL
                 THEN cp.amount END),
        0
      ) AS cost
    FROM claims c
    LEFT JOIN claim_photos cp ON cp.claim_id = c.claim_id AND cp.deleted_at IS NULL
    WHERE c.submitted_at BETWEEN ?1 AND ?2
      AND c.location_code IN (${inPlaceholders})
      AND c.deleted_at IS NULL
      AND (
        c.claim_status LIKE 'Approved —%'
        OR c.claim_status = 'Closed — Paid'
        OR c.claim_status = 'Closed — Approved/No Response'
      )
    GROUP BY c.damage_type
    ORDER BY n DESC
  `;
  const byDamageTypeDeniedSql = `
    SELECT COALESCE(damage_type, '(none)') AS damage_type, COUNT(*) AS n
    FROM claims
    WHERE submitted_at BETWEEN ?1 AND ?2
      AND location_code IN (${inPlaceholders})
      AND deleted_at IS NULL
      AND claim_status = 'Closed — Denied'
    GROUP BY damage_type
    ORDER BY n DESC
  `;
  // Brief 67: per-location avg age (in days) of currently-open claims.
  // `julianday('now') - julianday(submitted_at)` works under D1's SQLite.
  // Locations with zero open claims simply produce no row; the apps/web
  // renderer surfaces missing rows as `—`.
  const byLocationAvgDaysOpenSql = `
    SELECT location_code,
           AVG(julianday('now') - julianday(submitted_at)) AS avg_days_open
    FROM claims
    WHERE submitted_at BETWEEN ?1 AND ?2
      AND location_code IN (${inPlaceholders})
      AND deleted_at IS NULL
      AND lifecycle_state = 'Open'
      AND claim_status NOT IN (${apPlaceholders})
    GROUP BY location_code
  `;
  // Brief 67: per-location drill-down — one row per
  // (location_code, outcome_bucket, damage_type) for the entire window.
  // 5-bucket split lets the renderer aggregate to the operator's
  // "Closed" view (`denied + closed_approved + closed_other`) and
  // "Approved" view (`approved + closed_approved`, matching the
  // per-location Approved column's claim_status filter).
  const byLocationDrilldownSql = `
    SELECT
      c.location_code,
      MAX(c.location_pretty) AS location_pretty,
      CASE
        WHEN c.claim_status IN (${apPlaceholders}) THEN 'awaiting_payment'
        WHEN c.lifecycle_state = 'Open' THEN 'open'
        WHEN c.claim_status = 'Closed — Denied' THEN 'denied'
        WHEN c.claim_status LIKE 'Approved —%' THEN 'approved'
        WHEN c.claim_status IN ('Closed — Paid', 'Closed — Approved/No Response') THEN 'closed_approved'
        ELSE 'closed_other'
      END AS outcome_bucket,
      COALESCE(c.damage_type, '(none)') AS damage_type,
      COUNT(DISTINCT c.claim_id) AS n,
      COALESCE(
        SUM(CASE WHEN cp.photo_type IN ('Quote', 'Receipt')
                 AND cp.amount IS NOT NULL
                 THEN cp.amount END),
        0
      ) AS cost
    FROM claims c
    LEFT JOIN claim_photos cp ON cp.claim_id = c.claim_id AND cp.deleted_at IS NULL
    WHERE c.submitted_at BETWEEN ?1 AND ?2
      AND c.location_code IN (${inPlaceholders})
      AND c.deleted_at IS NULL
    GROUP BY c.location_code, outcome_bucket, c.damage_type
    ORDER BY c.location_code, outcome_bucket, n DESC
  `;

  const stmts = [
    // Brief 172 — statements that reference the AP claim_status list append
    // ...AWAITING_PAYMENT_STATUSES after baseBindings (placeholders are ?N
    // where N starts at 3+codes.length, see apPlaceholders above).
    env.DB.prepare(lifecycleSql).bind(...baseBindings, ...AWAITING_PAYMENT_STATUSES),
    env.DB.prepare(approvedSql).bind(...baseBindings),
    env.DB.prepare(deniedSql).bind(...baseBindings),
    env.DB.prepare(costSql).bind(...baseBindings),
    env.DB.prepare(byLocationSql).bind(...baseBindings, ...AWAITING_PAYMENT_STATUSES),
    env.DB.prepare(byLocationApprovedSql).bind(...baseBindings),
    env.DB.prepare(byLocationDeniedSql).bind(...baseBindings),
    env.DB.prepare(byLocationCostSql).bind(...baseBindings),
    env.DB.prepare(byDamageTypeOpenSql).bind(...baseBindings, ...AWAITING_PAYMENT_STATUSES),
    env.DB.prepare(byDamageTypeApprovedSql).bind(...baseBindings),
    env.DB.prepare(byDamageTypeDeniedSql).bind(...baseBindings),
    env.DB.prepare(byLocationAvgDaysOpenSql).bind(...baseBindings, ...AWAITING_PAYMENT_STATUSES),
    env.DB.prepare(byLocationDrilldownSql).bind(...baseBindings, ...AWAITING_PAYMENT_STATUSES),
    env.DB
      .prepare(byDamageTypeAwaitingPaymentSql)
      .bind(...baseBindings, ...AWAITING_PAYMENT_STATUSES)
  ];
  const batchResult = await env.DB.batch(stmts);
  const lifecycleRes = batchResult[0];
  const approvedRes = batchResult[1];
  const deniedRes = batchResult[2];
  const costRes = batchResult[3];
  const byLocationRes = batchResult[4];
  const byLocationApprovedRes = batchResult[5];
  const byLocationDeniedRes = batchResult[6];
  const byLocationCostRes = batchResult[7];
  const byDamageOpenRes = batchResult[8];
  const byDamageAwaitingPaymentRes = batchResult[13];
  const byDamageApprovedRes = batchResult[9];
  const byDamageDeniedRes = batchResult[10];
  const byLocationAvgDaysOpenRes = batchResult[11];
  const byLocationDrilldownRes = batchResult[12];

  // Brief 172 — fault-category breakdown runs separately so a missing
  // fault_category column doesn't fail the whole batch. Tolerant of the
  // `no such column.*fault_category` error (pre-migration window):
  // catches and returns an empty array so the rest of the report renders
  // normally. Mirrors Brief 138/140's idempotency-key column-missing
  // tolerance pattern.
  const byFaultCategoryRows = await readByFaultCategory(
    env.DB,
    from,
    to,
    codes
  );

  const lifecycleRows = (lifecycleRes?.results ?? []) as Array<{
    bucket: string;
    n: number;
  }>;
  let totalsOpen = 0;
  let totalsAwaitingPayment = 0;
  let totalsClosed = 0;
  for (const r of lifecycleRows) {
    const count = Number(r.n) || 0;
    if (r.bucket === "open") totalsOpen = count;
    else if (r.bucket === "awaiting_payment") totalsAwaitingPayment = count;
    else if (r.bucket === "closed") totalsClosed = count;
  }

  const approvedTotal = Number((approvedRes?.results?.[0] as { n?: number } | undefined)?.n ?? 0);
  const deniedTotal = Number((deniedRes?.results?.[0] as { n?: number } | undefined)?.n ?? 0);
  const costTotal = Number((costRes?.results?.[0] as { cost?: number } | undefined)?.cost ?? 0);

  // Pivot per-location 3-way bucket rows (open / awaiting_payment / closed)
  // into one row per location.
  const perLoc = new Map<string, ReportingByLocationRow>();
  for (const r of (byLocationRes?.results ?? []) as Array<{
    location_code: string;
    location_pretty: string | null;
    bucket: string;
    n: number;
  }>) {
    let row = perLoc.get(r.location_code);
    if (!row) {
      row = {
        location_code: r.location_code,
        location_pretty: r.location_pretty ?? null,
        open: 0,
        awaiting_payment: 0,
        closed: 0,
        approved: 0,
        denied: 0,
        repair_cost: 0,
        avg_days_open: null
      };
      perLoc.set(r.location_code, row);
    }
    if (r.bucket === "open") row.open = Number(r.n) || 0;
    else if (r.bucket === "awaiting_payment") {
      row.awaiting_payment = Number(r.n) || 0;
    } else if (r.bucket === "closed") row.closed = Number(r.n) || 0;
  }
  for (const r of (byLocationApprovedRes?.results ?? []) as Array<{
    location_code: string;
    n: number;
  }>) {
    const row = perLoc.get(r.location_code);
    if (row) row.approved = Number(r.n) || 0;
  }
  for (const r of (byLocationDeniedRes?.results ?? []) as Array<{
    location_code: string;
    n: number;
  }>) {
    const row = perLoc.get(r.location_code);
    if (row) row.denied = Number(r.n) || 0;
  }
  for (const r of (byLocationCostRes?.results ?? []) as Array<{
    location_code: string;
    cost: number;
  }>) {
    const row = perLoc.get(r.location_code);
    if (row) row.repair_cost = Number(r.cost) || 0;
  }
  for (const r of (byLocationAvgDaysOpenRes?.results ?? []) as Array<{
    location_code: string;
    avg_days_open: number | null;
  }>) {
    const row = perLoc.get(r.location_code);
    if (row) {
      const v = r.avg_days_open;
      row.avg_days_open = v === null || v === undefined ? null : Number(v);
    }
  }
  const byLocation = [...perLoc.values()].sort((a, b) =>
    (a.location_pretty ?? a.location_code).localeCompare(
      b.location_pretty ?? b.location_code
    )
  );

  const byDamageOpen = ((byDamageOpenRes?.results ?? []) as Array<{
    damage_type: string;
    n: number;
  }>).map((r) => ({ damage_type: r.damage_type, count: Number(r.n) || 0 }));
  const byDamageAwaitingPayment = ((byDamageAwaitingPaymentRes?.results ?? []) as Array<{
    damage_type: string;
    n: number;
  }>).map((r) => ({ damage_type: r.damage_type, count: Number(r.n) || 0 }));
  const byDamageApproved: ReportingByDamageTypeApprovedRow[] = ((byDamageApprovedRes?.results ?? []) as Array<{
    damage_type: string;
    n: number;
    cost: number;
  }>).map((r) => ({
    damage_type: r.damage_type,
    count: Number(r.n) || 0,
    cost: Number(r.cost) || 0
  }));
  const byDamageDenied = ((byDamageDeniedRes?.results ?? []) as Array<{
    damage_type: string;
    n: number;
  }>).map((r) => ({ damage_type: r.damage_type, count: Number(r.n) || 0 }));

  const DRILLDOWN_BUCKETS: ReadonlySet<ReportingDrilldownBucket> = new Set([
    "open",
    "awaiting_payment",
    "denied",
    "approved",
    "closed_approved",
    "closed_other"
  ]);
  const byLocationDrilldown: ReportingByLocationDrilldownRow[] = (
    (byLocationDrilldownRes?.results ?? []) as Array<{
      location_code: string;
      location_pretty: string | null;
      outcome_bucket: string;
      damage_type: string;
      n: number;
      cost: number;
    }>
  )
    .filter((r): r is typeof r & { outcome_bucket: ReportingDrilldownBucket } =>
      DRILLDOWN_BUCKETS.has(r.outcome_bucket as ReportingDrilldownBucket)
    )
    .map((r) => ({
      location_code: r.location_code,
      location_pretty: r.location_pretty ?? null,
      outcome_bucket: r.outcome_bucket,
      damage_type: r.damage_type,
      n: Number(r.n) || 0,
      cost: Number(r.cost) || 0
    }));

  const response: ReportingResponse = {
    window,
    from,
    to,
    filters,
    totals: {
      open: totalsOpen,
      awaiting_payment: totalsAwaitingPayment,
      closed: totalsClosed,
      approved: approvedTotal,
      denied: deniedTotal,
      repair_cost: costTotal
    },
    by_location: byLocation,
    by_damage_type_open: byDamageOpen,
    by_damage_type_awaiting_payment: byDamageAwaitingPayment,
    by_damage_type_approved: byDamageApproved,
    by_damage_type_denied: byDamageDenied,
    by_location_drilldown: byLocationDrilldown,
    by_fault_category: byFaultCategoryRows
  };
  return json(response);
}

/**
 * Brief 172 — by-fault-category counts. Separate query rather than
 * folded into the batch so the column-missing tolerance can swallow the
 * specific error without taking down the rest of the report. Pre-
 * migration callers get `by_fault_category: []` and apps/web renders
 * "(none)" gracefully.
 */
async function readByFaultCategory(
  db: D1Database,
  from: string,
  to: string,
  codes: string[]
): Promise<ReportingByFaultCategoryRow[]> {
  const inPlaceholders = codes.map((_, i) => `?${i + 3}`).join(",");
  const sql = `
    SELECT COALESCE(fault_category, 'Undetermined') AS fault_category,
           COUNT(*) AS n
    FROM claims
    WHERE submitted_at BETWEEN ?1 AND ?2
      AND location_code IN (${inPlaceholders})
      AND deleted_at IS NULL
    GROUP BY 1
    ORDER BY n DESC
  `;
  try {
    const res = await db.prepare(sql).bind(from, to, ...codes).all<{
      fault_category: string;
      n: number;
    }>();
    return (res.results ?? []).map((r) => ({
      fault_category: r.fault_category,
      count: Number(r.n) || 0
    }));
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (/no such column.*fault_category/i.test(errMsg)) {
      console.warn(
        "[reporting.fault-category] column missing — returning empty array (apply schema migration)"
      );
      return [];
    }
    throw err;
  }
}

function emptyReportingResponse(
  window: ReportingWindow,
  from: string,
  to: string,
  filters: ReportingResponse["filters"]
): ReportingResponse {
  return {
    window,
    from,
    to,
    filters,
    totals: {
      open: 0,
      awaiting_payment: 0,
      closed: 0,
      approved: 0,
      denied: 0,
      repair_cost: 0
    },
    by_location: [],
    by_damage_type_open: [],
    by_damage_type_awaiting_payment: [],
    by_damage_type_approved: [],
    by_damage_type_denied: [],
    by_location_drilldown: [],
    by_fault_category: []
  };
}

/**
 * GET /manage/api/claim/{id} — full detail (claim row + photos + activity).
 *
 * Returns 404 (not 403) when the claim exists but is outside the user's
 * dc_role scope, so the existence of out-of-scope claim_ids isn't leaked.
 */
async function getClaimDetail(env: Env, session: Session, claimId: string): Promise<Response> {
  const scope = damageScopeForSession(session);
  if (scope.kind === "denied") return jsonError(403, "no damage role assigned");

  const claim = await getClaimById(env.DB, claimId);
  if (!claim) return jsonError(404, "not found");

  // Scope check — non-global users must have the claim's location in scope.
  if (scope.kind === "scoped" && !scope.codes.includes(claim.location_code)) {
    return jsonError(404, "not found");
  }

  // Photos + activity in parallel — neither references the other.
  const [photos, activity] = await Promise.all([
    listPhotosForClaim(env.DB, claimId),
    listActivityForClaim(env.DB, claimId)
  ]);

  // Brief 172 — getClaimById is `SELECT *`, which pre-migration returns
  // rows without a `fault_category` key. Normalize to null so apps/web's
  // ClaimRow consumers always see the field even before the operator
  // runs the ALTER TABLE.
  const claimWithFault = {
    ...claim,
    fault_category:
      (claim as ClaimRow).fault_category === undefined
        ? null
        : (claim as ClaimRow).fault_category
  };

  return json({ claim: claimWithFault, photos, activity });
}

/* ============================================================
 * Brief 172 — CSV export
 *
 * GET /manage/api/claims.csv — same filter surface + dc_role scoping as
 * /manage/api/claims, but emits a CSV with broader columns (incl.
 * customer phone/email, full vehicle, license_plate, damage_type +
 * damage_other, fault_category, the DERIVED 3-way lifecycle, audit
 * timestamps, age_days). 10000-row safety cap; RFC-4180 quoted; pre-
 * migration fault_category column is tolerated.
 * ============================================================ */

/** Hard ceiling matched to fleet/signups/jotform CSV endpoints. */
const CLAIMS_CSV_MAX_ROWS = 10_000;

/** Columns shipped in the CSV export (Brief 172). Listed once so the
 *  header row and the per-row writer stay in sync. */
const CLAIMS_CSV_COLUMNS = [
  "claim_id",
  "location_code",
  "location_pretty",
  "customer_name",
  "customer_phone",
  "customer_email",
  "vehicle_year",
  "vehicle_make",
  "vehicle_model",
  "vehicle_color",
  "license_plate",
  "damage_type",
  "damage_other",
  "fault_category",
  "claim_status",
  "lifecycle",
  "submitted_at",
  "incident_date",
  "status_updated_at",
  "age_days"
] as const;

interface ClaimsCsvRow {
  claim_id: string;
  location_code: string;
  location_pretty: string;
  customer_name: string;
  customer_phone: string | null;
  customer_email: string | null;
  vehicle_year: number | null;
  vehicle_make: string | null;
  vehicle_model: string | null;
  vehicle_color: string | null;
  license_plate: string | null;
  damage_type: string | null;
  damage_other: string | null;
  fault_category: string | null;
  claim_status: ClaimStatus;
  submitted_at: string;
  incident_date: string | null;
  status_updated_at: string | null;
  age_days: number | null;
}

async function getClaimsCsv(env: Env, session: Session, url: URL): Promise<Response> {
  const scope = damageScopeForSession(session);
  if (scope.kind === "denied") return jsonError(403, "no damage role assigned");

  const requestedLocation = url.searchParams.get("location") ?? "All";
  const lifecycleParam = url.searchParams.get("lifecycle") ?? "Open";
  const statusParam = url.searchParams.get("status") ?? "All";
  const search = url.searchParams.get("search")?.trim() || undefined;
  const rdEmail = url.searchParams.get("regional_director_email")?.trim().toLowerCase() || null;
  const rmEmail = url.searchParams.get("regional_manager_email")?.trim().toLowerCase() || null;
  const submittedFromParam = url.searchParams.get("submitted_from")?.trim() || null;
  const submittedToParam = url.searchParams.get("submitted_to")?.trim() || null;

  const resolved = await resolveLocationCodesWithFilters(env, scope, {
    requestedLocation,
    rdEmail,
    rmEmail
  });
  if (resolved.kind === "empty") {
    return csvResponse(claimsCsvHeader(), claimsCsvFilename());
  }

  // Build the WHERE clause inline — broader column projection than
  // CLAIMS_LIST_COLS so we can ship the customer + audit fields in the
  // export. fault_category wrapped in COALESCE so a row whose value is
  // NULL produces an empty cell rather than the literal "null" string.
  // The column itself is wrapped in the tolerant query path below.
  const where: string[] = ["deleted_at IS NULL"];
  const params: unknown[] = [];

  if (resolved.kind === "subset") {
    if (resolved.codes.length === 0) {
      return csvResponse(claimsCsvHeader(), claimsCsvFilename());
    }
    const placeholders = resolved.codes.map(() => "?").join(",");
    where.push(`location_code IN (${placeholders})`);
    params.push(...resolved.codes);
  }

  // Brief 172 — Awaiting Payment is derived. Same 3-way bucketing as
  // db-d1's listClaims.
  const lifecycle = resolveLifecycleParam(lifecycleParam);
  if (lifecycle !== "All") {
    const apPlaceholders = AWAITING_PAYMENT_STATUSES.map(() => "?").join(",");
    if (lifecycle === "Open") {
      where.push(
        `lifecycle_state = 'Open' AND claim_status NOT IN (${apPlaceholders})`
      );
      params.push(...AWAITING_PAYMENT_STATUSES);
    } else if (lifecycle === "Awaiting Payment") {
      where.push(`claim_status IN (${apPlaceholders})`);
      params.push(...AWAITING_PAYMENT_STATUSES);
    } else {
      where.push("lifecycle_state = 'Closed'");
    }
  }
  if (statusParam !== "All") {
    where.push("claim_status = ?");
    params.push(statusParam);
  }
  if (search) {
    where.push("customer_name LIKE ?");
    params.push(`%${search}%`);
  }
  const fromIso = normalizeSubmittedBound(submittedFromParam, "from");
  const toIso = normalizeSubmittedBound(submittedToParam, "to");
  if (fromIso) {
    where.push("submitted_at >= ?");
    params.push(fromIso);
  }
  if (toIso) {
    where.push("submitted_at <= ?");
    params.push(toIso);
  }

  // Probe one row past the cap so we can 416 cleanly on overflow.
  const cap = CLAIMS_CSV_MAX_ROWS + 1;
  const projection = `claim_id, location_code, location_pretty, customer_name,
    customer_phone, customer_email, vehicle_year, vehicle_make, vehicle_model,
    vehicle_color, license_plate, damage_type, damage_other,
    {fault_category_expr} AS fault_category,
    claim_status, submitted_at, {incident_date_expr} AS incident_date, status_updated_at,
    CAST((julianday('now') - julianday(submitted_at)) AS INTEGER) AS age_days`;

  // Brief 138/140 — column-missing tolerance. Try with the real columns
  // first; on a "no such column" error for either fault_category or
  // incident_date (both added after existing rows), retry with NULL in
  // their place so the export keeps working pre-migration. Both degrade
  // together — the realistic pre-migration state has neither column.
  const withColumns = (expr: (col: string) => string) =>
    projection
      .replace("{fault_category_expr}", expr("fault_category"))
      .replace("{incident_date_expr}", expr("incident_date"));
  let rows: ClaimsCsvRow[];
  try {
    const sql = `
      SELECT ${withColumns((c) => c)}
      FROM claims
      WHERE ${where.join(" AND ")}
      ORDER BY submitted_at DESC
      LIMIT ${cap}
    `;
    const res = await env.DB.prepare(sql).bind(...params).all<ClaimsCsvRow>();
    rows = res.results ?? [];
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (!/no such column.*(fault_category|incident_date)/i.test(errMsg)) throw err;
    console.warn(
      "[claims.csv] fault_category/incident_date column missing — exporting with empty cell (apply schema migration)"
    );
    const sql = `
      SELECT ${withColumns(() => "NULL")}
      FROM claims
      WHERE ${where.join(" AND ")}
      ORDER BY submitted_at DESC
      LIMIT ${cap}
    `;
    const res = await env.DB.prepare(sql).bind(...params).all<ClaimsCsvRow>();
    rows = res.results ?? [];
  }

  if (rows.length > CLAIMS_CSV_MAX_ROWS) {
    return new Response(
      `Result set exceeds the ${CLAIMS_CSV_MAX_ROWS}-row export cap. Narrow your filters and try again.`,
      { status: 416 }
    );
  }

  const lines: string[] = [claimsCsvHeader()];
  for (const r of rows) {
    const derived = displayLifecycleForStatus(r.claim_status);
    lines.push(
      [
        r.claim_id,
        r.location_code,
        r.location_pretty,
        r.customer_name,
        r.customer_phone ?? "",
        r.customer_email ?? "",
        r.vehicle_year ?? "",
        r.vehicle_make ?? "",
        r.vehicle_model ?? "",
        r.vehicle_color ?? "",
        r.license_plate ?? "",
        r.damage_type ?? "",
        r.damage_other ?? "",
        r.fault_category ?? "",
        r.claim_status,
        derived,
        r.submitted_at,
        r.incident_date ?? "",
        r.status_updated_at ?? "",
        r.age_days ?? ""
      ]
        .map(csvQuote)
        .join(",")
    );
  }
  return csvResponse(lines.join("\r\n"), claimsCsvFilename());
}

function claimsCsvHeader(): string {
  return CLAIMS_CSV_COLUMNS.map(csvQuote).join(",");
}

function claimsCsvFilename(): string {
  const today = new Date().toISOString().slice(0, 10);
  return `damage-claims-${today}.csv`;
}

/**
 * RFC 4180 minimal field quoter. Wraps in double quotes when the value
 * contains a comma, quote, CR, or LF; doubles any embedded quotes.
 * Numbers are stringified verbatim.
 */
function csvQuote(value: unknown): string {
  const s = value === null || value === undefined ? "" : String(value);
  if (s === "") return "";
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function csvResponse(body: string, filename: string): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store"
    }
  });
}

/* ============================================================
 * Brief 172 — POST /manage/api/claim/{id}/fault-category
 *
 * Body: form-encoded `fault_category` field. One of the three
 * FAULT_CATEGORIES values, or empty string → clear (NULL).
 * Gate: any session with dcRole !== null AND claim in scope (no
 * transition-table check — this is a side metadata write, not a
 * state-machine move). Worker re-validates and tolerates the D1
 * column being absent during the post-deploy migration window.
 * ============================================================ */

async function handleSetFaultCategory(
  request: Request,
  env: Env,
  session: Session,
  claimId: string
): Promise<Response> {
  if (!isOriginAllowed(request)) return jsonError(403, "bad origin");

  const guard = await loadAndScopeCheck(env, session, claimId);
  if (!guard.ok) return guard.response;

  // dcRole-null is already rejected by loadAndScopeCheck, but the
  // narrow check is here for defense-in-depth + readable intent.
  if (!session.dcRole) {
    return jsonError(403, "no damage role assigned");
  }

  const form = await readForm(request);
  const raw = (form.get("fault_category") ?? "").toString().trim();
  let next: FaultCategory | null = null;
  if (raw !== "") {
    if (!(FAULT_CATEGORIES as readonly string[]).includes(raw)) {
      return jsonError(
        400,
        `Invalid cause. Must be one of: ${FAULT_CATEGORIES.join(", ")}, or empty to clear.`
      );
    }
    next = raw as FaultCategory;
  }

  const prior = (guard.claim as ClaimRow).fault_category ?? null;
  if (prior === next) {
    return json({ ok: true, fault_category: next, unchanged: true });
  }

  // Tolerant UPDATE — same column-missing posture as Brief 138/140 +
  // the CSV path above. The activity-row insert lives in the same
  // try-block so a column-missing UPDATE doesn't leave a misleading
  // log entry.
  const noteSummary =
    next === null
      ? `[cause] ${session.email} cleared cause (was "${prior ?? "Undetermined"}")`
      : `[cause] ${session.email} set cause to "${next}"${
          prior ? ` (was "${prior}")` : ""
        }`;

  try {
    await env.DB.prepare(
      "UPDATE claims SET fault_category = ?, updated_at = datetime('now') WHERE claim_id = ?"
    )
      .bind(next, claimId)
      .run();
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (/no such column.*fault_category/i.test(errMsg)) {
      console.warn(
        "[claim.fault-category] column missing — soft-success returned (apply schema migration)"
      );
      return json(
        {
          ok: true,
          fault_category: next,
          migration_pending: true,
          message:
            "Cause changes are queued — the operator must run the fault_category D1 migration for changes to persist."
        },
        200
      );
    }
    console.error("handleSetFaultCategory UPDATE failed:", err);
    return jsonError(500, "Failed to update cause.");
  }

  // Activity log is fail-soft (mirrors note + transition handlers).
  try {
    await logActivity(env.DB, {
      claimId,
      activityType: "note",
      notes: noteSummary,
      actorEmail: session.email,
      actorName: session.email
    });
  } catch (logErr) {
    console.error("[claim.fault-category] activity log failed:", logErr);
  }

  return json({ ok: true, fault_category: next });
}

/* ============================================================
 * Write handlers (Chunk 3)
 * ============================================================ */

/**
 * Shared scope-and-existence check for every claim mutation.
 *
 *   - dcRole === null               → 403
 *   - claim doesn't exist           → 404
 *   - claim's location_code outside user's scope (gm/rm only) → 404
 *     (anti-leak: not 403, so out-of-scope ids stay indistinguishable
 *     from non-existent ones)
 *   - otherwise                      → ok with the loaded claim
 *
 * Discriminated union return so call sites get type-narrowed access to
 * either the response or the claim, never both.
 */
type ScopeGuard =
  | { ok: true; claim: ClaimRow }
  | { ok: false; response: Response };

async function loadAndScopeCheck(
  env: Env,
  session: Session,
  claimId: string
): Promise<ScopeGuard> {
  const scope = damageScopeForSession(session);
  if (scope.kind === "denied") {
    return { ok: false, response: jsonError(403, "no damage role assigned") };
  }
  const claim = await getClaimById(env.DB, claimId);
  if (!claim) return { ok: false, response: jsonError(404, "not found") };
  if (scope.kind === "scoped" && !scope.codes.includes(claim.location_code)) {
    return { ok: false, response: jsonError(404, "not found") };
  }
  return { ok: true, claim };
}

/**
 * canMutateDocument — port of legacy/damagemanager.js:2430.
 *
 *   - admin / super_admin: always
 *   - otherwise: only if doc.uploaded_by matches the session's email (case-insensitive)
 */
function canMutateDocument(session: Session, doc: ClaimPhotoRow): boolean {
  if (session.dcRole === "admin" || session.dcRole === "super_admin") return true;
  if (!doc.uploaded_by || !session.email) return false;
  return doc.uploaded_by.toLowerCase() === session.email.toLowerCase();
}

/* ============================================================
 * POST /manage/api/claim/{id}/note
 * ============================================================ */

async function handleAddNote(
  request: Request,
  env: Env,
  session: Session,
  claimId: string,
  ctx: ExecutionContext
): Promise<Response> {
  if (!isOriginAllowed(request)) return jsonError(403, "bad origin");

  const guard = await loadAndScopeCheck(env, session, claimId);
  if (!guard.ok) return guard.response;

  const form = await readForm(request);
  const noteText = (form.get("note") ?? "").trim();
  if (!noteText) return jsonError(400, "Note cannot be empty.");
  if (noteText.length > 5000) return jsonError(400, "Note is too long (max 5000 characters).");

  try {
    await logNote(env.DB, {
      claimId,
      note: noteText,
      actorEmail: session.email,
      actorName: session.email
    });
    await touchClaim(env.DB, claimId);
  } catch (err) {
    console.error("handleAddNote failed:", err);
    return jsonError(500, "Failed to save note.");
  }

  // Brief 101 — fire-and-forget manage-page update notification. Both
  // rm_email and site_email are notified (minus the actor's own email).
  // Fail-soft: helper swallows all errors so the note response is never
  // blocked on the webhook round-trip.
  if (env.CLAIM_UPDATE_WEBHOOK_URL) {
    // Brief 101 fix v2 — AWAIT, not ctx.waitUntil. History: the original
    // bare `void` left a dangling promise that was cancelled before the PA
    // fetch went out (PA showed 0 runs). Switching to ctx.waitUntil made the
    // email send, but broke the caller: apps/web reaches this worker through
    // a service binding, and a callee's waitUntil work is tied to the
    // CALLER's request lifetime — the dangling webhook fetch (up to the PA
    // timeout) held the subrequest open past the response handoff, so
    // apps/web's fetch rejected and the admin UI showed a failure even though
    // the DB batch had committed and the email had sent (operators retried
    // and created duplicate rows). Awaiting completes the notification before
    // the Response returns, exactly like the check-request emails below,
    // which use `await` and never exhibited this. Safe to await: the helper
    // is fully fail-soft (try/catch swallows everything), so it never throws
    // and never blocks the response on an error — it only adds the webhook
    // round-trip to latency, bounded by the 5s timeout in fireClaimUpdateWebhook.
    await notifyClaimUpdate({
      env,
      request,
      changeType: "note",
      claim: guard.claim,
      actorEmail: session.email,
      actorRole: session.dcRole ?? null,
      noteText
    });
  }

  return json({ ok: true });
}

/* ============================================================
 * POST /manage/api/claim/{id}/transition
 *
 * Authorization order (per Josh's directive — drift is a security bug):
 *   a. authenticate              — done at gate
 *   b. checkToolAccess "claims"  — done at gate
 *   c. dcRole !== null           — loadAndScopeCheck "denied" branch
 *   d. claim exists              — loadAndScopeCheck "not found"
 *   e. location in scope         — loadAndScopeCheck (404 anti-leak)
 *   f. transition exists         — findTransition (400)
 *   g. role in allowedRoles      — explicit check (403)
 *   h. requirements satisfied    — note/amount/inputs/quote/receipt (400)
 *   i. THEN the writes
 * ============================================================ */

async function handleStatusTransition(
  request: Request,
  env: Env,
  session: Session,
  claimId: string,
  ctx: ExecutionContext
): Promise<Response> {
  if (!isOriginAllowed(request)) return jsonError(403, "bad origin");

  // c, d, e
  const guard = await loadAndScopeCheck(env, session, claimId);
  if (!guard.ok) return guard.response;
  const { claim } = guard;

  const form = await readForm(request);
  const requestedTo = (form.get("to_status") ?? "").trim() as ClaimStatus;
  const noteText = (form.get("note") ?? "").trim();
  const amountStr = (form.get("approved_amount") ?? "").trim();

  // Brief 43 — equipment-related override (no→yes flip during a GM/RM
  // approval transition into one of the two "active repair" branches).
  // Both fields are optional; when absent, the transition behaves exactly
  // as before.
  const overrideEqRelRaw = (form.get("override_equipment_related") ?? "")
    .toString()
    .trim()
    .toLowerCase();
  const overrideEqPieceRaw = (form.get("override_equipment_piece") ?? "")
    .toString()
    .trim();
  const eqOverrideTargets: ReadonlySet<ClaimStatus> = new Set([
    "Approved — Pending Quotes",
    "Approved — In House — Parts Ordered"
  ]);
  let applyEquipmentOverride = false;
  let overrideEquipmentPiece = "";
  if (overrideEqRelRaw === "yes") {
    if (!eqOverrideTargets.has(requestedTo)) {
      return jsonError(
        400,
        "Equipment override is only valid for active-repair approval transitions."
      );
    }
    if (claim.equipment_related !== 0) {
      return jsonError(
        400,
        "Equipment override only flips no→yes; this claim already has equipment_related=yes."
      );
    }
    if (!overrideEqPieceRaw) {
      return jsonError(
        400,
        "Select an equipment piece when flagging this claim equipment-related."
      );
    }
    if (overrideEqPieceRaw.length > 200) {
      return jsonError(
        400,
        "override_equipment_piece is too long (max 200 characters)."
      );
    }
    applyEquipmentOverride = true;
    overrideEquipmentPiece = overrideEqPieceRaw;
  } else if (overrideEqRelRaw && overrideEqRelRaw !== "no") {
    return jsonError(
      400,
      "override_equipment_related must be 'yes' or 'no' if supplied."
    );
  }
  // For overrideEqRelRaw === "no" (or unset), override_equipment_piece is
  // ignored even if sent — keeps the no-branch a no-op on writes.

  // f. Transition (from, to) exists in table.
  const transition = findTransition(claim.claim_status, requestedTo);
  if (!transition) {
    return jsonError(
      400,
      `Transition from "${claim.claim_status}" to "${requestedTo}" is not defined.`
    );
  }

  // g. session.dcRole in allowedRoles.
  // dcRole is non-null at this point because loadAndScopeCheck rejected null.
  if (!session.dcRole || !transition.allowedRoles.includes(session.dcRole)) {
    return jsonError(
      403,
      `Transition "${claim.claim_status}" → "${requestedTo}" not allowed for role "${session.dcRole}".`
    );
  }

  // h. Requirements.
  if (transition.requiresNote && !noteText) {
    return jsonError(400, "A note is required for this transition.");
  }
  if (noteText.length > 5000) {
    return jsonError(400, "Note is too long (max 5000 characters).");
  }

  let approvedAmount: number | null = null;
  let finalTo: ClaimStatus = transition.to;
  if (transition.requiresAmount) {
    const parsed = Number.parseFloat(amountStr);
    if (Number.isNaN(parsed) || parsed <= 0) {
      return jsonError(400, "A valid approved amount is required.");
    }
    approvedAmount = parsed;
    // CEO routing — vestigial; kept per directive. See transitions.ts.
    if (transition.ceoEligible && approvedAmount > CEO_APPROVAL_THRESHOLD) {
      finalTo = "Approved — Pending CEO Approval";
    }
  }

  // requiresInputs / optionalInputs — captured into the claim row.
  const inputsCollected: Record<string, string> = {};
  for (const fieldName of [...transition.requiresInputs, ...transition.optionalInputs]) {
    const val = (form.get(fieldName) ?? "").trim();
    if (!val) {
      if (transition.requiresInputs.includes(fieldName)) {
        return jsonError(400, `"${fieldName}" is required for this transition.`);
      }
      continue;
    }
    if (val.length > 1000) {
      return jsonError(400, `"${fieldName}" is too long (max 1000 characters).`);
    }
    inputsCollected[fieldName] = val;
  }

  // requiresReceiptOnFile / requiresQuoteSelection need photos.
  let selectedQuoteId: number | null = null;
  let selectedQuote: ClaimPhotoRow | null = null;
  if (transition.requiresReceiptOnFile || transition.requiresQuoteSelection) {
    const photos = await listPhotosForClaim(env.DB, claimId);

    if (transition.requiresReceiptOnFile) {
      const hasReceipt = photos.some((p) => p.photo_type === "Receipt" && !p.deleted_at);
      if (!hasReceipt) {
        return jsonError(400, "Upload a receipt before approving in-house repair.");
      }
    }

    if (transition.requiresQuoteSelection) {
      const qIdStr = (form.get("quote_id") ?? "").trim();
      const qIdNum = Number.parseInt(qIdStr, 10);
      if (!qIdStr || Number.isNaN(qIdNum)) {
        return jsonError(400, "Select a quote to approve.");
      }
      const quote = photos.find(
        (p) => p.id === qIdNum && p.photo_type === "Quote" && !p.deleted_at
      );
      if (!quote) {
        return jsonError(400, "Selected quote was not found on this claim.");
      }
      // Required fields on the quote (legacy:1937).
      const missing: string[] = [];
      if (quote.amount === null || quote.amount === undefined) missing.push("amount");
      if (!quote.pay_to_type) missing.push("pay-to selection");
      if (quote.pay_to_type === "vendor" && !quote.vendor_address) missing.push("vendor address");
      if (missing.length > 0) {
        return jsonError(400, `Selected quote is missing: ${missing.join(", ")}.`);
      }
      selectedQuoteId = qIdNum;
      selectedQuote = quote;
      approvedAmount = quote.amount;
      // CEO auto-routing intentionally NOT applied on the quote-selection
      // path — see legacy:1950 + transitions.ts CEO_APPROVAL_THRESHOLD doc.
    }
  }

  // Feature 2 — $500 approver-note threshold on Submit for Payment.
  //
  // When Incidents clicks Submit for Payment, the value that lands in the
  // check request's "Approval" (approved-by) field and the AP audit trail is
  // computed here from the check request amount (claim.approved_amount, set
  // at the prior RM quote-approval transition):
  //   - >= $500 : the operator MUST hand-enter who approved it + date in the
  //               Note field (e.g. "Dan - 7/10/2026 incidents@splashcarwashes.com").
  //               That note IS the approval attribution.
  //   - <  $500 : no note required; auto-attribute to the acting user with an
  //               "under $500 threshold" marker.
  // Threshold is per check request. paymentApprovalValue flows into the AP
  // PDF Approval field below and is persisted on the activity timeline.
  let paymentApprovalValue: string | null = null;
  if (finalTo === "Approved — Submitted for Payment") {
    const checkAmount = claim.approved_amount ?? 0;
    if (checkAmount >= 500) {
      if (!noteText) {
        return jsonError(
          400,
          'A check request of $500 or more requires an approver note in the Note field — who approved it and the date (e.g. "Dan - 7/10/2026 incidents@splashcarwashes.com").'
        );
      }
      paymentApprovalValue = noteText;
    } else {
      paymentApprovalValue = `${session.email} - under $500 threshold`;
    }
  }

  // i. Build the writes — UPDATE claims + INSERT claim_activity, atomic batch.
  const setParts: string[] = [
    "claim_status = ?",
    "lifecycle_state = ?",
    "status_updated_at = datetime('now')",
    "status_updated_by = ?",
    "updated_at = datetime('now')"
  ];
  const params: unknown[] = [finalTo, lifecycleForStatus(finalTo), session.email];

  // Brief 20 — clearApprovalDetails reverts the approval columns + audit
  // stamps as part of this UPDATE. Pushed before applyStamps so a rare
  // "revert + stamp" combo (none today) would still produce a clean
  // SET clause: clear-then-stamp ordering, last write wins. The activity
  // row's notes are augmented with a "[reset approval details]" suffix
  // so the timeline records the side-effect.
  let approvalReset = false;
  if (transition.clearApprovalDetails) {
    setParts.push(
      "approved_amount = NULL",
      "approved_quote_id = NULL",
      "parts_ordered = NULL",
      "vendor_name = NULL",
      "gm_approved_at = NULL",
      "gm_approved_by = NULL",
      "rm_approved_at = NULL",
      "rm_approved_by = NULL",
      "ceo_approved_at = NULL",
      "ceo_approved_by = NULL"
    );
    approvalReset = true;
  }

  applyStamps(transition, setParts, params, session.email);

  if (approvedAmount !== null) {
    setParts.push("approved_amount = ?");
    params.push(approvedAmount);
  }
  if (inputsCollected.parts !== undefined) {
    setParts.push("parts_ordered = ?");
    params.push(inputsCollected.parts);
  }
  if (inputsCollected.vendor !== undefined) {
    setParts.push("vendor_name = ?");
    params.push(inputsCollected.vendor);
  }
  if (selectedQuoteId !== null) {
    setParts.push("approved_quote_id = ?");
    params.push(selectedQuoteId);
  }

  // Brief 43 — fold the equipment-related no→yes override into the same
  // transaction that lands the status transition. Order is the SET clause
  // builder's order, but writes are atomic — the post-batch MaintainX
  // hook below reads `applyEquipmentOverride` rather than a re-read of
  // the row.
  if (applyEquipmentOverride) {
    setParts.push("equipment_related = 1");
    setParts.push("equipment_piece = ?");
    params.push(overrideEquipmentPiece);
  }

  // Auto-classify cause on denial. A denial means we've determined Splash
  // isn't liable, so record fault_category = 'No Fault' — but only when no
  // cause has been set yet. Never overrides an operator's explicit
  // classification (fills NULL only). Guarded on the exact terminal denial
  // status. Requires the widened fault_category CHECK (must include
  // 'No Fault') and the column to exist — both live post-migration.
  const autoNoFaultOnDenial =
    finalTo === "Closed — Denied" &&
    ((claim as ClaimRow).fault_category ?? null) === null;
  if (autoNoFaultOnDenial) {
    setParts.push("fault_category = 'No Fault'");
  }

  const updateSql = `UPDATE claims SET ${setParts.join(", ")} WHERE claim_id = ?`;
  params.push(claimId);

  // Compose the activity-log notes. When the transition resets approval
  // details, append a sentinel suffix so reviewers can see the side-effect
  // without diffing claim columns. Brief 43 — the equipment-override
  // side-effect appends its own sentinel suffix so the timeline records
  // the no→yes flip on the same status_change row (per brief Phase 1.5,
  // we don't introduce a separate activity_type for the override).
  const noteParts: string[] = [];
  if (noteText) noteParts.push(noteText);
  // Feature 2 — persist the payment approval attribution on the timeline.
  // For >= $500 the operator's manual note IS the attribution (already pushed
  // above), so only add the sentinel when it differs (the auto <$500 marker).
  if (paymentApprovalValue && paymentApprovalValue !== noteText) {
    noteParts.push(`[Approved for payment] ${paymentApprovalValue}`);
  }
  if (approvalReset) noteParts.push("[Reset approval details on revert]");
  if (autoNoFaultOnDenial) noteParts.push("[Cause auto-set to No Fault on denial]");
  if (applyEquipmentOverride) {
    noteParts.push(
      `[Equipment override] ${session.email} flipped equipment_related to yes during "${finalTo}" approval (equipment_piece: ${overrideEquipmentPiece})`
    );
  }
  const activityNote = noteParts.length > 0 ? noteParts.join("\n\n") : null;

  const updateStmt = env.DB.prepare(updateSql).bind(...params);
  const activityStmt = env.DB.prepare(
    `INSERT INTO claim_activity (
      claim_id, activity_type, status_from, status_to, notes, actor_email, actor_name
    ) VALUES (?, 'status_change', ?, ?, ?, ?, ?)`
  ).bind(claimId, claim.claim_status, finalTo, activityNote, session.email, session.email);

  try {
    await env.DB.batch([updateStmt, activityStmt]);
  } catch (err) {
    console.error("handleStatusTransition failed:", err);
    return jsonError(500, "Failed to apply status change.");
  }

  // Brief 101 — fire-and-forget manage-page update notification. The
  // helper checks STATUS_NOTIFIES_NEXT[finalTo] internally and exits
  // cleanly when the destination is a non-notifying status (admin /
  // finance / closed / vestigial). Placed AFTER the batch commits so a
  // notification can't fire for a write that rolled back, and BEFORE
  // the MaintainX block so the two side-effects don't serialize on
  // each other.
  if (env.CLAIM_UPDATE_WEBHOOK_URL) {
    // Brief 101 fix v2 — see handleAddNote: AWAIT, not ctx.waitUntil. Under
    // the apps/web -> damage-worker service binding, a dangling waitUntil
    // held the subrequest open past the response, so the admin UI reported a
    // failure even though the batch committed and the email sent (operators
    // retried and produced duplicate rows). Awaiting finishes the fail-soft
    // notification before the Response returns.
    await notifyClaimUpdate({
      env,
      request,
      changeType: "status",
      claim,
      actorEmail: session.email,
      actorRole: session.dcRole ?? null,
      fromStatus: claim.claim_status,
      toStatus: finalTo,
      noteText: noteText || undefined
    });
  }

  // Brief 43 — fire the existing createMaintainXWorkOrder helper when the
  // override flipped equipment_related no→yes. Same fail-soft posture as
  // Brief 42's form-submit hook: never throw, dedupe via
  // `claims.maintainx_workorder_id` (UPDATE-only-when-NULL semantics in
  // updateMaintainXWorkOrderId), and log the outcome to the activity log
  // either way. The status transition itself is already committed; a
  // MaintainX failure cannot roll it back.
  let maintainxAttempted = false;
  let maintainxOk: boolean | null = null;
  if (applyEquipmentOverride) {
    const mx = await tryCreateMaintainXIfMissing({
      env,
      request,
      claim,
      finalTo,
      overrideEquipmentPiece,
      actorEmail: session.email
    });
    maintainxAttempted = mx.attempted;
    maintainxOk = mx.attempted ? mx.ok : null;
  }

  // Post-write Power Automate side-effects. These are best-effort —
  // runCheckRequestPdfStep never throws and logs activity rows for both
  // success and failure outcomes. The status transition itself is already
  // committed; PDF/email failures cannot roll it back.
  // Source: legacy/damagemanager.js:2032-2080.
  if (finalTo === "Approved — Check Request Submitted" && selectedQuote) {
    // RM just approved a quote.
    // PDF #1: Requestor signed (RM email), Approval blank → email Incidents.
    await runCheckRequestPdfStep({
      db: env.DB,
      bucket: env.R2_BUCKET,
      claim,
      quote: selectedQuote,
      requestorEmail: session.email,
      approvalEmail: "",
      stageLabel: "Pending Incidents Review",
      webhookUrl: env.INCIDENTS_WEBHOOK_URL,
      recipientLabel: "incidents",
      images: env.IMAGES
    });
  } else if (finalTo === "Approved — Submitted for Payment") {
    // Incidents just clicked Submit for Payment.
    // PDF #2: Requestor + Approval signed → email AP.
    // Find the originally approved quote — claim.approved_quote_id was set
    // at the prior RM-approval transition, so it's already on the loaded
    // claim row (pre-update — this transition doesn't touch approved_quote_id).
    let quoteForPdf: ClaimPhotoRow | null = null;
    if (claim.approved_quote_id) {
      const photos = await listPhotosForClaim(env.DB, claimId);
      quoteForPdf =
        photos.find(
          (p) =>
            p.id === claim.approved_quote_id &&
            p.photo_type === "Quote" &&
            !p.deleted_at
        ) ?? null;
      // Fallback: any active Quote (matches legacy:2052-2055).
      if (!quoteForPdf) {
        quoteForPdf = photos.find((p) => p.photo_type === "Quote" && !p.deleted_at) ?? null;
      }
    }
    if (quoteForPdf) {
      // Requestor = original RM (from rm_approved_by). Approval = current
      // user (incidents). Source: legacy:2059-2063.
      const requestorEmail =
        claim.rm_approved_by ?? claim.gm_approved_by ?? "(unknown)";

      // Feature 3 — the AP package must include the FULL claim summary,
      // bundled INTO the check request PDF (alongside the quote, which is
      // already bundled inside it). Generated fresh from the current claim
      // row so it reflects post-submission assessment and includes the
      // internal-only fields the customer copy omits. Best-effort: if
      // generation fails we still send the check request and hand PA the
      // public summary URL (customer copy) as a degraded fallback.
      const claimSummaryUrl = `https://splashcarwashes.info/claims-api/summary/${encodeURIComponent(
        claimId
      )}`;
      const claimSummaryBytes = await buildFullClaimSummaryPdf(
        env,
        claim,
        finalTo
      );
      if (!claimSummaryBytes) {
        console.warn(
          `Submit for Payment: full claim summary generation failed for ${claimId}; AP package will use link fallback.`
        );
      }

      await runCheckRequestPdfStep({
        db: env.DB,
        bucket: env.R2_BUCKET,
        claim,
        quote: quoteForPdf,
        requestorEmail,
        // Feature 2 — approval attribution computed from the check amount.
        approvalEmail: paymentApprovalValue ?? session.email,
        stageLabel: "Submitted to AP",
        webhookUrl: env.AP_WEBHOOK_URL,
        recipientLabel: "AP",
        images: env.IMAGES,
        // Feature 3 — claim summary bundled into the check request PDF.
        claimSummaryBytes,
        claimSummaryUrl
      });
    } else {
      // No approved quote on this claim — log + continue. Activity row
      // surfaces the warning to admins. Matches legacy:2069-2078.
      try {
        await logActivity(env.DB, {
          claimId,
          activityType: "note",
          notes:
            "[System] Submit for Payment: could not find approved quote on this claim. PDF + email to AP skipped.",
          actorEmail: session.email,
          actorName: session.email
        });
      } catch {
        /* swallow — best-effort audit */
      }
    }
  }

  return json({
    ok: true,
    status: finalTo,
    lifecycle: lifecycleForStatus(finalTo),
    // Brief 43 — only present on the override path. Lets apps/web surface
    // a "MaintainX work order couldn't be created" toast on top of the
    // normal success message; absent on every non-override transition.
    ...(maintainxAttempted
      ? { maintainx_attempted: true, maintainx_ok: maintainxOk === true }
      : {})
  });
}

/* ============================================================
 * Brief 43 — equipment-override → MaintainX hook.
 *
 * Defense-in-depth dedupe: the override path runs only when the loaded
 * claim row had `equipment_related === 0`, and updateMaintainXWorkOrderId
 * is UPDATE-only-when-NULL. A re-trigger on a row that already has a WO
 * (e.g. operator clicks the modal twice in quick succession, both writes
 * race) lands at most one WO per claim. We also re-read the column
 * before issuing the POST so a concurrent write that landed first
 * short-circuits this path and the helper never fires twice.
 *
 * Fail-soft: every error path returns `{ attempted: true/false, ok: false }`
 * and writes a `[maintainx]` activity-log row. The transition's
 * status_change is already committed; nothing rolls it back.
 * ============================================================ */

interface TryCreateMaintainXIfMissingInput {
  env: Env;
  /** Inbound request — used to derive the apps/web admin base URL
   *  embedded in the MaintainX WO description (Brief 145). */
  request: Request;
  claim: ClaimRow;
  finalTo: ClaimStatus;
  overrideEquipmentPiece: string;
  actorEmail: string;
}

interface TryCreateMaintainXIfMissingResult {
  attempted: boolean;
  ok: boolean;
}

async function tryCreateMaintainXIfMissing(
  input: TryCreateMaintainXIfMissingInput
): Promise<TryCreateMaintainXIfMissingResult> {
  const { env, request, claim, finalTo, overrideEquipmentPiece, actorEmail } = input;

  if (!env.MAINTAINX_API_KEY) {
    console.warn(
      "[mx] MAINTAINX_API_KEY unbound; skipping override WO creation for",
      claim.claim_id
    );
    return { attempted: false, ok: false };
  }

  // Re-read the row so a concurrent writer (Brief 42 retry, or another
  // operator's modal click) that already landed a WO short-circuits us.
  // The loaded `claim` is from the pre-update snapshot.
  let dedupeRow: ClaimRow | null = null;
  try {
    dedupeRow = await getClaimById(env.DB, claim.claim_id);
  } catch (e) {
    console.warn("[mx] dedupe re-read failed; proceeding with helper attempt", e);
  }
  if (dedupeRow && dedupeRow.maintainx_workorder_id != null) {
    console.warn(
      "[mx] dedupe — claim",
      claim.claim_id,
      "already has WO id",
      dedupeRow.maintainx_workorder_id,
      "— skipping override creation"
    );
    return { attempted: false, ok: true };
  }

  // Construct a transient ClaimRow shape that reflects the post-UPDATE
  // state (equipment_related=1, equipment_piece=<piece>, claim_status=finalTo)
  // so the helper's title/description build off the right values.
  const claimRowForMx: ClaimRow = {
    ...claim,
    equipment_related: 1,
    equipment_piece: overrideEquipmentPiece,
    claim_status: finalTo,
    lifecycle_state: lifecycleForStatus(finalTo)
  };

  let mxLocationId: number | null = null;
  try {
    mxLocationId = await getMaintainXLocationId(env, claim.location_code);
  } catch (mxLocErr) {
    console.warn(
      "[mx] getMaintainXLocationId threw — proceeding without locationId:",
      mxLocErr
    );
  }

  const mxMode = env.MAINTAINX_MODE ?? "test";
  const mxBaseUrl = env.MAINTAINX_BASE_URL ?? "https://api.getmaintainx.com/v1";
  // Brief 145 — derive apps/web admin base from the inbound request origin so
  // a staging-test transition (operator working from
  // staging.splashcarwashes.info) embeds a staging admin link in the WO
  // description, not a production link that 404s for D1 rows that only
  // exist in staging.
  const mxAppsWebBaseUrl = resolveAdminBase(request, env);

  const ctrl = new AbortController();
  const timeoutId = setTimeout(() => ctrl.abort(), 8000);
  let maintainxResult: MaintainXResult;
  try {
    maintainxResult = await createMaintainXWorkOrder({
      claim: claimRowForMx,
      locationPretty: claimRowForMx.location_pretty,
      maintainxLocationId: mxLocationId,
      apiKey: env.MAINTAINX_API_KEY,
      mode: mxMode,
      baseUrl: mxBaseUrl,
      appsWebBaseUrl: mxAppsWebBaseUrl,
      signal: ctrl.signal
    });
  } catch (mxErr) {
    // createMaintainXWorkOrder is supposed to never throw; defense-in-depth.
    maintainxResult = {
      ok: false,
      workOrderId: null,
      error: mxErr instanceof Error ? mxErr.message : String(mxErr),
      status: 0,
      request: {}
    };
  } finally {
    clearTimeout(timeoutId);
  }

  if (maintainxResult.ok && maintainxResult.workOrderId != null) {
    try {
      await updateMaintainXWorkOrderId(
        env.DB,
        claim.claim_id,
        maintainxResult.workOrderId
      );
    } catch (updateErr) {
      console.error(
        "[mx] updateMaintainXWorkOrderId failed for",
        claim.claim_id,
        updateErr
      );
    }
    try {
      await logActivity(env.DB, {
        claimId: claim.claim_id,
        activityType: "note",
        notes: `[maintainx] Work order #${maintainxResult.workOrderId} created via approval-time override (mode: ${mxMode})`,
        actorEmail: actorEmail,
        actorName: actorEmail
      });
    } catch (logErr) {
      console.error("[mx] override activity log (success) failed:", logErr);
    }
    return { attempted: true, ok: true };
  }

  console.error(
    "[mx] override WO creation failed for",
    claim.claim_id,
    maintainxResult.error
  );
  try {
    await logActivity(env.DB, {
      claimId: claim.claim_id,
      activityType: "note",
      notes: `[maintainx] Override WO creation failed — ${maintainxResult.error ?? "unknown error"} (status: ${maintainxResult.status}, mode: ${mxMode})`,
      actorEmail: actorEmail,
      actorName: "system"
    });
  } catch (logErr) {
    console.error("[mx] override activity log (failure) failed:", logErr);
  }
  return { attempted: true, ok: false };
}

/** Apply stamps to the SET parts. Mutates `setParts` and `params`. */
function applyStamps(
  transition: ClaimTransitionDef,
  setParts: string[],
  params: unknown[],
  actorEmail: string
): void {
  if (transition.stamps.includes("gm")) {
    setParts.push("gm_approved_at = datetime('now')");
    setParts.push("gm_approved_by = ?");
    params.push(actorEmail);
  }
  if (transition.stamps.includes("rm")) {
    setParts.push("rm_approved_at = datetime('now')");
    setParts.push("rm_approved_by = ?");
    params.push(actorEmail);
  }
  if (transition.stamps.includes("ceo")) {
    setParts.push("ceo_approved_at = datetime('now')");
    setParts.push("ceo_approved_by = ?");
    params.push(actorEmail);
  }
}

/* ============================================================
 * POST /manage/api/claim/{id}/document
 *
 * Brief 37: this endpoint is invoked by a browser form whose `action`
 * targets us directly (apps/web's UploadDocumentCard posts here without
 * going through a Next 15 server action). The legacy worker
 * (`info-signup-worker`) used the same shape — POST multipart, then 303
 * back to the claim detail page — and that path "just worked" on iPhone
 * mobile while the server-action path threw the digest 924441341@e394
 * white-page (Brief 36 Part B). Bypassing Next removes the multipart
 * round-trip through the server-action runtime, which is what the legacy
 * test demonstrated. Source: legacy/damagemanager.js:2446 handleDocumentUpload.
 *
 * Response shape: 303 redirect on every branch.
 *   - success → ${appsWebOrigin}/admin/damage/{claimId}
 *   - validation/storage failure → same path with ?upload_error=<msg>
 *
 * The apps/web origin is read from the request's Origin header (set by
 * the browser on every cross-/same-origin form POST). Falls back to the
 * worker's own URL origin for the same-zone production case where the
 * two share `splashcarwashes.info`.
 * ============================================================ */

const UPLOAD_ERROR_MAX_LEN = 240;

function buildUploadRedirect(
  request: Request,
  claimId: string,
  errorMessage?: string
): Response {
  const originHeader = request.headers.get("Origin");
  const origin = originHeader && /^https?:\/\//.test(originHeader)
    ? originHeader
    : new URL(request.url).origin;
  const path = `/admin/damage/${encodeURIComponent(claimId)}`;
  const query = errorMessage
    ? `?upload_error=${encodeURIComponent(errorMessage.slice(0, UPLOAD_ERROR_MAX_LEN))}`
    : "";
  return Response.redirect(`${origin}${path}${query}`, 303);
}

async function handleDocumentUpload(
  request: Request,
  env: Env,
  session: Session,
  claimId: string
): Promise<Response> {
  if (!isOriginAllowed(request)) return jsonError(403, "bad origin");

  const guard = await loadAndScopeCheck(env, session, claimId);
  if (!guard.ok) return guard.response;

  const ctype = request.headers.get("content-type") ?? "";
  if (!ctype.includes("multipart/form-data")) {
    return buildUploadRedirect(request, claimId, "Document upload must be multipart/form-data.");
  }

  // Multipart with files — call request.formData() directly (readForm
  // strips file values). Same shape as legacy/damagemanager.js:2467.
  const form = await request.formData();
  const file = form.get("file");
  const docType = String(form.get("doc_type") ?? "").trim();
  const vendor = String(form.get("vendor") ?? "").trim() || null;
  const amountStr = String(form.get("amount") ?? "").trim();
  const notesText = String(form.get("notes") ?? "").trim() || null;
  const payToTypeRaw = String(form.get("pay_to_type") ?? "").trim().toLowerCase();
  const vendorAddress = String(form.get("vendor_address") ?? "").trim() || null;

  if (!DOCUMENT_TYPES.has(docType)) {
    return buildUploadRedirect(request, claimId, "Invalid document type. Must be Quote or Receipt.");
  }
  if (!file || typeof file === "string" || !(file instanceof File) || !file.name) {
    return buildUploadRedirect(request, claimId, "No file selected.");
  }
  if (file.size > DOCUMENT_MAX_BYTES) {
    return buildUploadRedirect(
      request,
      claimId,
      `File too large (max ${DOCUMENT_MAX_BYTES / (1024 * 1024)} MB).`
    );
  }
  if (file.size === 0) {
    return buildUploadRedirect(request, claimId, "File is empty.");
  }
  const mime = (file.type || "").toLowerCase();
  const ext = (file.name.split(".").pop() ?? "").toLowerCase();
  if (!DOCUMENT_ALLOWED_EXT.has(ext) && !DOCUMENT_ALLOWED_MIME.has(mime)) {
    return buildUploadRedirect(
      request,
      claimId,
      "Unsupported file type. Allowed: PDF, JPG, PNG, HEIC."
    );
  }

  // Brief 20 — Quote rows now require amount + pay_to_type up front so the
  // claim can't be advanced through Approve-Quote with an unfillable check
  // request. Receipts stay loose (they only inform the audit timeline).
  if (docType === "Quote" && !amountStr) {
    return buildUploadRedirect(request, claimId, "Amount is required for Quote documents.");
  }
  if (docType === "Quote" && !payToTypeRaw) {
    return buildUploadRedirect(
      request,
      claimId,
      "Pay to (customer or vendor) is required for Quote documents."
    );
  }

  let amount: number | null = null;
  if (amountStr) {
    const parsed = Number.parseFloat(amountStr);
    if (Number.isNaN(parsed) || parsed < 0) {
      return buildUploadRedirect(request, claimId, "Amount must be a non-negative number.");
    }
    amount = parsed;
  }

  if (notesText && notesText.length > 5000) {
    return buildUploadRedirect(request, claimId, "Notes are too long (max 5000 characters).");
  }

  let payToType: PayToType | null = null;
  let payToVendorAddress: string | null = null;
  if (docType === "Quote") {
    if (payToTypeRaw !== "customer" && payToTypeRaw !== "vendor") {
      return buildUploadRedirect(request, claimId, "Pay to must be 'customer' or 'vendor'.");
    }
    payToType = payToTypeRaw as PayToType;
    if (payToType === "vendor") {
      // Brief 20 — vendor pay_to_type now also requires vendor (display
      // name) and vendor_address up front so the check-request PDF can
      // resolve a payee.
      if (!vendor) {
        return buildUploadRedirect(
          request,
          claimId,
          "Vendor name is required when paying the vendor directly."
        );
      }
      if (!vendorAddress) {
        return buildUploadRedirect(
          request,
          claimId,
          "Vendor address is required when paying the vendor directly."
        );
      }
      if (vendorAddress.length > 1000) {
        return buildUploadRedirect(
          request,
          claimId,
          "Vendor address is too long (max 1000 characters)."
        );
      }
      payToVendorAddress = vendorAddress;
    }
  }

  // Sequence number is over BOTH active and soft-deleted rows so we never
  // collide on R2 keys (legacy:2438 nextDocumentSequence).
  const seqCount = await countPhotosOfType(env.DB, claimId, docType);
  const r2 = await uploadClaimPhoto({
    bucket: env.R2_BUCKET,
    file,
    claimId,
    photoType: docType,
    index: seqCount,
    images: env.IMAGES
  });
  if (!r2) {
    return buildUploadRedirect(request, claimId, "Upload to storage failed. Please try again.");
  }

  try {
    await insertDocPhoto(env.DB, {
      claimId,
      docType,
      filename: file.name,
      r2Key: r2.key,
      contentType: r2.contentType,
      vendor,
      amount,
      notes: notesText,
      payToType,
      vendorAddress: payToVendorAddress,
      uploadedBy: session.email
    });
    const summary = `Uploaded ${docType}${vendor ? ` from ${vendor}` : ""}${
      amount !== null ? ` — $${amount.toFixed(2)}` : ""
    } (${file.name})`;
    await logActivity(env.DB, {
      claimId,
      activityType: "document_added",
      notes: summary,
      actorEmail: session.email,
      actorName: session.email
    });
    await touchClaim(env.DB, claimId);
  } catch (err) {
    console.error("handleDocumentUpload failed:", err);
    return buildUploadRedirect(request, claimId, "Failed to record upload.");
  }

  return buildUploadRedirect(request, claimId);
}

/* ============================================================
 * POST /manage/api/claim/{id}/document/{docId}/delete
 * ============================================================ */

async function handleDocumentDelete(
  request: Request,
  env: Env,
  session: Session,
  claimId: string,
  docIdStr: string
): Promise<Response> {
  if (!isOriginAllowed(request)) return jsonError(403, "bad origin");

  const guard = await loadAndScopeCheck(env, session, claimId);
  if (!guard.ok) return guard.response;
  const { claim } = guard;

  const docId = Number.parseInt(docIdStr, 10);
  if (Number.isNaN(docId)) return jsonError(400, "Invalid document id.");

  const photos = await listPhotosForClaim(env.DB, claimId);
  const doc = photos.find((p) => p.id === docId);
  if (!doc) return jsonError(404, "Document not found.");

  // Only Quote / Receipt are deletable via this endpoint — never customer photos.
  if (!DOCUMENT_TYPES.has(doc.photo_type)) {
    return jsonError(403, "Only Quote and Receipt documents can be deleted.");
  }
  if (!canMutateDocument(session, doc)) {
    return jsonError(403, "You don't have permission to delete this document.");
  }
  // Block deleting the approved quote — admin must un-approve first.
  if (doc.photo_type === "Quote" && claim.approved_quote_id === docId) {
    return jsonError(400, "This quote has already been approved and cannot be deleted.");
  }

  try {
    await softDeletePhoto(env.DB, docId);
    const summary = `Deleted ${doc.photo_type}${doc.vendor ? ` from ${doc.vendor}` : ""} (${doc.filename || ""})`;
    // Legacy uses 'document_added' for both uploads AND deletes
    // (legacy:2682), distinguished by the notes prose. Preserved verbatim
    // — fixing this would require a D1 CHECK-constraint rebuild migration
    // and the audit-log annoyance isn't worth that cost.
    await logActivity(env.DB, {
      claimId,
      activityType: "document_added",
      notes: summary,
      actorEmail: session.email,
      actorName: session.email
    });
    await touchClaim(env.DB, claimId);
  } catch (err) {
    console.error("handleDocumentDelete failed:", err);
    return jsonError(500, "Failed to delete document.");
  }
  return json({ ok: true });
}

/* ============================================================
 * SUPER-ADMIN HARD DELETE ("purge")
 *
 * GET  /manage/api/claim/{id}/purge-preview   — count the blast radius
 * POST /manage/api/claim/{id}/purge           — irreversible delete
 *
 * Removes EVERYTHING tied to one claim:
 *   D1:  claim_photos, claim_activity, and the claims row itself.
 *   R2:  every object under the claim's key families —
 *          claims/{claimId}/...              (summary PDF + uploaded docs)
 *          submissions/{claimId}.json        (canonical submission archive)
 *          failed_submissions/{claimId}.json (PA-failure fallback)
 *          claim-uploads/{idempotencyKey}/.. (Brief 146 OOB customer photos)
 *        plus every claim_photos.r2_key on record (catches legacy keys and
 *        any object that lives outside the prefixes above).
 *
 * Auth: the /manage/api gate only proves "claims" tool access. Purging is a
 * strictly higher bar, so both handlers hard-require dcRole === "super_admin"
 * and reject everyone else with 403 — admins included.
 *
 * There is no soft-delete / recycle bin. This is intentional and permanent.
 * The POST body must carry `confirm_claim_id` exactly equal to the claim id
 * (the UI's type-to-confirm), a server-side backstop against a stray POST.
 * ============================================================ */

const R2_LIST_PAGE_CAP = 100;

/**
 * Gather every R2 object key associated with a claim. Best-effort: R2 list
 * failures are pushed to `errors` rather than aborting, so a purge still
 * clears whatever it can enumerate (and D1). Returns a de-duplicated key
 * list. `errors` surfaces to the caller for logging / partial-failure
 * reporting.
 */
async function collectClaimR2Keys(
  env: Env,
  claim: ClaimRow,
  errors: string[]
): Promise<string[]> {
  const keys = new Set<string>();
  const claimId = claim.claim_id;

  // 1. Explicit single-object keys.
  keys.add(`submissions/${claimId}.json`);
  keys.add(`failed_submissions/${claimId}.json`);

  // 2. Every r2_key recorded on claim_photos (photos + Quote/Receipt docs),
  //    including soft-deleted rows — we want the underlying objects gone too.
  try {
    const photoRows = await env.DB.prepare(
      `SELECT r2_key FROM claim_photos WHERE claim_id = ?`
    )
      .bind(claimId)
      .all<{ r2_key: string }>();
    for (const row of photoRows.results ?? []) {
      if (row.r2_key) keys.add(row.r2_key);
    }
  } catch (err) {
    errors.push(`claim_photos r2_key query failed: ${String(err)}`);
  }

  // 3. Prefix sweeps. `claims/{claimId}/` holds the summary PDF and any
  //    server-generated document files; `claim-uploads/{idempotencyKey}/`
  //    holds the Brief 146 out-of-band customer uploads (keyed by the
  //    pending-submission id, which is the claim's idempotency_key).
  const prefixes = [`claims/${claimId}/`];
  const idempotencyKey = (claim as { idempotency_key?: string | null })
    .idempotency_key;
  if (idempotencyKey) {
    prefixes.push(`claim-uploads/${idempotencyKey}/`);
  }

  for (const prefix of prefixes) {
    try {
      let cursor: string | undefined;
      let pages = 0;
      do {
        const list = await env.R2_BUCKET.list({ prefix, cursor, limit: 1000 });
        for (const obj of list.objects) keys.add(obj.key);
        cursor = list.truncated ? list.cursor : undefined;
        pages++;
      } while (cursor && pages < R2_LIST_PAGE_CAP);
    } catch (err) {
      errors.push(`R2 list ${prefix} failed: ${String(err)}`);
    }
  }

  return Array.from(keys);
}

/**
 * GET /manage/api/claim/{id}/purge-preview — super-admin only.
 * Reports how many D1 rows and R2 objects a purge would remove, without
 * touching anything. Powers the UI's type-to-confirm blast-radius panel.
 */
async function handleClaimPurgePreview(
  env: Env,
  session: Session,
  claimId: string
): Promise<Response> {
  if (session.dcRole !== "super_admin") {
    return jsonError(403, "Only a super admin can delete a claim.");
  }
  const claim = await getClaimById(env.DB, claimId);
  if (!claim) return jsonError(404, "not found");

  const errors: string[] = [];
  const [photoCount, activityCount] = await Promise.all([
    countRows(env.DB, "claim_photos", claimId, errors),
    countRows(env.DB, "claim_activity", claimId, errors)
  ]);
  const r2Keys = await collectClaimR2Keys(env, claim, errors);

  return json({
    ok: true,
    claim_id: claimId,
    d1: {
      claims: 1,
      claim_photos: photoCount,
      claim_activity: activityCount
    },
    r2: { objects: r2Keys.length },
    warnings: errors
  });
}

/** COUNT(*) for a claim's rows in one child table. Errors → 0 + note. */
async function countRows(
  db: D1Database,
  table: "claim_photos" | "claim_activity",
  claimId: string,
  errors: string[]
): Promise<number> {
  try {
    const row = await db
      .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE claim_id = ?`)
      .bind(claimId)
      .first<{ n: number }>();
    return row?.n ?? 0;
  } catch (err) {
    errors.push(`count ${table} failed: ${String(err)}`);
    return 0;
  }
}

/**
 * POST /manage/api/claim/{id}/purge — super-admin only, irreversible.
 * Deletes all R2 objects first (best-effort), then the D1 child rows, then
 * the claims row. R2-before-D1 ordering means a mid-run failure leaves the
 * claims row intact so the operator can retry rather than orphaning storage.
 */
async function handleClaimPurge(
  request: Request,
  env: Env,
  session: Session,
  claimId: string
): Promise<Response> {
  if (!isOriginAllowed(request)) return jsonError(403, "bad origin");
  if (session.dcRole !== "super_admin") {
    return jsonError(403, "Only a super admin can delete a claim.");
  }

  const claim = await getClaimById(env.DB, claimId);
  if (!claim) return jsonError(404, "not found");

  // Server-side backstop for the UI's type-to-confirm. The confirm value
  // must equal the claim id exactly; a mismatch means the POST didn't come
  // from the intended confirmation flow.
  const form = await readForm(request);
  const confirm = (form.get("confirm_claim_id") ?? "").trim();
  if (confirm !== claimId) {
    return jsonError(400, "Confirmation text does not match the claim id.");
  }

  const errors: string[] = [];
  const r2Keys = await collectClaimR2Keys(env, claim, errors);

  // Delete R2 objects in chunks (R2 delete accepts ≤1000 keys per call).
  let r2Deleted = 0;
  for (let i = 0; i < r2Keys.length; i += 1000) {
    const chunk = r2Keys.slice(i, i + 1000);
    try {
      await env.R2_BUCKET.delete(chunk);
      r2Deleted += chunk.length;
    } catch (err) {
      errors.push(`R2 delete chunk @${i} failed: ${String(err)}`);
    }
  }

  // Delete D1 rows: children first, then the parent claims row. Batched so
  // it commits atomically on D1.
  let d1 = { claim_photos: 0, claim_activity: 0, claims: 0 };
  try {
    const results = await env.DB.batch([
      env.DB.prepare(`DELETE FROM claim_photos WHERE claim_id = ?`).bind(claimId),
      env.DB.prepare(`DELETE FROM claim_activity WHERE claim_id = ?`).bind(claimId),
      env.DB.prepare(`DELETE FROM claims WHERE claim_id = ?`).bind(claimId)
    ]);
    d1 = {
      claim_photos: results[0]?.meta?.changes ?? 0,
      claim_activity: results[1]?.meta?.changes ?? 0,
      claims: results[2]?.meta?.changes ?? 0
    };
  } catch (err) {
    console.error("handleClaimPurge D1 delete failed:", err);
    return jsonError(
      500,
      `Deleted ${r2Deleted} storage object(s), but removing the database rows failed: ${
        err instanceof Error ? err.message : String(err)
      }. The claim may be partially deleted — retry to finish.`
    );
  }

  console.warn(
    `[claim.purge] super_admin=${session.email} purged claim=${claimId} ` +
      `r2=${r2Deleted} d1=${JSON.stringify(d1)} warnings=${errors.length}`
  );

  return json({
    ok: true,
    claim_id: claimId,
    r2: { deleted: r2Deleted },
    d1,
    warnings: errors
  });
}

/* ============================================================
 * POST /claims-api/submit-claim — public, no auth
 *
 * Multipart form submission from the customer-facing damage form.
 * Pipeline (matches legacy/damagemanager.js:79):
 *   1. Parse form fields → claimData (camelCase, matching legacy keys)
 *   2. Generate claim_id
 *   3. Upload photos to R2 (4 categories)
 *   4. Save full submission JSON to R2 (saveClaimSubmission, unconditional)
 *   5. Write to D1 (writeClaimBatch — does location_pretty resolution)
 *   6. POST claimData to env.POWER_AUTOMATE_URL
 *   7. If PA fails → saveFailedSubmission (R2 fallback)
 * ============================================================ */

interface ClaimSubmissionPayload {
  // Customer info
  customerName: string;
  customerPhone: string;
  customerEmail: string;
  mailingAddress: string;
  licensePlate: string;
  vehicleMake: string;
  vehicleModel: string;
  vehicleYear: string;
  vehicleColor: string;
  issueDescription: string;
  // Employee assessment
  employeeName: string;
  location: string;
  locationPretty: string;
  membershipNumber: string;
  preExistingDamage: string;
  // Feature 4 — required "Poor"|"Fair"|"Good"|"Excellent".
  vehicleCondition: string;
  damageType: string;
  damageOther: string;
  equipmentInvolved: string;
  equipmentMalfunction: boolean;
  determination: string;
  customerTold: string;
  customerDemeanor: string;
  // Metadata
  submittedAt: string;
  ipAddress: string;
  userAgent: string;
  // Filled later
  claimId: string;
  photos: Array<{
    r2Key: string;
    photoType: string;
    fileName: string;
    fileSize: number;
    contentType: string;
  }>;
  /** Brief 42 — set after a successful MaintainX WO creation. NULL when
   *  equipment_related=0, when MAINTAINX_API_KEY is unbound, or when the
   *  MaintainX call failed. Rides on the SharePoint webhook payload so
   *  Power Automate can surface the WO ID in finance/audit views. */
  maintainxWorkorderId: number | null;
}

/**
 * Brief 146 — unified accessor over either a parsed JSON body or a
 * multipart FormData. The submit handler reads scalar fields via
 * `inputs.get(name)` and dispatches the photo loop on `inputs.mode`.
 *
 * Both modes are guaranteed to surface every form field as a string
 * (defaults to empty when absent) — same posture as the pre-Brief-146
 * `String(formData.get(name) ?? "")` pattern.
 */
type SubmitInputs =
  | {
      mode: "json";
      get: (name: string) => string;
      photoRefs: Record<
        string,
        ReadonlyArray<{ r2_key: string; original_filename?: string }>
      >;
      multipartFiles?: undefined;
    }
  | {
      mode: "multipart";
      get: (name: string) => string;
      multipartFiles: FormData;
      photoRefs?: undefined;
    };

const PHOTO_REF_FIELDS = new Set([
  "fourCornersPhotos",
  "vinPhoto",
  "damagePhotos",
  "platePhoto"
]);

async function parseSubmitMultipart(request: Request): Promise<SubmitInputs> {
  const formData = await request.formData();
  return {
    mode: "multipart",
    get: (name: string) => String(formData.get(name) ?? ""),
    multipartFiles: formData
  };
}

async function parseSubmitJson(request: Request): Promise<SubmitInputs> {
  let body: unknown;
  try {
    body = await request.json();
  } catch (_) {
    throw new Error("Invalid JSON body");
  }
  if (!body || typeof body !== "object") {
    throw new Error("Submit body must be an object");
  }
  const obj = body as Record<string, unknown>;
  const photoRefsRaw = obj["photo_refs"];
  const photoRefs: Record<
    string,
    Array<{ r2_key: string; original_filename?: string }>
  > = {};
  if (photoRefsRaw && typeof photoRefsRaw === "object") {
    const rawObj = photoRefsRaw as Record<string, unknown>;
    for (const field of PHOTO_REF_FIELDS) {
      const arr = rawObj[field];
      if (!Array.isArray(arr)) continue;
      const refs: Array<{ r2_key: string; original_filename?: string }> = [];
      for (const item of arr) {
        if (!item || typeof item !== "object") continue;
        const r2_key = (item as Record<string, unknown>)["r2_key"];
        if (typeof r2_key !== "string" || !r2_key) continue;
        // Defense: must look like the worker's own key shape so a
        // malicious caller can't substitute an arbitrary R2 path.
        if (!r2_key.startsWith("claim-uploads/")) continue;
        const original_filename = (item as Record<string, unknown>)[
          "original_filename"
        ];
        refs.push({
          r2_key,
          original_filename:
            typeof original_filename === "string"
              ? original_filename
              : undefined
        });
      }
      if (refs.length > 0) photoRefs[field] = refs;
    }
  }
  return {
    mode: "json",
    get: (name: string) => {
      const v = obj[name];
      if (v == null) return "";
      if (typeof v === "string") return v;
      if (typeof v === "boolean") return v ? "true" : "false";
      if (typeof v === "number") return String(v);
      return "";
    },
    photoRefs
  };
}

/** Map content-type → file extension for naming claim_photos rows. */
function extForMime(mime: string): string | null {
  const map: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/heic": "heic",
    "image/heif": "heif",
    "image/heic-sequence": "heic",
    "image/heif-sequence": "heif"
  };
  return map[mime.toLowerCase()] ?? null;
}

async function handleClaimSubmission(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  // Brief 23: dual-mode response shape.
  //   - Browser submit (Accept: text/html...): 302 to /claims/{slug}/thanks?id=...
  //     on success or /claims/{slug}?error=... on failure.
  //   - Programmatic / JSON caller: existing JSON shape.
  // Detection is the Accept request header — browsers default to
  // "text/html,application/xhtml+xml,...", JSON callers either send
  // "application/json" or omit Accept. We treat any text/html prefix in
  // Accept as browser mode.
  const acceptHeader = request.headers.get("Accept") ?? "";
  const browserMode = acceptHeader.includes("text/html");
  const requestUrl = new URL(request.url);
  const baseOrigin = `${requestUrl.protocol}//${requestUrl.host}`;

  // Brief 146 — dual-mode submit body. JSON callers (modern client post-
  // Brief-146 with OOB-uploaded photos) send Content-Type: application/json
  // with a `photo_refs` map keyed by the canonical category field. Legacy
  // browser-cached clients continue sending multipart/form-data with file
  // parts — that path is preserved for the back-compat window (~14 days
  // post-deploy) so users on stale HTML don't break. The legacy multipart
  // path tags every successful submit with `[claim.submit] legacy multipart
  // path used` so we can confirm the tail is dead before removing it.
  const contentType = request.headers.get("Content-Type") ?? "";
  const jsonMode = contentType.toLowerCase().includes("application/json");

  try {
    let inputs: SubmitInputs;
    try {
      inputs = jsonMode
        ? await parseSubmitJson(request)
        : await parseSubmitMultipart(request);
    } catch (parseErr) {
      const message =
        parseErr instanceof Error ? parseErr.message : "invalid request body";
      if (browserMode) {
        const target = new URL(
          `${baseOrigin}/claims/unknown?error=${encodeURIComponent(message)}`
        );
        return Response.redirect(target.toString(), 303);
      }
      return json({ ok: false, error: message, success: false }, 400);
    }

    if (inputs.mode === "multipart") {
      console.log("[claim.submit] legacy multipart path used");
    }

    // 1. Parse form fields. CamelCase keys match legacy/damagemanager.js:84
    // EXACTLY — Power Automate's Parse JSON action consumes these names
    // and any drift breaks the SharePoint write.
    const claimData: ClaimSubmissionPayload = {
      customerName: inputs.get("customerName"),
      customerPhone: inputs.get("customerPhone"),
      customerEmail: inputs.get("customerEmail"),
      mailingAddress: inputs.get("mailingAddress"),
      licensePlate: inputs.get("licensePlate"),
      vehicleMake: inputs.get("vehicleMake"),
      vehicleModel: inputs.get("vehicleModel"),
      vehicleYear: inputs.get("vehicleYear"),
      vehicleColor: inputs.get("vehicleColor"),
      issueDescription: inputs.get("issueDescription"),
      employeeName: inputs.get("employeeName"),
      location: inputs.get("location"),
      locationPretty: inputs.get("locationPretty"),
      membershipNumber: inputs.get("membershipNumber"),
      preExistingDamage: inputs.get("preExistingDamage"),
      vehicleCondition: inputs.get("vehicleCondition"),
      damageType: inputs.get("damageType"),
      damageOther: inputs.get("damageOther"),
      equipmentInvolved: inputs.get("equipmentInvolved"),
      equipmentMalfunction: inputs.get("equipmentMalfunction") === "true",
      determination: inputs.get("determination"),
      customerTold: inputs.get("customerTold"),
      customerDemeanor: inputs.get("customerDemeanor"),
      submittedAt: new Date().toISOString(),
      ipAddress: request.headers.get("CF-Connecting-IP") ?? "Unknown",
      userAgent: request.headers.get("User-Agent") ?? "Unknown",
      claimId: "", // filled below
      photos: [],
      maintainxWorkorderId: null // filled by Brief 42 hook after writeClaimBatch
    };

    // Brief 138 Phase 3 — idempotency-key dedup. Client appends a UUID v4 to
    // FormData; worker checks D1 for an existing claim with the same key
    // BEFORE any side effects (validation rejects, photo upload, R2 write,
    // PA POST, webhooks). Hit → re-emit the original success response so a
    // retry after a lost-response success collapses onto the original claim,
    // not a duplicate. Miss → fall through; writeClaimBatch persists the key
    // alongside the new row.
    //
    // Defensive against tampering: malformed keys are treated as absent
    // (logged, but no 400 — the goal is dedup, not authn). Tolerates the
    // column being absent (between code push and operator D1 migration)
    // by catching the "no such column" error and falling through.
    const idempotencyKeyRaw = inputs.get("idempotency_key").trim();
    const idempotencyKeyValid =
      idempotencyKeyRaw.length === 36 &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idempotencyKeyRaw);
    const idempotencyKey = idempotencyKeyValid ? idempotencyKeyRaw : null;
    if (idempotencyKeyRaw && !idempotencyKeyValid) {
      console.warn(
        `[claim.idempotent] malformed key supplied (proceeding without dedup): ${idempotencyKeyRaw.slice(0, 64)}`
      );
    }
    if (idempotencyKey) {
      try {
        const existing = await getClaimByIdempotencyKey(env.DB, idempotencyKey);
        if (existing) {
          console.log(
            `[claim.idempotent] hit claim_id=${existing.claim_id} key=${idempotencyKey}`
          );
          const dedupSummaryUrl = `${baseOrigin}/claims-api/summary/${encodeURIComponent(
            existing.claim_id
          )}`;
          if (browserMode) {
            const dedupSlug =
              encodeURIComponent(claimData.location || "") || "unknown";
            const target = new URL(
              `${baseOrigin}/claims/${dedupSlug}/thanks?id=${encodeURIComponent(existing.claim_id)}`
            );
            return Response.redirect(target.toString(), 303);
          }
          return json({
            ok: true,
            claim_id: existing.claim_id,
            success: true,
            claimId: existing.claim_id,
            powerAutomateSuccess: true,
            d1Success: true,
            photosUploaded: 0,
            summary_pdf_url: dedupSummaryUrl,
            idempotent_replay: true
          });
        }
      } catch (lookupErr) {
        const errMsg =
          lookupErr instanceof Error ? lookupErr.message : String(lookupErr);
        if (/no such column.*idempotency_key/i.test(errMsg)) {
          console.warn(
            "[claim.idempotent] column missing — skipping dedup (apply schema migration)"
          );
        } else {
          console.warn(
            `[claim.idempotent] lookup failed (proceeding without dedup): ${errMsg}`
          );
        }
      }
    }

    // Brief 32 — email is now required. Worker re-validates after the form's
    // HTML5 + inline-script gates because programmatic JSON callers can
    // bypass them. The DB column stays nullable for back-compat with any
    // historical rows; this is a contract change at the surface, not at the
    // storage level.
    // Brief 152 — tightened from the loose `[^@\s]+@[^@\s]+\.[^@\s]+` to the
    // canonical isValidEmail helper. Rejects RFC-invalid local-part dot
    // positions (trailing/leading/consecutive) that Exchange Online refuses
    // during recipient resolution.
    const emailTrimmed = claimData.customerEmail.trim();
    if (!emailTrimmed || !isValidEmail(emailTrimmed)) {
      const message = "Email required";
      if (browserMode) {
        let slug = encodeURIComponent(claimData.location || "") || "unknown";
        const target = new URL(
          `${baseOrigin}/claims/${slug}?error=${encodeURIComponent(message)}`
        );
        return Response.redirect(target.toString(), 303);
      }
      return json({ ok: false, error: message, success: false }, 400);
    }
    claimData.customerEmail = emailTrimmed;

    // Feature 4 — vehicle_condition is required and must match the fixed
    // dropdown allow-list. Same dual-mode 303/JSON 400 pattern as the gates
    // above. Normalized back onto claimData so the row stores the trimmed value.
    const vehicleConditionTrimmed = (claimData.vehicleCondition ?? "").trim();
    if (!vehicleConditionTrimmed || !ALLOWED_VEHICLE_CONDITIONS.has(vehicleConditionTrimmed)) {
      const message = vehicleConditionTrimmed
        ? "Invalid vehicle condition"
        : "Vehicle condition required";
      if (browserMode) {
        const slug =
          encodeURIComponent(claimData.location || "") || "unknown";
        const target = new URL(
          `${baseOrigin}/claims/${slug}?error=${encodeURIComponent(message)}`
        );
        return Response.redirect(target.toString(), 303);
      }
      return json({ ok: false, error: message, success: false }, 400);
    }
    claimData.vehicleCondition = vehicleConditionTrimmed;

    // incident_date — the date AND time the customer says the damage occurred.
    // The only date/time field on the form, so it's required. Same dual-mode
    // 303/JSON 400 pattern as the gates above. <input type="datetime-local">
    // posts 'YYYY-MM-DDTHH:MM' (optionally :SS); we store it with a space
    // separator ('YYYY-MM-DD HH:MM[:SS]') so SQLite's datetime()/julianday()
    // read it cleanly and it sorts lexically alongside submitted_at.
    const incidentDateRaw = (inputs.get("incidentDate") ?? "").trim();
    const incidentDateOk = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(incidentDateRaw);
    if (!incidentDateOk) {
      const message = incidentDateRaw
        ? "Invalid incident date/time"
        : "Incident date/time required";
      if (browserMode) {
        const slug = encodeURIComponent(claimData.location || "") || "unknown";
        const target = new URL(
          `${baseOrigin}/claims/${slug}?error=${encodeURIComponent(message)}`
        );
        return Response.redirect(target.toString(), 303);
      }
      return json({ ok: false, error: message, success: false }, 400);
    }
    const incidentDateNormalized = incidentDateRaw.replace("T", " ");

    // Brief 41 — damage_type is required and must match the form's
    // allow-list. When 'Other' is selected, damage_other (≤200 chars) is
    // required; for any other value, server-side blanks damageOther so the
    // client can't smuggle stale free-text into the row. Same dual-mode
    // 303/JSON 400 pattern as the email gate above.
    const damageTypeTrimmed = claimData.damageType.trim();
    if (!damageTypeTrimmed) {
      const message = "Damage type required";
      if (browserMode) {
        const slug =
          encodeURIComponent(claimData.location || "") || "unknown";
        const target = new URL(
          `${baseOrigin}/claims/${slug}?error=${encodeURIComponent(message)}`
        );
        return Response.redirect(target.toString(), 303);
      }
      return json({ ok: false, error: message, success: false }, 400);
    }
    if (!ALLOWED_DAMAGE_TYPES.has(damageTypeTrimmed)) {
      const message = "Invalid damage type";
      if (browserMode) {
        const slug =
          encodeURIComponent(claimData.location || "") || "unknown";
        const target = new URL(
          `${baseOrigin}/claims/${slug}?error=${encodeURIComponent(message)}`
        );
        return Response.redirect(target.toString(), 303);
      }
      return json({ ok: false, error: message, success: false }, 400);
    }
    claimData.damageType = damageTypeTrimmed;

    if (claimData.damageType === "Other") {
      const damageOtherTrimmed = claimData.damageOther.trim().slice(0, 200);
      if (!damageOtherTrimmed) {
        const message = "Description of other required";
        if (browserMode) {
          const slug =
            encodeURIComponent(claimData.location || "") || "unknown";
          const target = new URL(
            `${baseOrigin}/claims/${slug}?error=${encodeURIComponent(message)}`
          );
          return Response.redirect(target.toString(), 303);
        }
        return json({ ok: false, error: message, success: false }, 400);
      }
      claimData.damageOther = damageOtherTrimmed;
    } else {
      claimData.damageOther = "";
    }

    // 2. Generate claim_id.
    claimData.claimId = generateClaimId(claimData.location);

    // 3. Resolve photos.
    //
    // Brief 146 JSON mode: photos were uploaded out-of-band to R2 before
    // submit. Worker HEADs each referenced key to confirm existence +
    // capture authoritative size/mime, then attaches the metadata to
    // claimData.photos. Missing refs → 422 photo_not_found (the customer
    // can re-add the failing photo from the form's retry icon).
    //
    // Legacy multipart mode: per-category file parts are streamed to R2
    // here via uploadClaimPhoto (HEIC→JPEG via the Images binding when
    // bound). Same code path the form has used since legacy/damagemanager.js
    // shipped; preserved until the back-compat window closes.
    if (inputs.mode === "json") {
      const missing: string[] = [];
      for (const category of PHOTO_CATEGORIES) {
        const refs = inputs.photoRefs[category.field] ?? [];
        for (let i = 0; i < refs.length; i++) {
          const ref = refs[i]!;
          let head: R2Object | null;
          try {
            head = await env.R2_BUCKET.head(ref.r2_key);
          } catch (headErr) {
            console.warn("[claim.submit] R2 head failed", ref.r2_key, headErr);
            head = null;
          }
          if (!head) {
            missing.push(ref.r2_key);
            continue;
          }
          const mime =
            head.httpMetadata?.contentType ?? "application/octet-stream";
          const ext = extForMime(mime) ?? (ref.r2_key.split(".").pop() ?? "jpg");
          const sanitizedType = category.type.replace(/\s+/g, "_").toLowerCase();
          claimData.photos.push({
            r2Key: ref.r2_key,
            photoType: category.type,
            fileName:
              ref.original_filename ||
              `${claimData.claimId}_${sanitizedType}_${i + 1}.${ext}`,
            fileSize: head.size,
            contentType: mime
          });
        }
      }
      if (missing.length > 0) {
        const message = "photo_not_found";
        if (browserMode) {
          const slug =
            encodeURIComponent(claimData.location || "") || "unknown";
          const target = new URL(
            `${baseOrigin}/claims/${slug}?error=${encodeURIComponent(
              "Some photos failed to upload. Please re-add them and submit again."
            )}`
          );
          return Response.redirect(target.toString(), 303);
        }
        return json(
          { ok: false, error: message, success: false, missing },
          422
        );
      }
    } else {
      // Legacy multipart path. Same loop as pre-Brief-146.
      for (const category of PHOTO_CATEGORIES) {
        const files = inputs.multipartFiles.getAll(category.field);
        for (let i = 0; i < files.length; i++) {
          const f = files[i];
          if (!(f instanceof File) || f.size === 0) continue;
          const result = await uploadClaimPhoto({
            bucket: env.R2_BUCKET,
            file: f,
            claimId: claimData.claimId,
            photoType: category.type,
            index: i,
            images: env.IMAGES
          });
          if (result) {
            const sanitizedType = category.type.replace(/\s+/g, "_").toLowerCase();
            claimData.photos.push({
              r2Key: result.key,
              photoType: category.type,
              fileName: `${claimData.claimId}_${sanitizedType}_${i + 1}.${result.ext}`,
              fileSize: f.size,
              contentType: result.contentType
            });
          }
        }
      }
    }

    // 4. Save full submission JSON to R2 — unconditional (canonical record
    // even if D1/PA fail). Legacy:153.
    await saveClaimSubmission(env.R2_BUCKET, claimData as unknown as { claimId: string });

    // 5. Write to D1. Best-effort — failures logged but don't break the
    // pipeline (legacy:157). writeClaimBatch handles location_pretty
    // resolution internally — we pre-resolve here to match the legacy
    // post-D1 update of claimData.locationPretty so the PA POST sees the
    // canonical value.
    let d1Success = false;
    // Brief 140 — capture the D1 throw's message for the truthful 500
    // response + the INCIDENTS_EMAIL alert. Truncated to 500 chars at the
    // helper boundary; null when D1 succeeded.
    let d1ErrorMessage: string | null = null;
    try {
      const initialStatus = determinationToClaimStatus(claimData.determination);
      const phoneDigits = claimData.customerPhone.replace(/\D/g, "") || null;
      const yearInt =
        claimData.vehicleYear && /^\d+$/.test(claimData.vehicleYear.trim())
          ? Number.parseInt(claimData.vehicleYear.trim(), 10)
          : null;
      const equipmentRelated: 0 | 1 =
        claimData.equipmentInvolved && claimData.equipmentInvolved !== "N/A" ? 1 : 0;
      const staffNotesParts: string[] = [];
      if (claimData.customerTold.trim()) {
        staffNotesParts.push(`Told customer: ${claimData.customerTold.trim()}`);
      }
      if (claimData.customerDemeanor.trim()) {
        staffNotesParts.push(`Customer demeanor: ${claimData.customerDemeanor.trim()}`);
      }
      const submittedBy = claimData.employeeName || "Unknown";

      // Staff-entered date AND time the customer says the damage occurred.
      // Required — validated by the incidentDate gate earlier in the handler,
      // so incidentDateNormalized is a non-null string by the time we build
      // the insert. Kept OUT of claimData/the PA payload (avoids SharePoint
      // schema drift — see the drift warning on the claimData construction
      // above) and only persisted to D1. <input type="datetime-local"> posts
      // 'YYYY-MM-DDTHH:MM' (optionally :SS); stored with a space separator so
      // SQLite datetime()/julianday() read it cleanly.
      const incidentDate = incidentDateNormalized;

      const insert: ClaimInsert = {
        claim_id: claimData.claimId,
        location_code: claimData.location.toLowerCase(),
        location_pretty: claimData.locationPretty || claimData.location,
        customer_name: claimData.customerName,
        customer_phone: phoneDigits,
        customer_email: claimData.customerEmail || null,
        customer_mailing_address: claimData.mailingAddress || null,
        vehicle_year: yearInt,
        vehicle_make: claimData.vehicleMake || null,
        vehicle_model: claimData.vehicleModel || null,
        vehicle_color: claimData.vehicleColor || null,
        license_plate: claimData.licensePlate || null,
        damage_description: claimData.issueDescription || null,
        preexisting_damage: claimData.preExistingDamage || null,
        vehicle_condition: claimData.vehicleCondition || null,
        staff_notes: staffNotesParts.length > 0 ? staffNotesParts.join("\n\n") : null,
        determination: (claimData.determination || null) as ClaimDetermination | null,
        submitted_by: submittedBy,
        equipment_related: equipmentRelated,
        equipment_piece: claimData.equipmentInvolved || null,
        damage_type: claimData.damageType || null,
        damage_other: claimData.damageOther || null,
        initial_status: initialStatus,
        submitted_at: claimData.submittedAt,
        incident_date: incidentDate,
        // Brief 138 Phase 3 — persist the client-supplied UUID so a future
        // retry hits getClaimByIdempotencyKey above and dedups onto this row.
        idempotency_key: idempotencyKey,
        photos: claimData.photos.map((p) => ({
          photoType: p.photoType,
          fileName: p.fileName,
          r2Key: p.r2Key,
          contentType: p.contentType,
          fileSize: p.fileSize
        }))
      };
      await writeClaimBatch(env.DB, insert);
      d1Success = true;

      // location_pretty canonical resolution. Source: legacy/damagemanager.js:
      // 357-371 — the legacy worker does this lookup INSIDE writeClaimToD1 and
      // mutates claimData.locationPretty in place so the subsequent PA POST
      // sees the canonical value. We do it here (in the worker, post-batch)
      // instead so @splash/db-d1 stays free of side effects on its inputs.
      //
      // Brief 33: lookup now hits Supabase pricing_simple instead of D1
      // locations. Best-effort: if the Supabase lookup fails or returns null,
      // claimData keeps the form-supplied value. The D1 row was already
      // inserted with the (possibly non-canonical) form value; rerunning that
      // overwrite would require a separate UPDATE — left for a follow-up if
      // it matters in practice. The PA-bound copy of the value is what Power
      // Automate consumes for SharePoint, so this resolution closes the legacy
      // parity gap for downstream displays.
      try {
        const canonical = await getActiveLocationByCode(env, claimData.location);
        if (canonical?.location_pretty) {
          claimData.locationPretty = canonical.location_pretty;
        }
      } catch (locErr) {
        console.warn("location_pretty Supabase resolution failed (using form value):", locErr);
      }

      // Brief 42 — auto-create a MaintainX work order when the claim flags
      // equipment as involved. Fail-soft: a MaintainX failure logs an
      // activity-log entry and is otherwise invisible to the customer; the
      // claim record + R2 + SharePoint pipeline continue regardless.
      // Hook fires AFTER writeClaimBatch succeeds and BEFORE the SharePoint
      // (Power Automate) POST so the WO ID can ride along on the PA payload.
      if (insert.equipment_related === 1) {
        if (!env.MAINTAINX_API_KEY) {
          console.warn(
            "[mx] MAINTAINX_API_KEY unbound; skipping WO creation for",
            claimData.claimId
          );
        } else {
          // Construct a transient ClaimRow shape for the helper. The columns
          // the helper reads come straight off `insert`; the rest are defaulted
          // to the post-INSERT shape (status_updated_by mirrors submitted_by,
          // audit stamps null, no soft-delete). Avoids an extra D1 round trip.
          const claimRowForMx: ClaimRow = {
            claim_id: insert.claim_id,
            location_code: insert.location_code,
            location_pretty: claimData.locationPretty || insert.location_pretty,
            customer_name: insert.customer_name,
            customer_phone: insert.customer_phone,
            customer_email: insert.customer_email,
            customer_mailing_address: insert.customer_mailing_address,
            vehicle_year: insert.vehicle_year,
            vehicle_make: insert.vehicle_make,
            vehicle_model: insert.vehicle_model,
            vehicle_color: insert.vehicle_color,
            license_plate: insert.license_plate,
            damage_description: insert.damage_description,
            preexisting_damage: insert.preexisting_damage,
            vehicle_condition: insert.vehicle_condition,
            staff_notes: insert.staff_notes,
            determination: insert.determination as ClaimDetermination | null,
            submitted_by: insert.submitted_by,
            equipment_related: insert.equipment_related,
            equipment_piece: insert.equipment_piece,
            damage_type: insert.damage_type,
            damage_other: insert.damage_other,
            lifecycle_state: lifecycleForStatus(insert.initial_status),
            claim_status: insert.initial_status,
            contact_status: null,
            submitted_at: insert.submitted_at,
            incident_date: insert.incident_date,
            status_updated_at: null,
            status_updated_by: insert.submitted_by,
            updated_at: null,
            gm_approved_at: null,
            gm_approved_by: null,
            rm_approved_at: null,
            rm_approved_by: null,
            ceo_approved_at: null,
            ceo_approved_by: null,
            approved_amount: null,
            approved_quote_id: null,
            parts_ordered: null,
            vendor_name: null,
            maintainx_workorder_id: null,
            fault_category: null,
            deleted_at: null
          };

          let mxLocationId: number | null = null;
          try {
            mxLocationId = await getMaintainXLocationId(env, insert.location_code);
          } catch (mxLocErr) {
            console.warn(
              "[mx] getMaintainXLocationId threw — proceeding without locationId:",
              mxLocErr
            );
          }

          const mxMode = env.MAINTAINX_MODE ?? "test";
          const mxBaseUrl = env.MAINTAINX_BASE_URL ?? "https://api.getmaintainx.com/v1";
          // Brief 145 — derive apps/web admin base from the inbound request
          // origin so a staging-test submission embeds a staging admin link in
          // the WO description (not a production link that 404s).
          const mxAppsWebBaseUrl = resolveAdminBase(request, env);

          const ctrl = new AbortController();
          const timeoutId = setTimeout(() => ctrl.abort(), 8000);
          let maintainxResult: MaintainXResult;
          try {
            maintainxResult = await createMaintainXWorkOrder({
              claim: claimRowForMx,
              locationPretty: claimRowForMx.location_pretty,
              maintainxLocationId: mxLocationId,
              apiKey: env.MAINTAINX_API_KEY,
              mode: mxMode,
              baseUrl: mxBaseUrl,
              appsWebBaseUrl: mxAppsWebBaseUrl,
              signal: ctrl.signal
            });
          } catch (mxErr) {
            // createMaintainXWorkOrder is supposed to never throw; defense-in-depth.
            maintainxResult = {
              ok: false,
              workOrderId: null,
              error: mxErr instanceof Error ? mxErr.message : String(mxErr),
              status: 0,
              request: {}
            };
          } finally {
            clearTimeout(timeoutId);
          }

          if (maintainxResult.ok && maintainxResult.workOrderId != null) {
            try {
              await updateMaintainXWorkOrderId(
                env.DB,
                insert.claim_id,
                maintainxResult.workOrderId
              );
            } catch (updateErr) {
              console.error(
                "[mx] updateMaintainXWorkOrderId failed for",
                insert.claim_id,
                updateErr
              );
            }
            // Ride along on PA payload + R2 fallback + outcome page.
            claimData.maintainxWorkorderId = maintainxResult.workOrderId;
            try {
              await logActivity(env.DB, {
                claimId: insert.claim_id,
                activityType: "note",
                notes: `[maintainx] Work order #${maintainxResult.workOrderId} created (mode: ${mxMode})`,
                actorEmail: null,
                actorName: insert.submitted_by
              });
            } catch (logErr) {
              console.error("[mx] activity log (success) failed:", logErr);
            }
          } else {
            console.error(
              "[mx] WO creation failed for",
              insert.claim_id,
              maintainxResult.error
            );
            try {
              await logActivity(env.DB, {
                claimId: insert.claim_id,
                activityType: "note",
                notes: `[maintainx] Work order creation failed — ${maintainxResult.error ?? "unknown error"} (status: ${maintainxResult.status}, mode: ${mxMode})`,
                actorEmail: null,
                actorName: "system"
              });
            } catch (logErr) {
              console.error("[mx] activity log (failure) failed:", logErr);
            }
          }
        }
      }
    } catch (d1Error) {
      console.error("D1 write failed:", d1Error);
      d1ErrorMessage =
        d1Error instanceof Error ? d1Error.message : String(d1Error);
    }

    // 6. POST to Power Automate. Body shape MUST match legacy claimData
    // (handleClaimSubmission line 171: `body: JSON.stringify(claimData)`).
    let powerAutomateSuccess = false;
    if (env.POWER_AUTOMATE_URL) {
      try {
        const paResponse = await fetch(env.POWER_AUTOMATE_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(claimData)
        });
        if (paResponse.ok) {
          powerAutomateSuccess = true;
        } else {
          console.error("Power Automate POST failed:", paResponse.status);
        }
      } catch (paError) {
        console.error("Power Automate POST error:", paError);
      }
    } else {
      console.warn(
        "POWER_AUTOMATE_URL not bound — skipping PA POST (claim still in R2 + D1)"
      );
    }

    // 7. R2 fallback on PA failure.
    if (!powerAutomateSuccess) {
      await saveFailedSubmission(
        env.R2_BUCKET,
        claimData as unknown as { claimId: string }
      );
    }

    // 8. Brief 32 — generate the customer-facing claim summary PDF, store
    // it in R2 at `claims/<claimId>/summary.pdf`, and (if the customer-
    // email webhook is bound) hand PA the URL + base64 to email the
    // customer their copy. PDF generation MUST NOT fail the submission;
    // the whole block is wrapped in try/catch and logs + swallows on error.
    let summaryPdfUrl: string | undefined;
    try {
      const pdfBytes = await buildAndStoreClaimSummaryPdf(
        env,
        claimData,
        baseOrigin
      );
      if (pdfBytes) {
        summaryPdfUrl = `${baseOrigin}/claims-api/summary/${encodeURIComponent(
          claimData.claimId
        )}`;
        // Fire-and-forget customer-email webhook. Fail-soft and silent when
        // the env var isn't configured (intentional staging-without-PA
        // posture). Errors logged + swallowed so submission still returns ok.
        if (env.CUSTOMER_CLAIM_WEBHOOK_URL) {
          // Brief 48 — resolve `site_email` from Supabase `locations` so PA
          // can use it as the Reply-To header. Lookup is fail-soft: any
          // throw or missing row collapses to null and the payload still
          // ships (PA falls back to the From mailbox for replies).
          let siteEmail: string | null = null;
          try {
            const contact = await getLocationContactInfo(
              env,
              claimData.location
            );
            siteEmail = contact.site_email;
          } catch (siteEmailErr) {
            console.warn(
              "site_email Supabase resolution failed (defaulting to null):",
              siteEmailErr
            );
          }
          await fireCustomerClaimWebhook(
            env.CUSTOMER_CLAIM_WEBHOOK_URL,
            claimData,
            pdfBytes,
            summaryPdfUrl,
            siteEmail
          );
        }
        // Brief 102 — parallel internal new-claim notification. Fans out to
        // the location's rm_email / site_email / am_email plus the
        // operator-configured INCIDENTS_EMAIL via a separate PA flow. Reuses
        // pdfBytes + summaryPdfUrl above so there's no second PDF generation.
        // Wrapped in its own try/catch as defense-in-depth even though the
        // inner helper swallows its own errors; the outer Brief 32 try/catch
        // is the final net.
        if (env.INTERNAL_NEW_CLAIM_WEBHOOK_URL) {
          try {
            await fireInternalNewClaimNotification({
              env,
              request,
              pdfBytes,
              summaryPdfUrl,
              claimData,
              baseOrigin
            });
          } catch (notifyErr) {
            console.error(
              `[internal-new-claim] pipeline failed for ${claimData.claimId}:`,
              notifyErr
            );
          }
        }
      }
    } catch (pdfErr) {
      console.error(
        `Claim summary PDF pipeline failed for ${claimData.claimId}:`,
        pdfErr
      );
    }

    // Brief 140 — when D1 failed, the customer must NOT see the success card.
    // Fire an INCIDENTS_EMAIL alert so an operator can manually backfill from
    // the R2 submission JSON, then return a truthful 500. claim_id +
    // summary_pdf_url ride along on the body so the customer can still
    // download their PDF copy and the operator has a recovery handle.
    if (!d1Success) {
      if (env.INTERNAL_NEW_CLAIM_WEBHOOK_URL) {
        const alertPromise = fireD1FailureAlert({
          env,
          claimData,
          summaryPdfUrl,
          errorMessage: d1ErrorMessage ?? "(unknown D1 error)"
        }).catch((alertErr) => {
          console.error(
            `[d1-failure] alert pipeline threw for ${claimData.claimId}:`,
            alertErr
          );
        });
        ctx.waitUntil(alertPromise);
      }

      const userMessage =
        "Claim was received but not persisted to admin storage. Please notify a manager and save your claim ID for reference.";

      if (browserMode) {
        // Browser submit can't really consume a 500 the way the form's JS
        // fetch caller does — the form's fetch path is the only retry-aware
        // surface. For browser-direct (non-JS) submitters we still bounce
        // back to the form with the error so they see SOMETHING actionable;
        // their submission is recoverable from R2.
        const slug =
          encodeURIComponent(claimData.location || "") || "unknown";
        const target = new URL(
          `${baseOrigin}/claims/${slug}?error=${encodeURIComponent(userMessage)}`
        );
        return Response.redirect(target.toString(), 303);
      }

      return json(
        {
          ok: false,
          d1Success: false,
          claim_id: claimData.claimId,
          success: false,
          claimId: claimData.claimId,
          powerAutomateSuccess,
          photosUploaded: claimData.photos.length,
          error: userMessage,
          ...(summaryPdfUrl ? { summary_pdf_url: summaryPdfUrl } : {})
        },
        500
      );
    }

    if (browserMode) {
      const slug =
        encodeURIComponent(claimData.location || "") || "unknown";
      const target = new URL(
        `${baseOrigin}/claims/${slug}/thanks?id=${encodeURIComponent(claimData.claimId)}`
      );
      return Response.redirect(target.toString(), 303);
    }

    // Brief 25: form's fetch reads `{ ok, claim_id }`. The legacy
    // `success` / `claimId` keys are mirrored alongside for any
    // programmatic caller that may still consume the older shape.
    // Brief 32: `summary_pdf_url` is included when the post-submit PDF
    // pipeline succeeded; absent on PDF-failure (fail-soft).
    return json({
      ok: true,
      claim_id: claimData.claimId,
      success: true,
      claimId: claimData.claimId,
      powerAutomateSuccess,
      d1Success,
      photosUploaded: claimData.photos.length,
      ...(summaryPdfUrl ? { summary_pdf_url: summaryPdfUrl } : {})
    });
  } catch (error) {
    console.error("Claim submission error:", error);
    const message = error instanceof Error ? error.message : "submission failed";

    if (browserMode) {
      // Best-effort: bounce the customer back to the form with an error
      // banner. We may not have the parsed slug if formData() itself threw,
      // so fall back to extracting it from the Referer header — the form
      // page posts from /claims/{slug}, so the Referer carries the slug.
      let slug = "unknown";
      const referer = request.headers.get("Referer");
      if (referer) {
        try {
          const refPath = new URL(referer).pathname;
          const match = refPath.match(/^\/claims\/([^/]+)/);
          if (match?.[1]) slug = match[1];
        } catch {
          // bad Referer — keep "unknown"
        }
      }
      const target = new URL(
        `${baseOrigin}/claims/${slug}?error=${encodeURIComponent(message)}`
      );
      return Response.redirect(target.toString(), 303);
    }

    // Brief 25: JSON failure shape includes `ok: false` for the form's JS.
    return json(
      {
        ok: false,
        error: message,
        success: false
      },
      500
    );
  }
}

/* ============================================================
 * POST /manage/api/claim/{id}/document/{docId}/edit
 *
 * Edit metadata only (vendor / amount / notes / pay_to_type / vendor_address).
 * To replace the file itself, the caller must delete the row and re-upload.
 * Source: legacy/damagemanager.js:2705 handleDocumentEdit.
 * ============================================================ */

async function handleDocumentEdit(
  request: Request,
  env: Env,
  session: Session,
  claimId: string,
  docIdStr: string
): Promise<Response> {
  if (!isOriginAllowed(request)) return jsonError(403, "bad origin");

  const guard = await loadAndScopeCheck(env, session, claimId);
  if (!guard.ok) return guard.response;

  const docId = Number.parseInt(docIdStr, 10);
  if (Number.isNaN(docId)) return jsonError(400, "Invalid document id.");

  const photos = await listPhotosForClaim(env.DB, claimId);
  const doc = photos.find((p) => p.id === docId);
  if (!doc) return jsonError(404, "Document not found.");

  if (!DOCUMENT_TYPES.has(doc.photo_type)) {
    return jsonError(403, "Only Quote and Receipt documents can be edited.");
  }
  if (!canMutateDocument(session, doc)) {
    return jsonError(403, "You don't have permission to edit this document.");
  }

  const form = await readForm(request);
  const vendor = (form.get("vendor") ?? "").trim() || null;
  const amountStr = (form.get("amount") ?? "").trim();
  const notesText = (form.get("notes") ?? "").trim() || null;
  const payToTypeRaw = (form.get("pay_to_type") ?? "").trim().toLowerCase();
  const vendorAddressInput = (form.get("vendor_address") ?? "").trim() || null;

  // Brief 20 — Quote rows must keep amount + pay_to_type set after every
  // edit. Apps/web's edit form pre-fills both with the existing values so
  // operators don't have to re-type them; clearing them in the form is
  // treated as an explicit invalid edit and rejected here. Receipt rows
  // stay loose (their fields are advisory, not load-bearing for the
  // check-request PDF).
  if (doc.photo_type === "Quote") {
    if (!amountStr) {
      return jsonError(400, "Amount is required for Quote documents.");
    }
    if (!payToTypeRaw) {
      return jsonError(400, "Pay to (customer or vendor) is required for Quote documents.");
    }
  }

  let amount: number | null = null;
  if (amountStr) {
    const parsed = Number.parseFloat(amountStr);
    if (Number.isNaN(parsed) || parsed < 0) {
      return jsonError(400, "Amount must be a non-negative number.");
    }
    amount = parsed;
  }
  if (notesText && notesText.length > 5000) {
    return jsonError(400, "Notes are too long (max 5000 characters).");
  }

  // pay_to_type editing rules — Quote rows only. Source: legacy:2769-2802.
  let payToType: PayToType | null = doc.pay_to_type ?? null;
  let payToVendorAddress: string | null = doc.vendor_address ?? null;
  if (doc.photo_type === "Quote") {
    if (payToTypeRaw && payToTypeRaw !== "customer" && payToTypeRaw !== "vendor") {
      return jsonError(400, "Pay to must be 'customer' or 'vendor'.");
    }
    if (payToTypeRaw) {
      payToType = payToTypeRaw as PayToType;
    }
    if (payToType === "vendor") {
      // Brief 20 — vendor pay_to_type requires both vendor (display name)
      // and vendor_address. Form pre-fills both so an unmodified edit
      // re-submits the existing values; explicit clears are rejected.
      if (!vendor) {
        return jsonError(
          400,
          "Vendor name is required when paying the vendor directly."
        );
      }
      if (!vendorAddressInput && !payToVendorAddress) {
        return jsonError(
          400,
          "Vendor address is required when paying the vendor directly."
        );
      }
      payToVendorAddress = vendorAddressInput ?? payToVendorAddress;
      if (payToVendorAddress && payToVendorAddress.length > 1000) {
        return jsonError(400, "Vendor address is too long (max 1000 characters).");
      }
    } else if (payToType === "customer") {
      // Switching to customer clears any prior vendor address.
      payToVendorAddress = null;
    }
  }

  try {
    await updateDocMetadata(env.DB, {
      id: docId,
      vendor,
      amount,
      notes: notesText,
      payToType,
      vendorAddress: payToVendorAddress
    });
    const summary = `Edited ${doc.photo_type}${vendor ? ` from ${vendor}` : ""}${
      amount !== null ? ` — $${amount.toFixed(2)}` : ""
    } (${doc.filename || ""})`;
    // Legacy uses 'document_added' for edits too. Preserved for legacy
    // parity — see ActivityType doc in @splash/types/claims for the
    // 'document_removed' carve-out we DID make for deletes.
    await logActivity(env.DB, {
      claimId,
      activityType: "document_added",
      notes: summary,
      actorEmail: session.email,
      actorName: session.email
    });
    await touchClaim(env.DB, claimId);
  } catch (err) {
    console.error("handleDocumentEdit failed:", err);
    return jsonError(500, "Failed to update document.");
  }
  return json({ ok: true });
}

/* ============================================================
 * GET /manage/api/claim/{id}/quote/{quoteId}/preview-check-request.pdf
 *
 * Pure preview — no DB write, no R2 storage, no email. Renders a draft
 * PDF inline so reviewers can see what the real check request would look
 * like before they commit to the transition.
 *
 * Source: legacy/damagemanager.js:2133 handleCheckRequestPreview.
 *
 * No isOriginAllowed gate — GET requests are not state-changing.
 * ============================================================ */

async function handleCheckRequestPreview(
  env: Env,
  session: Session,
  claimId: string,
  quoteIdStr: string
): Promise<Response> {
  const guard = await loadAndScopeCheck(env, session, claimId);
  if (!guard.ok) return guard.response;
  const { claim } = guard;

  const quoteId = Number.parseInt(quoteIdStr, 10);
  if (Number.isNaN(quoteId)) return jsonError(400, "Invalid quote id.");

  const photos = await listPhotosForClaim(env.DB, claimId);
  const quote = photos.find(
    (p) => p.id === quoteId && p.photo_type === "Quote" && !p.deleted_at
  );
  if (!quote) return jsonError(404, "Quote not found.");

  // Quote needs the data the PDF will fill.
  if (quote.amount === null || quote.amount === undefined || !quote.pay_to_type) {
    return jsonError(
      400,
      "Quote needs an amount and pay-to selection before preview. Edit the quote to add them."
    );
  }
  if (quote.pay_to_type === "vendor" && !quote.vendor_address) {
    return jsonError(
      400,
      "Quote pay-to is set to vendor but no vendor address is on file."
    );
  }

  // Preview signatures are intentionally placeholder strings — this is a
  // draft, not the real signed copy. The "DRAFT — NOT FOR PAYMENT" approval
  // line ensures a printed preview can't be mistaken for the real thing.
  // Source: legacy:2165.
  const fields = buildCheckRequestFields(
    claim,
    quote,
    "(preview — not signed)",
    "DRAFT — NOT FOR PAYMENT"
  );

  let pdfBytes: Uint8Array;
  try {
    // Brief 171 — preview also bundles the approved quote so reviewers
    // see exactly what the real check request will look like (header band
    // + AcroForm + appended quote pages). Same fail-soft posture as the
    // real path: append failure logs and falls back to the form-only PDF.
    const generated = await generateCheckRequestPdf(
      env.R2_BUCKET,
      fields,
      quote,
      env.IMAGES
    );
    pdfBytes = generated.pdfBytes;
  } catch (err) {
    console.error("handleCheckRequestPreview: PDF generation failed:", err);
    return jsonError(
      500,
      `Could not generate preview: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // Cast: pdf-lib returns Uint8Array<ArrayBufferLike> but workers-types
  // BodyInit is the older Uint8Array<ArrayBuffer>. Runtime is fine — this
  // is a TS lib/types-version mismatch, not a real type error.
  return new Response(pdfBytes as unknown as BodyInit, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="preview_check_request_claim_${claim.claim_id}.pdf"`,
      "Cache-Control": "no-store"
    }
  });
}

/* ============================================================
 * GET /claims-api/summary/{claimId} — Brief 32
 *
 * Streams the auto-generated claim summary PDF stored at
 * `claims/<claimId>/summary.pdf` in R2. Public read (no auth gate),
 * mirroring the photo-serving security posture. Customers reach this URL
 * via the post-submit outcome card and the customer-email webhook.
 * ============================================================ */

/**
 * Brief 146 — serve an R2 object whose key was provided verbatim (no
 * prefix-prepend). Used for `claim-uploads/{pendingId}/{nanoid}.{ext}`
 * objects written by the OOB upload endpoint. Same cache + headers
 * posture as `serveClaimPhoto` so admin viewers don't need a separate
 * code path.
 */
async function serveR2KeyDirect(
  bucket: R2Bucket,
  key: string,
  images?: ImagesBinding
): Promise<Response> {
  try {
    const obj = await bucket.get(key);
    if (!obj) {
      return new Response("Photo not found", { status: 404 });
    }
    // HEIC/HEIF objects are transcoded to JPEG when the Images binding is
    // available so non-Safari admin viewers can render the preview. Shared
    // with serveClaimPhoto via buildPhotoResponse.
    return await buildPhotoResponse(obj, key, images);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    return new Response("Error fetching photo: " + message, { status: 500 });
  }
}

async function handleServeClaimSummary(
  env: Env,
  claimId: string
): Promise<Response> {
  // Defensive: claim_id pattern is letters/digits/dash; reject pathy input.
  if (!/^[A-Za-z0-9_-]+$/.test(claimId)) {
    return new Response("Not found", { status: 404 });
  }
  const key = `claims/${claimId}/summary.pdf`;
  const obj = await env.R2_BUCKET.get(key);
  if (!obj) {
    return new Response("Not found", { status: 404 });
  }
  const headers = new Headers();
  headers.set("Content-Type", "application/pdf");
  headers.set(
    "Content-Disposition",
    `inline; filename="claim-${claimId}.pdf"`
  );
  // Same conservative cache as photo-serving (24h public).
  headers.set("Cache-Control", "public, max-age=86400");
  return new Response(obj.body, { headers });
}

/* ============================================================
 * Claim summary PDF pipeline — Brief 32
 *
 * Helper functions invoked from handleClaimSubmission's post-submit step.
 * All wrapped in try/catch by the caller — these may throw freely; the
 * caller logs and swallows.
 * ============================================================ */

/**
 * Load brand-logo PNG bytes for the summary PDF header.
 *
 * Tries R2 first (`assets/splash-logo-white.png` in damagedocs); falls
 * back to fetching ASSETS.logoWhite over HTTPS (the customer-facing form
 * already loads this URL). Returns a zero-length Uint8Array if both fail —
 * the PDF generator handles that path gracefully (header band still
 * renders with text only on the right).
 */
async function loadSummaryLogoBytes(env: Env): Promise<Uint8Array> {
  try {
    const obj = await env.R2_BUCKET.get(SUMMARY_LOGO_R2_KEY);
    if (obj) {
      return new Uint8Array(await obj.arrayBuffer());
    }
  } catch (err) {
    console.warn(
      "loadSummaryLogoBytes: R2 read failed, falling back to ASSETS.logoWhite",
      err
    );
  }
  try {
    const res = await fetch(ASSETS.logoWhite);
    if (res.ok) {
      return new Uint8Array(await res.arrayBuffer());
    }
    console.warn(
      `loadSummaryLogoBytes: ASSETS.logoWhite fetch returned ${res.status}`
    );
  } catch (err) {
    console.warn("loadSummaryLogoBytes: HTTPS fallback failed", err);
  }
  return new Uint8Array(0);
}

/**
 * Generate the claim summary PDF for a fresh submission and write it to
 * R2 at `claims/<claimId>/summary.pdf`. Returns the PDF bytes on success
 * (so the caller can also hand them to the customer-email webhook), or
 * null when generation/storage failed.
 *
 * The submission has already landed in D1 + R2 + (optionally) PA at this
 * point — the PDF is purely additive.
 */
async function buildAndStoreClaimSummaryPdf(
  env: Env,
  claimData: ClaimSubmissionPayload,
  _baseOrigin: string
): Promise<Uint8Array | null> {
  const logoPng = await loadSummaryLogoBytes(env);

  const input: ClaimSummaryPdfInput = {
    claimId: claimData.claimId,
    submittedAt: claimData.submittedAt,
    locationPretty: claimData.locationPretty || claimData.location,
    locationCode: claimData.location,
    customer: {
      name: claimData.customerName,
      email: claimData.customerEmail,
      phone: claimData.customerPhone || null,
      vehicleMake: claimData.vehicleMake,
      vehicleModel: claimData.vehicleModel,
      vehicleYear: claimData.vehicleYear,
      vehicleColor: claimData.vehicleColor || null,
      licensePlate: claimData.licensePlate || null,
      // The claim form does not collect a license-plate state today;
      // leave null. If a future field is added, surface it here.
      licenseState: null,
      whatHappened: claimData.issueDescription
    },
    assessment: {
      staffName: claimData.employeeName || null,
      determination: claimData.determination || "",
      whatCustomerWasTold: claimData.customerTold || ""
    },
    logoPng
  };

  let pdfBytes: Uint8Array;
  try {
    pdfBytes = await generateClaimSummaryPdf(input);
  } catch (err) {
    console.error(
      `generateClaimSummaryPdf failed for ${claimData.claimId}:`,
      err
    );
    return null;
  }

  const key = `claims/${claimData.claimId}/summary.pdf`;
  try {
    await env.R2_BUCKET.put(key, pdfBytes, {
      httpMetadata: { contentType: "application/pdf" },
      customMetadata: {
        claimId: claimData.claimId,
        generatedAt: new Date().toISOString()
      }
    });
  } catch (err) {
    console.error(
      `R2 put failed for claim summary ${claimData.claimId}:`,
      err
    );
    return null;
  }
  return pdfBytes;
}

/**
 * Feature 3 — build the FULL internal claim summary for Accounts Payable,
 * bundled into the check request PDF. Distinct from the customer-facing
 * summary.pdf (buildAndStoreClaimSummaryPdf): this one is generated fresh
 * from the current ClaimRow at submit-for-payment time — so it reflects any
 * post-submission assessment (determination, approved amount, fault
 * category, vehicle condition) — and includes the internal-only fields the
 * customer copy deliberately omits. Ephemeral: NOT stored in R2. Fail-soft:
 * returns null on any error so the caller falls back to the summary link.
 */
async function buildFullClaimSummaryPdf(
  env: Env,
  claim: ClaimRow,
  // The AP-branch `claim` is a pre-update snapshot; pass the destination
  // status so the summary shows the current ("Submitted for Payment")
  // status rather than the one it's transitioning away from.
  statusOverride?: ClaimStatus
): Promise<Uint8Array | null> {
  try {
    const logoPng = await loadSummaryLogoBytes(env);
    const damageType =
      claim.damage_type === "Other" && claim.damage_other
        ? `Other — ${claim.damage_other}`
        : claim.damage_type;
    const input: ClaimSummaryPdfInput = {
      claimId: claim.claim_id,
      submittedAt: claim.submitted_at,
      locationPretty: claim.location_pretty || claim.location_code,
      locationCode: claim.location_code,
      customer: {
        name: claim.customer_name,
        email: claim.customer_email ?? "",
        phone: claim.customer_phone,
        vehicleMake: claim.vehicle_make ?? "",
        vehicleModel: claim.vehicle_model ?? "",
        vehicleYear: claim.vehicle_year != null ? String(claim.vehicle_year) : "",
        vehicleColor: claim.vehicle_color,
        licensePlate: claim.license_plate,
        licenseState: null,
        whatHappened: claim.damage_description ?? ""
      },
      assessment: {
        staffName: claim.submitted_by || null,
        determination: claim.determination ?? "",
        // Not persisted on the claims row — the customer-facing "Splash
        // Response" text lives only on the submission payload. Blank here.
        whatCustomerWasTold: ""
      },
      internal: {
        mailingAddress: claim.customer_mailing_address,
        damageType,
        equipmentRelated: claim.equipment_related === 1,
        equipmentPiece: claim.equipment_piece,
        preexistingDamage: claim.preexisting_damage,
        vehicleCondition: claim.vehicle_condition,
        faultCategory: claim.fault_category,
        staffNotes: claim.staff_notes,
        approvedAmount: claim.approved_amount,
        vendorName: claim.vendor_name,
        claimStatus: statusOverride ?? claim.claim_status
      },
      logoPng
    };
    return await generateClaimSummaryPdf(input);
  } catch (err) {
    console.error(
      `buildFullClaimSummaryPdf failed for ${claim.claim_id}:`,
      err
    );
    return null;
  }
}

/**
 * Encode bytes to base64 (Workers btoa is byte-safe via String.fromCharCode
 * loop). Mirrors the helper in pdf.ts but kept local to avoid adding an
 * export to the existing module.
 */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

/**
 * Fire the customer-email webhook with the claim summary URL + (optionally)
 * the base64-encoded PDF. Fail-soft: never throws; caller's try/catch
 * covers any escape.
 */
async function fireCustomerClaimWebhook(
  webhookUrl: string,
  claimData: ClaimSubmissionPayload,
  pdfBytes: Uint8Array,
  summaryPdfUrl: string,
  siteEmail: string | null
): Promise<void> {
  // Vehicle string for PA convenience: "2020 Honda Civic - Blue".
  const vehicleParts = [
    claimData.vehicleYear,
    claimData.vehicleMake,
    claimData.vehicleModel
  ].filter((p) => (p ?? "").toString().trim());
  let vehicle = vehicleParts.join(" ");
  if (claimData.vehicleColor && claimData.vehicleColor.trim()) {
    vehicle = vehicle
      ? `${vehicle} - ${claimData.vehicleColor.trim()}`
      : claimData.vehicleColor.trim();
  }

  // Omit the base64 attachment when the PDF is too large to keep the JSON
  // payload under PA's reasonable inbound limit (PA flows have varying
  // limits; 4 MB JSON is a common ceiling). PA can still fetch the URL.
  const includeBase64 = pdfBytes.byteLength <= CUSTOMER_WEBHOOK_BASE64_MAX_BYTES;

  const payload: Record<string, unknown> = {
    claim_id: claimData.claimId,
    submitted_at: claimData.submittedAt,
    location_pretty: claimData.locationPretty,
    location_code: claimData.location,
    customer_name: claimData.customerName,
    customer_email: claimData.customerEmail,
    customer_phone: claimData.customerPhone || null,
    vehicle,
    summary_pdf_url: summaryPdfUrl,
    // Brief 48 — per-location reply address (Supabase `locations.site_email`).
    // PA wires this to the confirmation email's Reply-To header so customer
    // replies route to the location inbox; null falls back to the From mailbox.
    site_email: siteEmail
  };
  if (includeBase64) {
    payload.summary_pdf_base64 = bytesToBase64(pdfBytes);
  }

  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      console.error(
        `CUSTOMER_CLAIM_WEBHOOK_URL POST failed for ${claimData.claimId}: status ${res.status}`
      );
    }
  } catch (err) {
    console.error(
      `CUSTOMER_CLAIM_WEBHOOK_URL POST error for ${claimData.claimId}:`,
      err
    );
  }
}

/* ============================================================
 * Brief 102 — internal new-claim notification pipeline
 * ============================================================
 *
 * Fired by `handleClaimSubmission` after the customer webhook, when
 * `INTERNAL_NEW_CLAIM_WEBHOOK_URL` is bound. Recipients are the
 * location's rm_email / site_email / am_email (resolved via the
 * widened `getLocationContactInfo`) plus the operator-configured
 * `INCIDENTS_EMAIL` [vars] entry. Same fail-soft posture as the
 * customer webhook: every external touch (contact lookup, photo list,
 * fetch) is wrapped in try/catch and degrades to nulls / empty.
 *
 * Reuses pdfBytes + summaryPdfUrl from the Brief 32 block so there's no
 * duplicate PDF generation; photos are listed from D1 immediately after
 * the claim insert.
 */
async function fireInternalNewClaimNotification(args: {
  env: Env;
  /** Inbound request — used by Brief 145's `resolveAdminBase` so staging
   *  submissions get a staging admin link in the webhook payload. */
  request: Request;
  pdfBytes: Uint8Array;
  summaryPdfUrl: string;
  claimData: ClaimSubmissionPayload;
  baseOrigin: string;
}): Promise<void> {
  const { env, request, pdfBytes, summaryPdfUrl, claimData, baseOrigin } = args;
  if (!env.INTERNAL_NEW_CLAIM_WEBHOOK_URL) return;

  // Contacts. Fail-soft: any throw collapses to all-nulls; the webhook
  // still fires with only the incidents inbox as a recipient (if set).
  let contacts: {
    site_email: string | null;
    rm_email: string | null;
    am_email: string | null;
  } = { site_email: null, rm_email: null, am_email: null };
  try {
    contacts = await getLocationContactInfo(env, claimData.location);
  } catch (err) {
    console.warn(
      `[internal-new-claim] contact lookup threw for ${claimData.location}`,
      err
    );
  }

  const incidents = (env.INCIDENTS_EMAIL ?? "").trim();
  const recipients = resolveInternalRecipients(
    contacts,
    incidents || null
  );

  // Photos. Fail-soft: lookup throw → photos: []. At submission time only
  // 'Damage' photos exist (Quote / Receipt come from the manage page later);
  // querying claim_photos unfiltered means future expansions are no-effort.
  let photos: ClaimPhotoForWebhook[] = [];
  try {
    const rows = await listPhotosForClaim(env.DB, claimData.claimId);
    photos = rows
      .filter((p) => !p.deleted_at && p.r2_key)
      .map((p) => {
        // serveClaimPhoto prepends "claims/" before the R2 .get(), so the
        // URL path must NOT include the prefix already baked into r2_key.
        // Mirrors damagePhotoUrl in apps/web (Brief 104 fix to Brief 102).
        const stripped = p.r2_key.startsWith("claims/")
          ? p.r2_key.slice("claims/".length)
          : p.r2_key;
        const segments = stripped.split("/").map(encodeURIComponent).join("/");
        return {
          url: `${baseOrigin}/claims-api/photo/${segments}`,
          mime: p.content_type ?? null,
          original_filename: p.filename ?? null,
          photo_type: p.photo_type ?? null,
          // claim_photos has no per-row upload timestamp; at submit time
          // every photo lands with the claim, so the claim's submission
          // timestamp is the authoritative upload time.
          uploaded_at: claimData.submittedAt
        };
      });
  } catch (err) {
    console.warn(
      `[internal-new-claim] photo list threw for ${claimData.claimId}`,
      err
    );
  }

  const vehicleParts = [
    claimData.vehicleYear,
    claimData.vehicleMake,
    claimData.vehicleModel
  ].filter((p) => (p ?? "").toString().trim());
  let vehicle = vehicleParts.join(" ");
  if (claimData.vehicleColor && claimData.vehicleColor.trim()) {
    vehicle = vehicle
      ? `${vehicle} - ${claimData.vehicleColor.trim()}`
      : claimData.vehicleColor.trim();
  }

  // Brief 145 — request-origin-derived; workers.dev rewrites to production,
  // staging.splashcarwashes.info passes through so operator emails land on
  // the same host the claim was submitted against.
  const baseUrl = resolveAdminBase(request, env);
  const adminUrl = `${baseUrl}/admin/damage/${encodeURIComponent(
    claimData.claimId
  )}`;

  const includeBase64 = pdfBytes.byteLength <= CUSTOMER_WEBHOOK_BASE64_MAX_BYTES;

  const payload: InternalNewClaimPayload = {
    claim_id: claimData.claimId,
    submitted_at: claimData.submittedAt,
    location_code: claimData.location,
    location_pretty: claimData.locationPretty || null,
    admin_url: adminUrl,
    customer_name: claimData.customerName,
    customer_email: claimData.customerEmail,
    customer_phone: claimData.customerPhone || null,
    vehicle: vehicle || "—",
    damage_type: claimData.damageType,
    damage_other: claimData.damageOther || null,
    issue_description: claimData.issueDescription || null,
    recipients,
    candidates: {
      rm_email: contacts.rm_email,
      site_email: contacts.site_email,
      am_email: contacts.am_email,
      incidents_email: incidents || null
    },
    summary_pdf_url: summaryPdfUrl,
    ...(includeBase64 ? { summary_pdf_base64: bytesToBase64(pdfBytes) } : {}),
    photos
  };

  await fireInternalNewClaimWebhook(
    env.INTERNAL_NEW_CLAIM_WEBHOOK_URL,
    payload
  );
}

/* ============================================================
 * Brief 101 — manage-page update notifications
 * ============================================================
 *
 * Fired by handleAddNote (every note add) and handleStatusTransition
 * (every status change whose `to` is in STATUS_NOTIFIES_NEXT). Both
 * call sites guard on env.CLAIM_UPDATE_WEBHOOK_URL being bound before
 * invoking; this helper additionally defends against unbound state.
 * Fail-soft: never throws, all errors logged + swallowed. The status
 * change / note write is already committed by the time we get here; a
 * notification failure cannot roll it back. Spawned with `void` so the
 * handler response is not blocked on the webhook round-trip.
 */
async function notifyClaimUpdate(args: {
  env: Env;
  /** Inbound request — used by Brief 145's `resolveAdminBase` so a
   *  staging note/transition embeds a staging admin link. */
  request: Request;
  changeType: ClaimUpdateChangeType;
  claim: ClaimRow;
  actorEmail: string;
  actorRole: string | null;
  fromStatus?: ClaimStatus;
  toStatus?: ClaimStatus;
  noteText?: string;
}): Promise<void> {
  const {
    env,
    request,
    changeType,
    claim,
    actorEmail,
    actorRole,
    fromStatus,
    toStatus,
    noteText
  } = args;
  try {
    if (!env.CLAIM_UPDATE_WEBHOOK_URL) return;

    // Decide who gets notified.
    let notifies: "gm" | "rm" | "both";
    if (changeType === "note") {
      notifies = "both";
    } else if (toStatus && STATUS_NOTIFIES_NEXT[toStatus]) {
      notifies = STATUS_NOTIFIES_NEXT[toStatus]!;
    } else {
      // Status change landed on a non-notifying status (admin / finance /
      // closed / vestigial) — exit cleanly with no webhook fired.
      return;
    }

    // Resolve the location's contact addresses. Fail-soft: any throw
    // collapses to nulls; the webhook still fires with an empty
    // recipients array (PA no-ops cleanly).
    let contacts: { rm_email: string | null; site_email: string | null } = {
      rm_email: null,
      site_email: null
    };
    try {
      contacts = await getLocationContactInfo(env, claim.location_code);
    } catch (err) {
      console.warn(
        `[claim-update] getLocationContactInfo threw for ${claim.location_code}; treating as null contacts`,
        err
      );
    }

    const recipients = resolveRecipients(notifies, contacts, actorEmail);

    // Brief 145 — request-origin-derived; workers.dev rewrites to production,
    // staging passes through.
    const baseUrl = resolveAdminBase(request, env);
    const adminUrl = `${baseUrl}/admin/damage/${encodeURIComponent(
      claim.claim_id
    )}`;

    const payload: ClaimUpdateWebhookPayload = {
      change_type: changeType,
      claim_id: claim.claim_id,
      customer_name: claim.customer_name ?? null,
      location_code: claim.location_code,
      location_pretty: claim.location_pretty ?? null,
      admin_url: adminUrl,
      actor: { email: actorEmail, dc_role: actorRole },
      recipients,
      candidates: contacts,
      ...(fromStatus ? { from_status: fromStatus } : {}),
      ...(toStatus ? { to_status: toStatus } : {}),
      ...(noteText ? { note_text: noteText.slice(0, 5000) } : {})
    };

    await fireClaimUpdateWebhook(env.CLAIM_UPDATE_WEBHOOK_URL, payload);
  } catch (err) {
    // Defense-in-depth: nothing reaches here unless one of the inner
    // helpers throws unexpectedly. Logged and swallowed.
    console.error(
      `[claim-update] notifyClaimUpdate failed for ${claim.claim_id}:`,
      err
    );
  }
}

/* ============================================================
 * Brief 65 — Daily open-claims summary cron
 * ============================================================ */

/**
 * Brief 65 — recipient role allow-list. Operator's 2026-05-07 decision:
 * every gm / rm / admin / super_admin gets the daily digest. Promote to a
 * per-user opt-in column (e.g., `subscribe_daily_summary`) when a specific
 * user requests opt-out without a role change. `listSummaryRecipients`
 * already filters server-side; this constant documents the intent and
 * gives a single edit point.
 */
const SUMMARY_DC_ROLES: ReadonlyArray<DamageRole> = [
  "gm",
  "rm",
  "admin",
  "super_admin"
];

/** Sentinel name shown in the digest when a location's RD or RM is null. */
const UNASSIGNED_NAME = "(unassigned)";

interface SummaryClaim {
  claim_id: string;
  customer_name: string | null;
  vehicle: string;
  claim_status: string;
  submitted_at: string;
  age_days: number;
}

interface SummaryLocation {
  location_code: string;
  location_pretty: string;
  count: number;
  claims: SummaryClaim[];
}

interface SummaryRm {
  rm_email: string | null;
  rm_name: string;
  count: number;
  locations: SummaryLocation[];
}

interface SummaryRd {
  rd_email: string | null;
  rd_name: string;
  count: number;
  regional_managers: SummaryRm[];
}

interface DigestPayload {
  user: {
    user_id: string;
    email: string;
    name: string | null;
    dc_role: DamageRole;
  };
  as_of: string;
  total_open: number;
  regional_directors: SummaryRd[];
}

/**
 * Top-level cron entry-point. Catastrophic errors (e.g., listClaims itself
 * fails) are logged and re-thrown so CF marks the invocation failed; per-
 * user errors stay swallowed inside the loop so one bad recipient doesn't
 * kill the batch.
 */
async function runDailySummaryCron(env: Env): Promise<void> {
  if (!env.DAILY_SUMMARY_WEBHOOK_URL) {
    console.warn("[daily-summary] DAILY_SUMMARY_WEBHOOK_URL unbound — skipping");
    return;
  }

  const asOf = new Date().toISOString();
  let recipients: SummaryRecipient[] = [];
  let locationsByCode: Map<string, LocationRosterEntry> = new Map();
  let allOpenClaims: Awaited<ReturnType<typeof listClaims>> = [];

  try {
    [recipients, locationsByCode, allOpenClaims] = await Promise.all([
      listSummaryRecipients(env),
      fetchLocationRoster(env),
      listClaims(env.DB, { lifecycle: "Open", limit: 5000 })
    ]);
  } catch (err) {
    console.error("[daily-summary] catastrophic load failure", err);
    throw err;
  }

  let sentCount = 0;
  let skippedEmptyCount = 0;
  let failedCount = 0;

  for (const user of recipients) {
    if (!SUMMARY_DC_ROLES.includes(user.dc_role)) continue;

    try {
      const isUnrestricted =
        user.dc_role === "admin" || user.dc_role === "super_admin";
      const userClaims = isUnrestricted
        ? allOpenClaims
        : allOpenClaims.filter((c) => user.dc_locations.includes(c.location_code));

      if (userClaims.length === 0) {
        skippedEmptyCount += 1;
        continue;
      }

      const payload = buildDigestPayload(user, userClaims, locationsByCode, asOf);
      const ok = await postDigest(env.DAILY_SUMMARY_WEBHOOK_URL, payload, user.email);
      if (ok) sentCount += 1;
      else failedCount += 1;
    } catch (err) {
      failedCount += 1;
      console.error("[daily-summary] per-user failure", {
        user_email: user.email,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  console.log("[daily-summary] batch complete", {
    recipients: recipients.length,
    sent: sentCount,
    skipped_empty: skippedEmptyCount,
    failed_post: failedCount
  });
}

/**
 * Build the hierarchical RD → RM → location → claims structure for one
 * recipient. Locations whose `rd_email`/`rm_email` are null bucket under
 * `(unassigned)`; locations missing entirely from `locationsByCode` (e.g.,
 * pricing_simple row was deleted but D1 still references the code) bucket
 * under `(unassigned)` for both levels with the location_code as
 * location_pretty.
 *
 * Sort order:
 *   - regional_directors / regional_managers / locations: count desc, then name asc
 *   - claims within each location: submitted_at asc (oldest first)
 */
function buildDigestPayload(
  user: SummaryRecipient,
  userClaims: ReadonlyArray<{
    claim_id: string;
    location_code: string;
    location_pretty: string | null;
    customer_name: string | null;
    vehicle_year: number | null;
    vehicle_make: string | null;
    vehicle_model: string | null;
    submitted_at: string;
    claim_status: string;
  }>,
  locationsByCode: Map<string, LocationRosterEntry>,
  asOf: string
): DigestPayload {
  // Group bucket: rd_key → rm_key → location_code → SummaryClaim[].
  // Keys use the email when present; sentinel "(unassigned)" otherwise. We
  // also stash the display name on the bucket so we don't have to re-look
  // up by key.
  interface RdBucket {
    rd_email: string | null;
    rd_name: string;
    rms: Map<string, RmBucket>;
  }
  interface RmBucket {
    rm_email: string | null;
    rm_name: string;
    locations: Map<string, LocationBucket>;
  }
  interface LocationBucket {
    location_code: string;
    location_pretty: string;
    claims: SummaryClaim[];
  }

  const rdBuckets = new Map<string, RdBucket>();
  const nowMs = Date.parse(asOf);

  for (const claim of userClaims) {
    const roster = locationsByCode.get(claim.location_code);
    const rdEmail = roster?.rd_email ?? null;
    const rdName = roster?.rd_name ?? null;
    const rmEmail = roster?.rm_email ?? null;
    const rmName = roster?.rm_name ?? null;
    const locationPretty =
      roster?.location_pretty ?? claim.location_pretty ?? claim.location_code;

    const rdKey = rdEmail ?? `__unassigned__::${rdName ?? ""}`;
    const rmKey = rmEmail ?? `__unassigned__::${rmName ?? ""}`;

    let rd = rdBuckets.get(rdKey);
    if (!rd) {
      rd = {
        rd_email: rdEmail,
        rd_name: rdName ?? UNASSIGNED_NAME,
        rms: new Map()
      };
      rdBuckets.set(rdKey, rd);
    }

    let rm = rd.rms.get(rmKey);
    if (!rm) {
      rm = {
        rm_email: rmEmail,
        rm_name: rmName ?? UNASSIGNED_NAME,
        locations: new Map()
      };
      rd.rms.set(rmKey, rm);
    }

    let loc = rm.locations.get(claim.location_code);
    if (!loc) {
      loc = {
        location_code: claim.location_code,
        location_pretty: locationPretty,
        claims: []
      };
      rm.locations.set(claim.location_code, loc);
    }

    loc.claims.push({
      claim_id: claim.claim_id,
      customer_name: claim.customer_name ?? null,
      vehicle: assembleVehicle(
        claim.vehicle_year,
        claim.vehicle_make,
        claim.vehicle_model
      ),
      claim_status: claim.claim_status,
      submitted_at: claim.submitted_at,
      age_days: ageDays(claim.submitted_at, nowMs)
    });
  }

  // Materialize the sorted, count-stamped output structure.
  const sortByCountThenName = <T extends { count: number; name: string }>(
    a: T,
    b: T
  ): number => (b.count - a.count) || a.name.localeCompare(b.name);

  const regional_directors: SummaryRd[] = [...rdBuckets.values()]
    .map((rd) => {
      const regional_managers: SummaryRm[] = [...rd.rms.values()]
        .map((rm) => {
          const locations: SummaryLocation[] = [...rm.locations.values()]
            .map((loc) => ({
              location_code: loc.location_code,
              location_pretty: loc.location_pretty,
              count: loc.claims.length,
              claims: loc.claims.sort((a, b) =>
                a.submitted_at.localeCompare(b.submitted_at)
              )
            }))
            .sort((a, b) =>
              sortByCountThenName(
                { count: a.count, name: a.location_pretty },
                { count: b.count, name: b.location_pretty }
              )
            );
          const count = locations.reduce((sum, l) => sum + l.count, 0);
          return {
            rm_email: rm.rm_email,
            rm_name: rm.rm_name,
            count,
            locations
          };
        })
        .sort((a, b) =>
          sortByCountThenName(
            { count: a.count, name: a.rm_name },
            { count: b.count, name: b.rm_name }
          )
        );
      const count = regional_managers.reduce((sum, r) => sum + r.count, 0);
      return {
        rd_email: rd.rd_email,
        rd_name: rd.rd_name,
        count,
        regional_managers
      };
    })
    .sort((a, b) =>
      sortByCountThenName(
        { count: a.count, name: a.rd_name },
        { count: b.count, name: b.rd_name }
      )
    );

  return {
    user: {
      user_id: user.user_id,
      email: user.email,
      name: user.name,
      dc_role: user.dc_role
    },
    as_of: asOf,
    total_open: userClaims.length,
    regional_directors
  };
}

function assembleVehicle(
  year: number | null,
  make: string | null,
  model: string | null
): string {
  const parts = [
    year != null ? String(year) : null,
    make ?? null,
    model ?? null
  ].filter((p): p is string => typeof p === "string" && p.trim().length > 0);
  return parts.length > 0 ? parts.join(" ") : "—";
}

function ageDays(submittedAt: string, nowMs: number): number {
  const t = Date.parse(submittedAt);
  if (!Number.isFinite(t)) return 0;
  const diff = Math.floor((nowMs - t) / 86_400_000);
  return diff < 0 ? 0 : diff;
}

/**
 * POST one digest. Returns true on 2xx, false on any non-2xx / network /
 * abort. Caller increments sent/failed counters accordingly.
 */
async function postDigest(
  webhookUrl: string,
  payload: DigestPayload,
  userEmail: string
): Promise<boolean> {
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000)
    });
    if (!res.ok) {
      console.error("[daily-summary] POST failed", {
        user_email: userEmail,
        status: res.status
      });
      return false;
    }
    return true;
  } catch (err) {
    console.error("[daily-summary] POST threw", {
      user_email: userEmail,
      error: err instanceof Error ? err.message : String(err)
    });
    return false;
  }
}

