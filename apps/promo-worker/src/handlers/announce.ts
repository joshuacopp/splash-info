// Brief 157 — promo announcement send (snapshot + outbound_emails fan-out).
//
// Route (mounted in src/index.ts):
//
//   POST /promo/api/promos/{id}/announce
//
// Auth posture mirrors Briefs 154–156: `authenticate()` →
// `gatePromoRole(role, ['super_admin', 'it', 'marketing'])` +
// `isOriginAllowed` (CSRF defense-in-depth, Brief 17 convention).
//
// Semantics: take an operator-composed email (subject + body) + a list of
// recipient emails + a checkbox list of selected materials + an
// include-PTP toggle. Snapshot the intent into `promo_announcements`,
// then fan out one row per recipient onto the Brief 127 `outbound_emails`
// queue. PA drains the queue and delivers — single PA flow for every
// outbound email in the monorepo.
//
// Sequence (NOT a transaction — PostgREST doesn't transact across
// multi-row inserts cleanly, and partial fan-out is acceptable):
//
//   1. Validate body shape + recipient emails + material membership.
//   2. INSERT one row into `promo_announcements` capturing intent.
//   3. Per recipient: `enqueueOutboundEmail(env, {...})` — caught
//      individually; failures collected into `failedRecipients[]`.
//   4. `logActivity` with type=`announcement_sent`.
//
// If step 2 fails, return 500 `announcement_create_failed` and skip
// fan-out entirely. Mid-fan-out enqueue failures DO NOT roll back the
// snapshot — the operator can retry the missed recipients via the
// Brief 128 admin email-queue viewer.
//
// Body shape stored in `promo_announcements.body_text` is the operator's
// raw body WITHOUT the appended PTP block — `included_ptp = true` + the
// joined `promo_ptp` row at read time covers it. What gets enqueued on
// `outbound_emails.body_text` includes the appended PTP block because
// that's what actually gets sent. Two views, intentional.

import { authenticate } from "@splash/auth";
import { gatePromoRole, enqueueOutboundEmail } from "@splash/db-supabase";
import type { OutboundEmailAttachment } from "@splash/db-supabase";
import { isOriginAllowed, jsonError } from "@splash/http";
import { isValidEmail } from "@splash/types/email-validate";
import type { PromoRole } from "@splash/types/promo";
import type { Env } from "../index.js";
import { logActivity } from "./_activity.js";

// =============================================================================
// Shared constants + helpers
// =============================================================================

const PROMO_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MATERIAL_ID_RE = PROMO_ID_RE;

const SUBJECT_MAX_LEN = 500;
const BODY_MAX_LEN = 50_000;
const RECIPIENT_CAP = 500;

const KNOWN_BODY_KEYS = new Set([
  "subject",
  "bodyText",
  "recipientEmails",
  "selectedMaterialIds",
  "includePtp"
]);

function pgHeaders(env: Env): HeadersInit {
  return {
    apikey: env.SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    }
  });
}

function requireServiceKey(env: Env): Response | null {
  if (!env.SUPABASE_SERVICE_KEY) {
    return jsonError(503, "service_key_unbound");
  }
  return null;
}

interface GateOk {
  ok: true;
  session: { userId: string; email: string; promoRole: PromoRole };
}
interface GateErr {
  ok: false;
  response: Response;
}

async function gateCaller(
  env: Env,
  req: Request,
  requiredRoles: PromoRole[]
): Promise<GateOk | GateErr> {
  const auth = await authenticate(req, env);
  if (auth.status !== "authenticated") {
    return { ok: false, response: jsonError(401, "unauthorized") };
  }
  const { session } = auth;
  const gate = gatePromoRole(session.promoRole, requiredRoles);
  if (!gate.isAuthorized || !gate.promoRole) {
    return { ok: false, response: jsonError(403, "forbidden") };
  }
  return {
    ok: true,
    session: {
      userId: session.userId,
      email: session.email,
      promoRole: gate.promoRole
    }
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

async function promoExists(env: Env, promoId: string): Promise<boolean> {
  const url = new URL("/rest/v1/promotions", env.SUPABASE_URL);
  url.searchParams.set("id", `eq.${promoId}`);
  url.searchParams.set("select", "id");
  url.searchParams.set("limit", "1");
  const resp = await fetch(url.toString(), { headers: pgHeaders(env) });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`promoExists ${resp.status}: ${errText}`);
  }
  const rows = (await resp.json().catch(() => [])) as Array<{ id: string }>;
  return rows.length > 0;
}

