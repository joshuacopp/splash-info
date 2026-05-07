
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
//                                                            JSON callers continue to receive JSON.)
//   GET  /claims-api/photo/{r2-key-suffix...}               — serve R2 photo
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
  getActiveLocationByCode,
  getLocationContactInfo,
  getMaintainXLocationId,
  listContactRoster,
  type SupabaseEnv
} from "@splash/db-supabase";
import { isOriginAllowed, json, jsonError, readForm } from "@splash/http";
import {
  generateClaimId,
  type ImagesBinding,
  saveClaimSubmission,
  saveFailedSubmission,
  serveClaimPhoto,
  uploadClaimPhoto
} from "@splash/storage-r2";
import type {
  ClaimDetermination,
  ClaimPhotoRow,
  ClaimRow,
  ClaimStatus,
  LifecycleState,
  PayToType
} from "@splash/types/claims";
import {
  CEO_APPROVAL_THRESHOLD,
  type ClaimTransitionDef,
  findTransition
} from "./transitions.js";
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
import { ASSETS } from "@splash/storage-r2";

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

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/+/, "");
    const parts = path.split("/").filter(Boolean);
    const method = request.method;

    try {
      /* ============================================================
       * Public APIs — no auth gate
       * ============================================================ */

      if (path === "claims-api/submit-claim" && method === "POST") {
        return handleClaimSubmission(request, env);
      }

      if (parts[0] === "claims-api" && parts[1] === "photo" && parts.length >= 3 && method === "GET") {
        const photoKey = parts.slice(2).join("/");
        // Public read of customer photos. Legacy/damagemanager.js:5666 has
        // no auth check here; preserved. R2 keys include a 4-char random
        // suffix in the claim_id (e.g., BIN-20260502-143055-AB12) which
        // provides obscurity but not real access control. If this becomes
        // a concern, add auth-gating in a follow-up.
        return serveClaimPhoto(env.R2_BUCKET, photoKey);
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

        return dispatchManageApi(request, env, auth.session, parts.slice(2), method);
      }

      return new Response("Not found", { status: 404 });
    } catch (err) {
      console.error("damage-worker request failed:", path, err);
      return jsonError(500, err instanceof Error ? err.message : "server error");
    }
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
  method: string
): Promise<Response> {
  // GET /manage/api/claims — list claims, dc_role-scoped.
  if (subParts.length === 1 && subParts[0] === "claims" && method === "GET") {
    return getClaimsList(env, session, new URL(request.url));
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
        return handleAddNote(request, env, session, claimId);
      }
      if (action === "transition" && method === "POST") {
        return handleStatusTransition(request, env, session, claimId);
      }
      if (action === "document" && method === "POST") {
        return handleDocumentUpload(request, env, session, claimId);
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
    lifecycle: (lifecycleParam === "All" ? "All" : lifecycleParam) as LifecycleState | "All",
    claimStatus: statusParam !== "All" ? (statusParam as ClaimStatus) : undefined,
    search,
    submittedFrom: normalizeSubmittedBound(submittedFromParam, "from"),
    submittedTo: normalizeSubmittedBound(submittedToParam, "to")
  };

  const claims = await listClaims(env.DB, filters);
  return json(claims);
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
  closed: number;
  approved: number;
  denied: number;
  repair_cost: number;
}

interface ReportingByLocationRow {
  location_code: string;
  location_pretty: string | null;
  open: number;
  closed: number;
  approved: number;
  denied: number;
  repair_cost: number;
}

interface ReportingByDamageTypeRow {
  damage_type: string;
  count: number;
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
  by_damage_type_approved: ReportingByDamageTypeRow[];
  by_damage_type_denied: ReportingByDamageTypeRow[];
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

