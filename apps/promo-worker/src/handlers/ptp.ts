// Brief 156 — Purpose / Tools / Process (PTP) doc upsert.
//
// Route (mounted in src/index.ts):
//
//   PUT /promo/api/promos/{id}/ptp
//
// Auth posture: `authenticate()` → `gatePromoRole(role, ['super_admin',
// 'it', 'marketing'])` + `isOriginAllowed`. Mirrors `promo-writes.ts`.
//
// Semantics: a single 1:1 doc keyed on `promo_id` (PK). The endpoint is
// upsert — existing row gets UPDATEd, missing row gets INSERTed. No
// DELETE endpoint; clearing the PTP is `PUT` with empty strings (which
// matches the schema defaults).
//
// Activity log: emit `ptp_updated` with `details = { fields: [...] }`
// listing the field names that actually changed value vs. before-state.
// All-unchanged → no log row (no-op submit is quiet).

import { authenticate } from "@splash/auth";
import { gatePromoRole } from "@splash/db-supabase";
import { isOriginAllowed, jsonError } from "@splash/http";
import type { PromoRole } from "@splash/types/promo";
import type { Env } from "../index.js";
import { logActivity } from "./_activity.js";

// =============================================================================
// Shared constants + helpers
// =============================================================================

const PROMO_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FIELD_MAX_LEN = 10_000;

const KNOWN_KEYS = new Set(["purpose", "tools", "process"]);

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

interface PtpRow {
  promo_id: string;
  purpose: string;
  tools: string;
  process: string;
  created_at: string;
  updated_at: string;
  updated_by: string | null;
}

async function fetchPtp(env: Env, promoId: string): Promise<PtpRow | null> {
  const url = new URL("/rest/v1/promo_ptp", env.SUPABASE_URL);
  url.searchParams.set("promo_id", `eq.${promoId}`);
  url.searchParams.set(
    "select",
    "promo_id,purpose,tools,process,created_at,updated_at,updated_by"
  );
  url.searchParams.set("limit", "1");
  const resp = await fetch(url.toString(), { headers: pgHeaders(env) });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`fetchPtp ${resp.status}: ${errText}`);
  }
  const rows = (await resp.json().catch(() => [])) as PtpRow[];
  return rows[0] ?? null;
}

// =============================================================================
// PUT /promo/api/promos/{id}/ptp
// =============================================================================

interface PutPtpBody {
  purpose?: unknown;
  tools?: unknown;
  process?: unknown;
}

interface ValidatedPtp {
  purpose: string;
  tools: string;
  process: string;
}

export async function handlePutPtp(
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

  let body: PutPtpBody;
  try {
    const raw = await req.json();
    if (!isPlainObject(raw)) return jsonError(400, "bad_request");
    body = raw as PutPtpBody;
  } catch {
    return jsonError(400, "bad_request");
  }

  // Reject unknown keys.
  for (const k of Object.keys(body)) {
    if (!KNOWN_KEYS.has(k)) return jsonError(400, "bad_request");
  }

  const fields: Record<string, string> = {};
  const validated: Partial<ValidatedPtp> = {};

  for (const key of ["purpose", "tools", "process"] as const) {
    const v = body[key];
    if (typeof v !== "string") {
      fields[key] = "required";
      continue;
    }
    const trimmed = v.trim();
    if (trimmed.length > FIELD_MAX_LEN) {
      fields[key] = "too_long";
      continue;
    }
    validated[key] = trimmed;
  }

  if (Object.keys(fields).length > 0) {
    return new Response(
      JSON.stringify({ error: "bad_request", fields }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const payload = validated as ValidatedPtp;

  // Promo existence — distinct from PTP row existence. We always upsert
  // the PTP row when the promo exists, regardless of whether a prior
  // PTP row was there.
  try {
    if (!(await promoExists(env, promoId))) {
      return jsonError(404, "promo_not_found");
    }
  } catch (err) {
    console.error("[promo.ptp] promoExists threw", err);
    return jsonError(500, "ptp_save_failed");
  }

  // Before-state for delta computation.
  let before: PtpRow | null;
  try {
    before = await fetchPtp(env, promoId);
  } catch (err) {
    console.error("[promo.ptp] fetchPtp threw", err);
    return jsonError(500, "ptp_save_failed");
  }

  // Upsert via PostgREST. PK on promo_id, so on_conflict=promo_id +
  // Prefer: resolution=merge-duplicates handles both INSERT + UPDATE
  // branches in one round-trip.
  const nowIso = new Date().toISOString();
  let updated: PtpRow;
  try {
    const url = new URL("/rest/v1/promo_ptp", env.SUPABASE_URL);
    url.searchParams.set("on_conflict", "promo_id");
    const resp = await fetch(url.toString(), {
      method: "POST",
      headers: {
        ...pgHeaders(env),
        "Content-Type": "application/json",
        Prefer: "return=representation,resolution=merge-duplicates"
      },
      body: JSON.stringify({
        promo_id: promoId,
        purpose: payload.purpose,
        tools: payload.tools,
        process: payload.process,
        updated_at: nowIso,
        updated_by: gate.session.userId
      })
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      console.error("[promo.ptp] upsert failed", resp.status, errText);
      return jsonError(500, "ptp_save_failed");
    }
    const rows = (await resp.json().catch(() => [])) as PtpRow[];
    if (!rows[0]) {
      console.error("[promo.ptp] upsert returned no row");
      return jsonError(500, "ptp_save_failed");
    }
    updated = rows[0];
  } catch (err) {
    console.error("[promo.ptp] upsert threw", err);
    return jsonError(500, "ptp_save_failed");
  }

  // Activity log — only when something actually changed value vs. the
  // before-state. Missing before row is treated as "every non-empty
  // field is a change" (so a fresh PTP creation logs the fields that
  // landed; a fresh save of three empty strings stays quiet).
  const changedFields: string[] = [];
  for (const key of ["purpose", "tools", "process"] as const) {
    const newVal = payload[key];
    const oldVal = before ? before[key] : "";
    if (newVal !== oldVal) changedFields.push(key);
  }
  if (changedFields.length > 0) {
    await logActivity(env, promoId, gate.session.userId, "ptp_updated", {
      fields: changedFields
    });
  }

  return jsonResponse({
    ok: true,
    ptp: {
      purpose: updated.purpose,
      tools: updated.tools,
      process: updated.process,
      createdAt: updated.created_at,
      updatedAt: updated.updated_at,
      updatedBy: updated.updated_by
    }
  });
}
