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
import { renderAnnouncement } from "../announce/render-html.js";

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
  "includePtp",
  "materialModes"
]);

// Brief 160 — material modes override.
// Optional `materialModes: Record<materialId, "inline" | "attachment">`.
// When present, overrides the auto-rule per material (image MIME → inline,
// everything else → attachment). Defaults to auto-rule when absent or
// when a material id is missing from the map.
type MaterialMode = "inline" | "attachment";

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

interface PromoMeta {
  id: string;
  title: string;
}

async function fetchPromoMeta(
  env: Env,
  promoId: string
): Promise<PromoMeta | null> {
  const url = new URL("/rest/v1/promotions", env.SUPABASE_URL);
  url.searchParams.set("id", `eq.${promoId}`);
  url.searchParams.set("select", "id,title");
  url.searchParams.set("limit", "1");
  const resp = await fetch(url.toString(), { headers: pgHeaders(env) });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`fetchPromoMeta ${resp.status}: ${errText}`);
  }
  const rows = (await resp.json().catch(() => [])) as PromoMeta[];
  return rows[0] ?? null;
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
  materialModes?: unknown;
}

interface ValidatedAnnouncePayload {
  subject: string;
  bodyText: string;
  recipientEmails: string[];
  selectedMaterialIds: string[];
  includePtp: boolean;
  materialModes: Record<string, MaterialMode>;
}

interface ValidateOk {
  ok: true;
  payload: ValidatedAnnouncePayload;
}
interface ValidateErr {
  ok: false;
  response: Response;
}

/**
 * Shared body validation for send + preview. `opts.recipientsRequired`
 * is true on send (recipients are the fan-out target) and false on
 * preview (recipients are optional metadata; preview renders the same
 * regardless).
 */