interface MaterialRowForAnnounce {
  id: string;
  name: string;
  r2_key: string;
  file_mime: string | null;
  file_size_bytes: number | null;
}

async function fetchMaterialsForAnnounce(
  env: Env,
  promoId: string,
  materialIds: string[]
): Promise<MaterialRowForAnnounce[]> {
  if (materialIds.length === 0) return [];
  const url = new URL("/rest/v1/promo_materials", env.SUPABASE_URL);
  url.searchParams.set("promo_id", `eq.${promoId}`);
  url.searchParams.set("id", `in.(${materialIds.join(",")})`);
  url.searchParams.set(
    "select",
    "id,name,r2_key,file_mime,file_size_bytes"
  );
  const resp = await fetch(url.toString(), { headers: pgHeaders(env) });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`fetchMaterialsForAnnounce ${resp.status}: ${errText}`);
  }
  return (await resp.json().catch(() => [])) as MaterialRowForAnnounce[];
}

interface PtpRowForAnnounce {
  purpose: string;
  tools: string;
  process: string;
}

async function fetchPtpForAnnounce(
  env: Env,
  promoId: string
): Promise<PtpRowForAnnounce | null> {
  const url = new URL("/rest/v1/promo_ptp", env.SUPABASE_URL);
  url.searchParams.set("promo_id", `eq.${promoId}`);
  url.searchParams.set("select", "purpose,tools,process");
  url.searchParams.set("limit", "1");
  const resp = await fetch(url.toString(), { headers: pgHeaders(env) });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`fetchPtpForAnnounce ${resp.status}: ${errText}`);
  }
  const rows = (await resp.json().catch(() => [])) as PtpRowForAnnounce[];
  return rows[0] ?? null;
}

// =============================================================================
// POST /promo/api/promos/{id}/announce
// =============================================================================

interface AnnounceBody {
  subject?: unknown;
  bodyText?: unknown;
  recipientEmails?: unknown;
  selectedMaterialIds?: unknown;
  includePtp?: unknown;
}

interface ValidatedAnnouncePayload {
  subject: string;
  bodyText: string;
  recipientEmails: string[];
  selectedMaterialIds: string[];
  includePtp: boolean;
}

