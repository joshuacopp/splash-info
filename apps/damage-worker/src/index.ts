
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
//   POST /claims-api/submit-claim                           — customer form submission
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
  getActiveLocationByCode,
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
  writeClaimBatch,
  type ClaimInsert
} from "@splash/db-d1";
import type { SupabaseEnv } from "@splash/db-supabase";
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
}

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

  // Resolve location filter against the dc_role scope.
  let locationCodes: string[] | undefined;
  if (scope.kind === "global") {
    locationCodes = requestedLocation && requestedLocation !== "All" ? [requestedLocation] : undefined;
  } else {
    // scope.kind === "scoped"
    if (scope.codes.length === 0) return json([]);
    if (requestedLocation && requestedLocation !== "All") {
      if (!scope.codes.includes(requestedLocation)) return json([]); // out-of-scope filter → empty
      locationCodes = [requestedLocation];
    } else {
      locationCodes = [...scope.codes];
    }
  }

  const filters: ClaimsListFilters = {
    locationCodes,
    lifecycle: (lifecycleParam === "All" ? "All" : lifecycleParam) as LifecycleState | "All",
    claimStatus: statusParam !== "All" ? (statusParam as ClaimStatus) : undefined,
    search
  };

  const claims = await listClaims(env.DB, filters);
  return json(claims);
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

  const updateSql = `UPDATE claims SET ${setParts.join(", ")} WHERE claim_id = ?`;
  params.push(claimId);

  const updateStmt = env.DB.prepare(updateSql).bind(...params);
  const activityStmt = env.DB.prepare(
    `INSERT INTO claim_activity (
      claim_id, activity_type, status_from, status_to, notes, actor_email, actor_name
    ) VALUES (?, 'status_change', ?, ?, ?, ?, ?)`
  ).bind(claimId, claim.claim_status, finalTo, noteText || null, session.email, session.email);

  try {
    await env.DB.batch([updateStmt, activityStmt]);
  } catch (err) {
    console.error("handleStatusTransition failed:", err);
    return jsonError(500, "Failed to apply status change.");
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

  return json({ ok: true, status: finalTo, lifecycle: lifecycleForStatus(finalTo) });
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
 * ============================================================ */

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
    return jsonError(400, "Document upload must be multipart/form-data.");
  }

  // Multipart with files — call request.formData() directly (readForm
  // strips file values).
  const form = await request.formData();
  const file = form.get("file");
  const docType = String(form.get("doc_type") ?? "").trim();
  const vendor = String(form.get("vendor") ?? "").trim() || null;
  const amountStr = String(form.get("amount") ?? "").trim();
  const notesText = String(form.get("notes") ?? "").trim() || null;
  const payToTypeRaw = String(form.get("pay_to_type") ?? "").trim().toLowerCase();
  const vendorAddress = String(form.get("vendor_address") ?? "").trim() || null;

  if (!DOCUMENT_TYPES.has(docType)) {
    return jsonError(400, "Invalid document type. Must be Quote or Receipt.");
  }
  if (!file || typeof file === "string" || !(file instanceof File) || !file.name) {
    return jsonError(400, "No file selected.");
  }
  if (file.size > DOCUMENT_MAX_BYTES) {
    return jsonError(400, `File too large (max ${DOCUMENT_MAX_BYTES / (1024 * 1024)} MB).`);
  }
  if (file.size === 0) {
    return jsonError(400, "File is empty.");
  }
  const mime = (file.type || "").toLowerCase();
  const ext = (file.name.split(".").pop() ?? "").toLowerCase();
  if (!DOCUMENT_ALLOWED_EXT.has(ext) && !DOCUMENT_ALLOWED_MIME.has(mime)) {
    return jsonError(400, "Unsupported file type. Allowed: PDF, JPG, PNG, HEIC.");
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

  let payToType: PayToType | null = null;
  let payToVendorAddress: string | null = null;
  if (docType === "Quote") {
    if (payToTypeRaw && payToTypeRaw !== "customer" && payToTypeRaw !== "vendor") {
      return jsonError(400, "Pay to must be 'customer' or 'vendor'.");
    }
    payToType = (payToTypeRaw || null) as PayToType | null;
    if (payToType === "vendor") {
      if (!vendorAddress) {
        return jsonError(
          400,
          "Vendor address is required when paying the vendor directly."
        );
      }
      if (vendorAddress.length > 1000) {
        return jsonError(400, "Vendor address is too long (max 1000 characters).");
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
  if (!r2) return jsonError(500, "Upload to storage failed. Please try again.");

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
    return jsonError(500, "Failed to record upload.");
  }

  return json({ ok: true, r2Key: r2.key });
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
}

async function handleClaimSubmission(request: Request, env: Env): Promise<Response> {
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
      equipmentInvolved: String(formData.get("equipmentInvolved") ?? ""),
      equipmentMalfunction: String(formData.get("equipmentMalfunction") ?? "") === "true",
      determination: String(formData.get("determination") ?? ""),
      customerTold: String(formData.get("customerTold") ?? ""),
      customerDemeanor: String(formData.get("customerDemeanor") ?? ""),
      submittedAt: new Date().toISOString(),
      ipAddress: request.headers.get("CF-Connecting-IP") ?? "Unknown",
      userAgent: request.headers.get("User-Agent") ?? "Unknown",
      claimId: "", // filled below
      photos: []
    };

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

      // location_pretty D1-canonical resolution. Source: legacy/damagemanager.js:
      // 357-371 — the legacy worker does this lookup INSIDE writeClaimToD1 and
      // mutates claimData.locationPretty in place so the subsequent PA POST
      // sees the canonical value. We do it here (in the worker, post-batch)
      // instead so @splash/db-d1 stays free of side effects on its inputs.
      //
      // Best-effort: if the D1 lookup fails or returns null, claimData keeps
      // the form-supplied value. The D1 row was already inserted with the
      // (possibly non-canonical) form value; rerunning that overwrite would
      // require a separate UPDATE — left for a follow-up if it matters in
      // practice. The PA-bound copy of the value is what Power Automate
      // consumes for SharePoint, so this resolution closes the legacy parity
      // gap for downstream displays.
      try {
        const canonical = await getActiveLocationByCode(env.DB, claimData.location);
        if (canonical?.location_pretty) {
          claimData.locationPretty = canonical.location_pretty;
        }
      } catch (locErr) {
        console.warn("location_pretty D1 resolution failed (using form value):", locErr);
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

    return json({
      success: true,
      claimId: claimData.claimId,
      powerAutomateSuccess,
      d1Success,
      photosUploaded: claimData.photos.length
    });
  } catch (error) {
    console.error("Claim submission error:", error);
    return json(
      {
        success: false,
        error: error instanceof Error ? error.message : "submission failed"
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
      // Switching to vendor (or staying on vendor) requires an address.
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