async function parseAndValidateBody(
  req: Request,
  opts: { recipientsRequired: boolean }
): Promise<ValidateOk | ValidateErr> {
  let body: AnnounceBody;
  try {
    const raw = await req.json();
    if (!isPlainObject(raw)) return { ok: false, response: jsonError(400, "bad_request") };
    body = raw as AnnounceBody;
  } catch {
    return { ok: false, response: jsonError(400, "bad_request") };
  }

  for (const k of Object.keys(body)) {
    if (!KNOWN_BODY_KEYS.has(k)) {
      return { ok: false, response: jsonError(400, "bad_request") };
    }
  }

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

  let recipientEmails: string[] = [];
  const invalidRecipients: string[] = [];
  if (body.recipientEmails === undefined || body.recipientEmails === null) {
    if (opts.recipientsRequired) fields.recipientEmails = "required";
  } else if (!Array.isArray(body.recipientEmails)) {
    fields.recipientEmails = opts.recipientsRequired ? "required" : "invalid";
  } else if (body.recipientEmails.length === 0) {
    if (opts.recipientsRequired) fields.recipientEmails = "required";
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
    if (invalidRecipients.length === 0) {
      if (cleaned.length === 0 && opts.recipientsRequired) {
        fields.recipientEmails = "required";
      } else {
        recipientEmails = cleaned;
      }
    }
  }

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

  // Brief 160 — materialModes override (optional). Map of materialId →
  // "inline" | "attachment". Unknown materialIds (not present in
  // selectedMaterialIds) are tolerated and ignored.
  const materialModes: Record<string, MaterialMode> = {};
  if (body.materialModes !== undefined) {
    if (!isPlainObject(body.materialModes)) {
      fields.materialModes = "invalid";
    } else {
      for (const [k, v] of Object.entries(body.materialModes)) {
        if (!MATERIAL_ID_RE.test(k)) {
          fields.materialModes = "invalid";
          break;
        }
        if (v !== "inline" && v !== "attachment") {
          fields.materialModes = "invalid";
          break;
        }
        materialModes[k] = v;
      }
    }
  }

  if (invalidRecipients.length > 0) {
    return {
      ok: false,
      response: new Response(
        JSON.stringify({ error: "invalid_recipients", invalid: invalidRecipients }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      )
    };
  }
  if (Object.keys(fields).length > 0) {
    return {
      ok: false,
      response: new Response(
        JSON.stringify({ error: "bad_request", fields }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      )
    };
  }

  return {
    ok: true,
    payload: {
      subject,
      bodyText,
      recipientEmails,
      selectedMaterialIds,
      includePtp,
      materialModes
    }
  };
}

/**
 * Brief 160 — partition resolved materials into inline (image MIME →
 * CID-referenced from the body HTML) and attachment (everything else →
 * regular attachment in PA). Honors per-material `materialModes`
 * override: operator can demote an image to attachment-only by sending
 * `materialModes: {[id]: "attachment"}`. Demoting a non-image to
 * "inline" is silently ignored (image renderers in email clients
 * wouldn't display a PDF inline anyway).
 *
 * Exported (Brief 161) so the regression fixture in
 * `test/render-html.snap.ts` can exercise the real code path rather
 * than a copy.
 */
export function partitionMaterialsForRender(
  resolved: MaterialRowForAnnounce[],
  materialModes: Record<string, MaterialMode>
): {
  inlineMaterials: Array<{ materialId: string; name: string; contentId: string }>;
  attachmentMaterials: Array<{ materialId: string; name: string }>;
} {
  const inlineMaterials: Array<{ materialId: string; name: string; contentId: string }> = [];
  const attachmentMaterials: Array<{ materialId: string; name: string }> = [];
  for (const m of resolved) {
    const isImage = (m.file_mime ?? "").startsWith("image/");
    const overrideMode = materialModes[m.id];
    let mode: MaterialMode;
    if (overrideMode === "attachment") {
      mode = "attachment";
    } else if (overrideMode === "inline" && isImage) {
      mode = "inline";
    } else {
      mode = isImage ? "inline" : "attachment";
    }
    if (mode === "inline") {
      inlineMaterials.push({
        materialId: m.id,
        name: m.name,
        contentId: `material-${m.id}`
      });
    } else {
      attachmentMaterials.push({ materialId: m.id, name: m.name });
    }
  }
  return { inlineMaterials, attachmentMaterials };
}

// IMPORTANT (Brief 161): inline materials MUST appear in this array with
// `is_inline: true` + `content_id: "material-{id}"` set — they are NOT
// mutually exclusive with the body HTML's `<img src="cid:material-{id}">`
// references. The HTML references the CID; the queue attachment carries
// the bytes. Both sides are required for the recipient's email client to
// resolve the inline image — drop the inline entries from this array and
// every recipient sees a broken-image placeholder where the embedded
// image should render. The contract is empirically silent in Outlook /
// Gmail UIs (no console error, no PA error, no queue error — just a
// missing image) which is why the regression fixture at
// `test/render-html.snap.ts` exists to catch a future executor dropping
// the inline branch.
//
// Exported (Brief 161) so the regression fixture exercises the real
// code path rather than a copy.
/**
 * Build the `attachments` array for a `outbound_emails` row from the
 * fully-resolved materials + the inline-partition map.
 *
 * Every resolved material produces exactly one entry. Materials present
 * in `inlineMaterialMap` get `is_inline: true` + `content_id` populated
 * (the `cid:` reference the body HTML embeds); materials absent from
 * the map are plain attachments.
 */
export function buildOutboundEmailAttachmentsForAnnouncement(
  resolved: MaterialRowForAnnounce[],
  inlineMaterialMap: Map<string, { contentId: string }>
): OutboundEmailAttachment[] {
  return resolved.map((m) => {
    const inlineEntry = inlineMaterialMap.get(m.id);
    const base: OutboundEmailAttachment = {
      filename: m.name,
      mime: m.file_mime ?? "application/octet-stream",
      size_bytes: m.file_size_bytes ?? 0,
      r2_key: m.r2_key,
      bucket: "PROMO_FILES"
    };
    if (inlineEntry) {
      base.is_inline = true;
      base.content_id = inlineEntry.contentId;
    }
    return base;
  });
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

  const validated = await parseAndValidateBody(req, { recipientsRequired: true });
  if (!validated.ok) return validated.response;
  const payload = validated.payload;

  // --- Promo existence + title --------------------------------------------
  let promoMeta: PromoMeta | null;
  try {
    promoMeta = await fetchPromoMeta(env, promoId);
  } catch (err) {
    console.error("[promo.announce] fetchPromoMeta threw", err);
    return jsonError(500, "announcement_create_failed");
  }
  if (!promoMeta) return jsonError(404, "promo_not_found");

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

  // --- Partition materials + render body ----------------------------------
  // Brief 160: image MIME → inline (CID-referenced from the body HTML),
  // everything else → regular attachment. Operator can demote an image
  // to attachment-only via `materialModes: {[id]: "attachment"}`.
  const partition = partitionMaterialsForRender(
    resolvedMaterials,
    payload.materialModes
  );
  const inlineMaterialMap = new Map(
    partition.inlineMaterials.map((m) => [m.materialId, m])
  );

  const rendered = renderAnnouncement({
    subject: payload.subject,
    bodyText: payload.bodyText,
    promoTitle: promoMeta.title,
    includePtp: payload.includePtp,
    ptp: ptpRow
      ? { purpose: ptpRow.purpose, tools: ptpRow.tools, process: ptpRow.process }
      : null,
    inlineMaterials: partition.inlineMaterials,
    attachmentMaterials: partition.attachmentMaterials
  });

  // --- Build the attachments array (one per resolved material) ------------
  // Brief 160 — inline materials carry `is_inline: true` + `content_id`;
  // attachment materials are plain. PA's Send Email V2 connector reads
  // these per-attachment to flip `IsInline` + `ContentId`.
  // See the IMPORTANT comment above
  // `buildOutboundEmailAttachmentsForAnnouncement` for the contract +
  // why a future executor MUST NOT drop the inline branch from this
  // array (Brief 161).
  const attachments = buildOutboundEmailAttachmentsForAnnouncement(
    resolvedMaterials,
    inlineMaterialMap
  );

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
        body_text: rendered.plainText,
        body_html: rendered.html,
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

// =============================================================================
// POST /promo/api/promos/{id}/announce/preview
// =============================================================================
// Brief 160 — render the same HTML + plain text that handleSendAnnouncement
// would have produced, without snapshot insert, fan-out, or activity log.
// Operator's "what will the recipient see" check before firing the send.

export async function handlePreviewAnnouncement(
  req: Request,
  env: Env,
  promoId: string
): Promise<Response> {
  const sk = requireServiceKey(env);
  if (sk) return sk;
  if (!isOriginAllowed(req)) return jsonError(403, "bad_origin");

  const gate = await gateCaller(env, req, ["super_admin", "it", "marketing"]);
  if (!gate.ok) return gate.response;

  if (!PROMO_ID_RE.test(promoId)) return jsonError(404, "promo_not_found");

  // Preview tolerates an empty/missing recipientEmails — the modal may
  // call preview before recipients are filled in.
  const validated = await parseAndValidateBody(req, { recipientsRequired: false });
  if (!validated.ok) return validated.response;
  const payload = validated.payload;

  let promoMeta: PromoMeta | null;
  try {
    promoMeta = await fetchPromoMeta(env, promoId);
  } catch (err) {
    console.error("[promo.preview] fetchPromoMeta threw", err);
    return jsonError(500, "announcement_preview_failed");
  }
  if (!promoMeta) return jsonError(404, "promo_not_found");

  let resolvedMaterials: MaterialRowForAnnounce[] = [];
  if (payload.selectedMaterialIds.length > 0) {
    try {
      resolvedMaterials = await fetchMaterialsForAnnounce(
        env,
        promoId,
        payload.selectedMaterialIds
      );
    } catch (err) {
      console.error("[promo.preview] fetchMaterialsForAnnounce threw", err);
      return jsonError(500, "announcement_preview_failed");
    }
    const resolvedIds = new Set(resolvedMaterials.map((m) => m.id));
    const missing = payload.selectedMaterialIds.filter(
      (id) => !resolvedIds.has(id)
    );
    if (missing.length > 0) {
      return new Response(
        JSON.stringify({ error: "material_not_on_promo", missing }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }
  }

  let ptpRow: PtpRowForAnnounce | null = null;
  if (payload.includePtp) {
    try {
      ptpRow = await fetchPtpForAnnounce(env, promoId);
    } catch (err) {
      console.warn("[promo.preview] fetchPtpForAnnounce threw (non-fatal)", err);
      ptpRow = null;
    }
  }

  const partition = partitionMaterialsForRender(
    resolvedMaterials,
    payload.materialModes
  );

  const rendered = renderAnnouncement({
    subject: payload.subject,
    bodyText: payload.bodyText,
    promoTitle: promoMeta.title,
    includePtp: payload.includePtp,
    ptp: ptpRow
      ? { purpose: ptpRow.purpose, tools: ptpRow.tools, process: ptpRow.process }
      : null,
    inlineMaterials: partition.inlineMaterials,
    attachmentMaterials: partition.attachmentMaterials
  });

  // Attachment summary — gives the operator a "2 inline, 1 attachment, 149 KB"
  // sanity-check line in the preview footer before firing the real send.
  let totalSizeBytes = 0;
  for (const m of resolvedMaterials) {
    totalSizeBytes += m.file_size_bytes ?? 0;
  }
  const attachmentSummary = {
    inline_count: partition.inlineMaterials.length,
    attachment_count: partition.attachmentMaterials.length,
    total_size_bytes: totalSizeBytes
  };

  return jsonResponse({
    ok: true,
    html: rendered.html,
    plain_text: rendered.plainText,
    attachment_summary: attachmentSummary
  });
}