export async function handleSendAnnouncement(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  promoId: string
): Promise<Response> {
  const sk = requireServiceKey(env);
  if (sk) return sk;
  if (!isOriginAllowed(req)) return jsonError(403, "bad_origin");

  const gate = await gateCaller(env, req, ["super_admin", "it", "marketing"]);
  if (!gate.ok) return gate.response;

  if (!PROMO_ID_RE.test(promoId)) return jsonError(404, "promo_not_found");

  // Parse body.
  let body: AnnounceBody;
  try {
    const raw = await req.json();
    if (!isPlainObject(raw)) return jsonError(400, "bad_request");
    body = raw as AnnounceBody;
  } catch {
    return jsonError(400, "bad_request");
  }

  // Reject unknown keys (defense in depth against future schema drift).
  for (const k of Object.keys(body)) {
    if (!KNOWN_BODY_KEYS.has(k)) return jsonError(400, "bad_request");
  }

  // --- Field-level validation ----------------------------------------------
  const fields: Record<string, string> = {};

  let subject = "";
  if (typeof body.subject === "string") subject = body.subject.trim();
  if (!subject) {
    fields.subject = "required";
  } else if (subject.length > SUBJECT_MAX_LEN) {
    fields.subject = "too_long";
  }

  let bodyText = "";
  if (typeof body.bodyText === "string") bodyText = body.bodyText;
  // bodyText is required but NOT trimmed — operators may legitimately use
  // leading/trailing whitespace for letterhead-style formatting.
  if (!bodyText || bodyText.length === 0) {
    fields.bodyText = "required";
  } else if (bodyText.length > BODY_MAX_LEN) {
    fields.bodyText = "too_long";
  }

  let includePtp = false;
  if (body.includePtp !== undefined) {
    if (typeof body.includePtp !== "boolean") {
      fields.includePtp = "invalid";
    } else {
      includePtp = body.includePtp;
    }
  }

  // Recipients — non-empty array, capped at 500, each a valid email.
  // Dedup case-insensitively, preserving first-occurrence casing.
  let recipientEmails: string[] = [];
  const invalidRecipients: string[] = [];
  if (!Array.isArray(body.recipientEmails) || body.recipientEmails.length === 0) {
    fields.recipientEmails = "required";
  } else if (body.recipientEmails.length > RECIPIENT_CAP) {
    fields.recipientEmails = "too_many";
  } else {
    const seen = new Set<string>();
    const cleaned: string[] = [];
    for (const raw of body.recipientEmails) {
      if (typeof raw !== "string") {
        invalidRecipients.push(String(raw));
        continue;
      }
      const trimmed = raw.trim();
      if (!trimmed) continue;
      if (!isValidEmail(trimmed)) {
        invalidRecipients.push(trimmed);
        continue;
      }
      const dedupKey = trimmed.toLowerCase();
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);
      cleaned.push(trimmed);
    }
    if (invalidRecipients.length > 0) {
      // Surface as a dedicated 400 below — keeps the response shape
      // discoverable for apps/web's compose modal.
    } else if (cleaned.length === 0) {
      fields.recipientEmails = "required";
    } else {
      recipientEmails = cleaned;
    }
  }

  // Material ids — optional array (default []). Each must be UUID v4 shape;
  // membership against this promo is checked after the existence check.
  let selectedMaterialIds: string[] = [];
  const invalidMaterialIds: string[] = [];
  if (body.selectedMaterialIds !== undefined) {
    if (!Array.isArray(body.selectedMaterialIds)) {
      fields.selectedMaterialIds = "invalid";
    } else {
      const seen = new Set<string>();
      const cleaned: string[] = [];
      for (const raw of body.selectedMaterialIds) {
        if (typeof raw !== "string" || !MATERIAL_ID_RE.test(raw)) {
          invalidMaterialIds.push(String(raw));
          continue;
        }
        if (seen.has(raw)) continue;
        seen.add(raw);
        cleaned.push(raw);
      }
      if (invalidMaterialIds.length > 0) {
        fields.selectedMaterialIds = "invalid";
      } else {
        selectedMaterialIds = cleaned;
      }
    }
  }

  // Collapse field-level errors to one 400 if any. Invalid-recipient is a
  // distinct error code so apps/web can render the per-recipient list.
  if (invalidRecipients.length > 0) {
    return new Response(
      JSON.stringify({
        error: "invalid_recipients",
        invalid: invalidRecipients
      }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }
  if (Object.keys(fields).length > 0) {
    return new Response(
      JSON.stringify({ error: "bad_request", fields }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const payload: ValidatedAnnouncePayload = {
    subject,
    bodyText,
    recipientEmails,
    selectedMaterialIds,
    includePtp
  };

  // --- Promo existence -----------------------------------------------------
  try {
    if (!(await promoExists(env, promoId))) {
      return jsonError(404, "promo_not_found");
    }
  } catch (err) {
    console.error("[promo.announce] promoExists threw", err);
    return jsonError(500, "announcement_create_failed");
  }

  // --- Resolve materials (and check membership) ----------------------------
  let resolvedMaterials: MaterialRowForAnnounce[] = [];
  if (payload.selectedMaterialIds.length > 0) {
    try {
      resolvedMaterials = await fetchMaterialsForAnnounce(
        env,
        promoId,
        payload.selectedMaterialIds
      );
    } catch (err) {
      console.error("[promo.announce] fetchMaterialsForAnnounce threw", err);
      return jsonError(500, "announcement_create_failed");
    }
    const resolvedIds = new Set(resolvedMaterials.map((m) => m.id));
    const missing = payload.selectedMaterialIds.filter(
      (id) => !resolvedIds.has(id)
    );
    if (missing.length > 0) {
      return new Response(
        JSON.stringify({
          error: "material_not_on_promo",
          missing
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }
  }

  // --- Resolve PTP if requested -------------------------------------------
  let ptpRow: PtpRowForAnnounce | null = null;
  if (payload.includePtp) {
    try {
      ptpRow = await fetchPtpForAnnounce(env, promoId);
    } catch (err) {
      // Per the brief's permissive v1: if the PTP fetch fails outright we
      // still proceed with placeholder values rather than blocking the
      // send. The PTP block on the queued body will say "(none)".
      console.warn("[promo.announce] fetchPtpForAnnounce threw (non-fatal)", err);
      ptpRow = null;
    }
  }

  // --- Snapshot row in promo_announcements --------------------------------
  let announcementId: string;
  let sentAt: string;
  try {
    const url = new URL("/rest/v1/promo_announcements", env.SUPABASE_URL);
    const resp = await fetch(url.toString(), {
      method: "POST",
      headers: {
        ...pgHeaders(env),
        "Content-Type": "application/json",
        Prefer: "return=representation"
      },
      body: JSON.stringify({
        promo_id: promoId,
        sent_by: gate.session.userId,
        subject: payload.subject,
        // body_text on the snapshot is the OPERATOR's typed body, without
        // the appended PTP block — `included_ptp = true` + the live PTP
        // row at read time covers the intent.
        body_text: payload.bodyText,
        body_html: null,
        recipient_emails: payload.recipientEmails,
        included_material_ids: payload.selectedMaterialIds,
        included_ptp: payload.includePtp
      })
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      console.error(
        "[promo.announce] snapshot insert failed",
        resp.status,
        errText
      );
      return jsonError(500, "announcement_create_failed");
    }
    const rows = (await resp.json().catch(() => [])) as Array<{
      id: string;
      sent_at: string;
    }>;
    const row = rows[0];
    if (!row?.id) {
      console.error("[promo.announce] snapshot insert returned no row");
      return jsonError(500, "announcement_create_failed");
    }
    announcementId = row.id;
    sentAt = row.sent_at;
  } catch (err) {
    console.error("[promo.announce] snapshot insert threw", err);
    return jsonError(500, "announcement_create_failed");
  }

  // --- Build the body that actually gets sent -----------------------------
  // Snapshot body_text stays raw; queue body_text appends the PTP block when
  // the operator opted in. Two intentionally divergent views.
  const renderedBody = payload.includePtp
    ? appendPtpBlock(payload.bodyText, ptpRow)
    : payload.bodyText;

  // --- Build the attachments array (one per resolved material) ------------
  const attachments: OutboundEmailAttachment[] = resolvedMaterials.map((m) => ({
    filename: m.name,
    mime: m.file_mime ?? "application/octet-stream",
    size_bytes: m.file_size_bytes ?? 0,
    r2_key: m.r2_key,
    bucket: "PROMO_FILES"
  }));

  // --- Fan out one outbound_emails row per recipient ----------------------
  const failedRecipients: string[] = [];
  let enqueuedCount = 0;
  for (const recipient of payload.recipientEmails) {
    try {
      await enqueueOutboundEmail(env, {
        source_worker: "promo-worker",
        source_kind: "promo-announcement",
        // source_id is the ANNOUNCEMENT id, NOT the promo id — dedup
        // uniqueness is per-announcement so re-firing the same announcement
        // is a no-op, while a future announcement on the same promo to the
        // same recipient lands cleanly.
        source_id: announcementId,
        recipient,
        subject: payload.subject,
        body_text: renderedBody,
        body_html: undefined,
        attachments
      });
      enqueuedCount += 1;
    } catch (err) {
      console.error(
        `[promo.announce] enqueue failed for ${recipient}:`,
        err
      );
      failedRecipients.push(recipient);
    }
  }

  // --- Activity log (fail-soft) -------------------------------------------
  // ctx.waitUntil so a slow log insert doesn't add latency to the response.
  ctx.waitUntil(
    logActivity(env, promoId, gate.session.userId, "announcement_sent", {
      announcementId,
      recipientCount: payload.recipientEmails.length,
      enqueuedCount,
      failedRecipientCount: failedRecipients.length,
      materialCount: payload.selectedMaterialIds.length,
      includedPtp: payload.includePtp,
      subject: payload.subject
    })
  );

  return jsonResponse(
    {
      ok: true,
      announcementId,
      enqueuedCount,
      failedRecipients,
      sentAt
    },
    201
  );
}

/**
 * Append the PTP block to the operator's body, separated by the brief's
 * specified `\n\n---\n\n` divider. Missing PTP row → "(none)" placeholders.
 * Permissive v1 per the brief — a future stricter mode could 400 with
 * `ptp_not_set` instead.
 */
function appendPtpBlock(
  bodyText: string,
  ptp: PtpRowForAnnounce | null
): string {
  const purpose = ptp?.purpose?.trim() || "(none)";
  const tools = ptp?.tools?.trim() || "(none)";
  const process = ptp?.process?.trim() || "(none)";
  return (
    `${bodyText}\n\n---\n\n` +
    `PTP (Purpose, Tools, Process)\n\n` +
    `Purpose: ${purpose}\n` +
    `Tools: ${tools}\n` +
    `Process: ${process}`
  );
}