  const lifecycleSql = `
    SELECT lifecycle_state, COUNT(*) AS n
    FROM claims
    WHERE submitted_at BETWEEN ?1 AND ?2
      AND location_code IN (${inPlaceholders})
      AND deleted_at IS NULL
    GROUP BY lifecycle_state
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
  const byLocationSql = `
    SELECT location_code,
           MAX(location_pretty) AS location_pretty,
           lifecycle_state,
           COUNT(*) AS n
    FROM claims
    WHERE submitted_at BETWEEN ?1 AND ?2
      AND location_code IN (${inPlaceholders})
      AND deleted_at IS NULL
    GROUP BY location_code, lifecycle_state
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
  const byDamageTypeOpenSql = `
    SELECT COALESCE(damage_type, '(none)') AS damage_type, COUNT(*) AS n
    FROM claims
    WHERE submitted_at BETWEEN ?1 AND ?2
      AND location_code IN (${inPlaceholders})
      AND deleted_at IS NULL
      AND lifecycle_state = 'Open'
    GROUP BY damage_type
    ORDER BY n DESC
  `;
  const byDamageTypeApprovedSql = `
    SELECT COALESCE(damage_type, '(none)') AS damage_type, COUNT(*) AS n
    FROM claims
    WHERE submitted_at BETWEEN ?1 AND ?2
      AND location_code IN (${inPlaceholders})
      AND deleted_at IS NULL
      AND (
        claim_status LIKE 'Approved —%'
        OR claim_status = 'Closed — Paid'
        OR claim_status = 'Closed — Approved/No Response'
      )
    GROUP BY damage_type
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

  const stmts = [
    env.DB.prepare(lifecycleSql).bind(...baseBindings),
    env.DB.prepare(approvedSql).bind(...baseBindings),
    env.DB.prepare(deniedSql).bind(...baseBindings),
    env.DB.prepare(costSql).bind(...baseBindings),
    env.DB.prepare(byLocationSql).bind(...baseBindings),
    env.DB.prepare(byLocationApprovedSql).bind(...baseBindings),
    env.DB.prepare(byLocationDeniedSql).bind(...baseBindings),
    env.DB.prepare(byLocationCostSql).bind(...baseBindings),
    env.DB.prepare(byDamageTypeOpenSql).bind(...baseBindings),
    env.DB.prepare(byDamageTypeApprovedSql).bind(...baseBindings),
    env.DB.prepare(byDamageTypeDeniedSql).bind(...baseBindings)
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
  const byDamageApprovedRes = batchResult[9];
  const byDamageDeniedRes = batchResult[10];

  const lifecycleRows = (lifecycleRes?.results ?? []) as Array<{
    lifecycle_state: string;
    n: number;
  }>;
  let totalsOpen = 0;
  let totalsClosed = 0;
  for (const r of lifecycleRows) {
    if (r.lifecycle_state === "Open") totalsOpen = Number(r.n) || 0;
    else if (r.lifecycle_state === "Closed") totalsClosed = Number(r.n) || 0;
  }

  const approvedTotal = Number((approvedRes?.results?.[0] as { n?: number } | undefined)?.n ?? 0);
  const deniedTotal = Number((deniedRes?.results?.[0] as { n?: number } | undefined)?.n ?? 0);
  const costTotal = Number((costRes?.results?.[0] as { cost?: number } | undefined)?.cost ?? 0);

  // Pivot per-location lifecycle rows into one row per location.
  const perLoc = new Map<string, ReportingByLocationRow>();
  for (const r of (byLocationRes?.results ?? []) as Array<{
    location_code: string;
    location_pretty: string | null;
    lifecycle_state: string;
    n: number;
  }>) {
    let row = perLoc.get(r.location_code);
    if (!row) {
      row = {
        location_code: r.location_code,
        location_pretty: r.location_pretty ?? null,
        open: 0,
        closed: 0,
        approved: 0,
        denied: 0,
        repair_cost: 0
      };
      perLoc.set(r.location_code, row);
    }
    if (r.lifecycle_state === "Open") row.open = Number(r.n) || 0;
    else if (r.lifecycle_state === "Closed") row.closed = Number(r.n) || 0;
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
  const byLocation = [...perLoc.values()].sort((a, b) =>
    (a.location_pretty ?? a.location_code).localeCompare(
      b.location_pretty ?? b.location_code
    )
  );

  const byDamageOpen = ((byDamageOpenRes?.results ?? []) as Array<{
    damage_type: string;
    n: number;
  }>).map((r) => ({ damage_type: r.damage_type, count: Number(r.n) || 0 }));
  const byDamageApproved = ((byDamageApprovedRes?.results ?? []) as Array<{
    damage_type: string;
    n: number;
  }>).map((r) => ({ damage_type: r.damage_type, count: Number(r.n) || 0 }));
  const byDamageDenied = ((byDamageDeniedRes?.results ?? []) as Array<{
    damage_type: string;
    n: number;
  }>).map((r) => ({ damage_type: r.damage_type, count: Number(r.n) || 0 }));

  const response: ReportingResponse = {
    window,
    from,
    to,
    filters,
    totals: {
      open: totalsOpen,
      closed: totalsClosed,
      approved: approvedTotal,
      denied: deniedTotal,
      repair_cost: costTotal
    },
    by_location: byLocation,
    by_damage_type_open: byDamageOpen,
    by_damage_type_approved: byDamageApproved,
    by_damage_type_denied: byDamageDenied
  };
  return json(response);
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
    totals: { open: 0, closed: 0, approved: 0, denied: 0, repair_cost: 0 },
    by_location: [],
    by_damage_type_open: [],
    by_damage_type_approved: [],
    by_damage_type_denied: []
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

  return json({ claim, photos, activity });
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
  claimId: string
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
  claimId: string
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
  if (approvalReset) noteParts.push("[Reset approval details on revert]");
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
      recipientLabel: "incidents"
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
      await runCheckRequestPdfStep({
        db: env.DB,
        bucket: env.R2_BUCKET,
        claim,
        quote: quoteForPdf,
        requestorEmail,
        approvalEmail: session.email,
        stageLabel: "Submitted to AP",
        webhookUrl: env.AP_WEBHOOK_URL,
        recipientLabel: "AP"
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
  const { env, claim, finalTo, overrideEquipmentPiece, actorEmail } = input;

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
  const mxAppsWebBaseUrl =
    env.APPS_WEB_BASE_URL ?? "https://splashcarwashes.info";

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

async function handleClaimSubmission(request: Request, env: Env): Promise<Response> {
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

  try {
    const formData = await request.formData();

    // 1. Parse form fields. CamelCase keys match legacy/damagemanager.js:84
    // EXACTLY — Power Automate's Parse JSON action consumes these names
    // and any drift breaks the SharePoint write.
    const claimData: ClaimSubmissionPayload = {
      customerName: String(formData.get("customerName") ?? ""),
      customerPhone: String(formData.get("customerPhone") ?? ""),
      customerEmail: String(formData.get("customerEmail") ?? ""),
      mailingAddress: String(formData.get("mailingAddress") ?? ""),
      licensePlate: String(formData.get("licensePlate") ?? ""),
      vehicleMake: String(formData.get("vehicleMake") ?? ""),
      vehicleModel: String(formData.get("vehicleModel") ?? ""),
      vehicleYear: String(formData.get("vehicleYear") ?? ""),
      vehicleColor: String(formData.get("vehicleColor") ?? ""),
      issueDescription: String(formData.get("issueDescription") ?? ""),
      employeeName: String(formData.get("employeeName") ?? ""),
      location: String(formData.get("location") ?? ""),
      locationPretty: String(formData.get("locationPretty") ?? ""),
      membershipNumber: String(formData.get("membershipNumber") ?? ""),
      preExistingDamage: String(formData.get("preExistingDamage") ?? ""),
      damageType: String(formData.get("damageType") ?? ""),
      damageOther: String(formData.get("damageOther") ?? ""),
      equipmentInvolved: String(formData.get("equipmentInvolved") ?? ""),
      equipmentMalfunction: String(formData.get("equipmentMalfunction") ?? "") === "true",
      determination: String(formData.get("determination") ?? ""),
      customerTold: String(formData.get("customerTold") ?? ""),
      customerDemeanor: String(formData.get("customerDemeanor") ?? ""),
      submittedAt: new Date().toISOString(),
      ipAddress: request.headers.get("CF-Connecting-IP") ?? "Unknown",
      userAgent: request.headers.get("User-Agent") ?? "Unknown",
      claimId: "", // filled below
      photos: [],
      maintainxWorkorderId: null // filled by Brief 42 hook after writeClaimBatch
    };

    // Brief 32 — email is now required. Worker re-validates after the form's
    // HTML5 + inline-script gates because programmatic JSON callers can
    // bypass them. Same simple regex used in sysadmin-worker per Brief 24/27.
    // The DB column stays nullable for back-compat with any historical rows;
    // this is a contract change at the surface, not at the storage level.
    const emailTrimmed = claimData.customerEmail.trim();
    const emailValid = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(emailTrimmed);
    if (!emailTrimmed || !emailValid) {
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

    // 3. Upload photos to R2 (4 categories).
    for (const category of PHOTO_CATEGORIES) {
      const files = formData.getAll(category.field);
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

    // 4. Save full submission JSON to R2 — unconditional (canonical record
    // even if D1/PA fail). Legacy:153.
    await saveClaimSubmission(env.R2_BUCKET, claimData as unknown as { claimId: string });

    // 5. Write to D1. Best-effort — failures logged but don't break the
    // pipeline (legacy:157). writeClaimBatch handles location_pretty
    // resolution internally — we pre-resolve here to match the legacy
    // post-D1 update of claimData.locationPretty so the PA POST sees the
    // canonical value.
    let d1Success = false;
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
        staff_notes: staffNotesParts.length > 0 ? staffNotesParts.join("\n\n") : null,
        determination: (claimData.determination || null) as ClaimDetermination | null,
        submitted_by: submittedBy,
        equipment_related: equipmentRelated,
        equipment_piece: claimData.equipmentInvolved || null,
        damage_type: claimData.damageType || null,
        damage_other: claimData.damageOther || null,
        initial_status: initialStatus,
        submitted_at: claimData.submittedAt,
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
          const mxAppsWebBaseUrl =
            env.APPS_WEB_BASE_URL ?? "https://splashcarwashes.info";

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
      }
    } catch (pdfErr) {
      console.error(
        `Claim summary PDF pipeline failed for ${claimData.claimId}:`,
        pdfErr
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
    pdfBytes = await generateCheckRequestPdf(env.R2_BUCKET, fields);
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

