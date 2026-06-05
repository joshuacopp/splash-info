// Brief 156 — promo materials lifecycle (upload + delete + serve).
//
// Routes (mounted in src/index.ts):
//
//   POST   /promo/api/promos/{id}/materials                       → handleUploadMaterial
//   DELETE /promo/api/promos/{id}/materials/{materialId}          → handleDeleteMaterial
//   GET    /promo/api/promos/{id}/materials/{materialId}/file     → handleServeMaterialFile
//
// Auth posture mirrors Brief 154 / 155: every handler resolves the
// session via `authenticate()`, then gates with `gatePromoRole`.
// Mutations (POST / DELETE) also gate on `isOriginAllowed` (CSRF
// defense-in-depth, Brief 17 convention). The GET serve route skips
// CSRF — same-origin GETs don't carry Origin per spec, and the route
// is purely read-only.
//
// R2 path convention: `promo-materials/{promoId}/{materialId}.{ext}`
// (verbatim from the comment on `promo_materials.r2_key` in
// supabase/promo-tables.sql). Extension derived from sniffed MIME via
// the lookup table in `_mime.ts`; unknown MIMEs land with no extension
// (the row's `file_mime` column stays authoritative either way).
//
// Fail-soft on DB-after-R2: if the DB INSERT throws after R2 PUT
// succeeded, the R2 object becomes orphan. Inline rollback: best-effort
// DELETE the R2 object. If R2 DELETE also throws, log loud
// (`[promo.materials] orphan — manual R2 cleanup required for {key}`)
// so the operator can sweep manually. Activity log failure is fail-soft
// per `logActivity`'s contract — never fails the parent write.

import { authenticate } from "@splash/auth";
import { gatePromoRole } from "@splash/db-supabase";
import { isOriginAllowed, jsonError } from "@splash/http";
import { fileTypeFromBuffer } from "file-type";
import type { PromoRole } from "@splash/types/promo";
import type { Env } from "../index.js";
import { logActivity } from "./_activity.js";
import { extensionFor, isDeniedMime } from "./_mime.js";

// =============================================================================
// Shared constants + helpers
// =============================================================================

const PROMO_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MATERIAL_ID_RE = PROMO_ID_RE;

const MATERIAL_KINDS = [
  "image",
  "video",
  "copy_messaging",
  "signage",
  "email_asset",
  "other"
] as const;
type MaterialKind = (typeof MATERIAL_KINDS)[number];

const NAME_MAX_LEN = 500;
const FILE_MAX_BYTES = 50 * 1024 * 1024; // 50 MB
const MATERIALS_PER_PROMO_CAP = 20;
const SNIFF_HEAD_BYTES = 4100; // file-type's max useful read.

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

async function countMaterials(env: Env, promoId: string): Promise<number> {
  const url = new URL("/rest/v1/promo_materials", env.SUPABASE_URL);
  url.searchParams.set("promo_id", `eq.${promoId}`);
  url.searchParams.set("select", "id");
  const resp = await fetch(url.toString(), {
    headers: {
      ...pgHeaders(env),
      // Range 0-0 + count=exact returns just the total in Content-Range
      // without streaming any rows back. Cheaper than asking for the
      // full row set when we only need the count.
      Range: "0-0",
      Prefer: "count=exact"
    }
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`countMaterials ${resp.status}: ${errText}`);
  }
  const contentRange = resp.headers.get("Content-Range") ?? "";
  const slash = contentRange.lastIndexOf("/");
  if (slash === -1) return 0;
  const tail = contentRange.slice(slash + 1);
  if (tail === "*") return 0;
  const n = Number.parseInt(tail, 10);
  return Number.isFinite(n) ? n : 0;
}

interface MaterialRow {
  id: string;
  promo_id: string;
  name: string;
  kind: MaterialKind;
  r2_key: string;
  file_mime: string | null;
  file_size_bytes: number | null;
  uploaded_at: string;
  uploaded_by: string;
}

async function fetchMaterial(
  env: Env,
  promoId: string,
  materialId: string
): Promise<MaterialRow | null> {
  const url = new URL("/rest/v1/promo_materials", env.SUPABASE_URL);
  url.searchParams.set("promo_id", `eq.${promoId}`);
  url.searchParams.set("id", `eq.${materialId}`);
  url.searchParams.set(
    "select",
    "id,promo_id,name,kind,r2_key,file_mime,file_size_bytes,uploaded_at,uploaded_by"
  );
  url.searchParams.set("limit", "1");
  const resp = await fetch(url.toString(), { headers: pgHeaders(env) });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`fetchMaterial ${resp.status}: ${errText}`);
  }
  const rows = (await resp.json().catch(() => [])) as MaterialRow[];
  return rows[0] ?? null;
}

function isMaterialKind(v: unknown): v is MaterialKind {
  return typeof v === "string" && (MATERIAL_KINDS as readonly string[]).includes(v);
}

// =============================================================================
// POST /promo/api/promos/{id}/materials
// =============================================================================

export async function handleUploadMaterial(
  req: Request,
  env: Env,
  _ctx: ExecutionContext,
  promoId: string
): Promise<Response> {
  const sk = requireServiceKey(env);
  if (sk) return sk;
  if (!isOriginAllowed(req)) return jsonError(403, "bad_origin");

  const gate = await gateCaller(env, req, ["super_admin", "it", "marketing"]);
  if (!gate.ok) return gate.response;

  if (!PROMO_ID_RE.test(promoId)) return jsonError(404, "promo_not_found");

  // Promo existence check first — short-circuits before we burn cycles on
  // multipart parsing for a bad UUID.
  try {
    if (!(await promoExists(env, promoId))) {
      return jsonError(404, "promo_not_found");
    }
  } catch (err) {
    console.error("[promo.materials] promoExists threw", err);
    return jsonError(500, "material_create_failed");
  }

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch (err) {
    console.error("[promo.materials] formData parse failed", err);
    return jsonError(400, "bad_request");
  }

  const nameRaw = formData.get("name");
  const kindRaw = formData.get("kind");
  const fileEntry = formData.get("file");

  const fields: Record<string, string> = {};

  let name = "";
  if (typeof nameRaw === "string") name = nameRaw.trim();
  if (!name) {
    fields.name = "required";
  } else if (name.length > NAME_MAX_LEN) {
    fields.name = "too_long";
  }

  let kind: MaterialKind | null = null;
  if (!isMaterialKind(kindRaw)) {
    fields.kind = "invalid";
  } else {
    kind = kindRaw;
  }

  if (!(fileEntry instanceof File)) {
    fields.file = "required";
  }

  if (Object.keys(fields).length > 0) {
    return new Response(
      JSON.stringify({ error: "bad_request", fields }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  // Cast narrowing — guarded by the fields-check above.
  const file = fileEntry as File;
  const kindFinal = kind as MaterialKind;

  if (file.size === 0) {
    return new Response(
      JSON.stringify({ error: "bad_request", fields: { file: "empty" } }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }
  if (file.size > FILE_MAX_BYTES) {
    return jsonError(413, "file_too_large");
  }

  // Soft-cap check — fires before MIME sniff so an over-limit promo
  // doesn't pay the sniff cost.
  let currentCount: number;
  try {
    currentCount = await countMaterials(env, promoId);
  } catch (err) {
    console.error("[promo.materials] countMaterials threw", err);
    return jsonError(500, "material_create_failed");
  }
  if (currentCount >= MATERIALS_PER_PROMO_CAP) {
    return jsonError(409, "material_limit_reached");
  }

  // MIME sniff. Client Content-Type is ignored entirely.
  const headerBuf = await file.slice(0, SNIFF_HEAD_BYTES).arrayBuffer();
  const sniffed = await fileTypeFromBuffer(new Uint8Array(headerBuf));
  if (!sniffed) {
    return jsonError(415, "unsupported_mime");
  }
  if (isDeniedMime(sniffed.mime)) {
    return jsonError(415, "unsupported_mime");
  }
  const sniffedMime = sniffed.mime;
  const ext = extensionFor(sniffedMime);

  const materialId = crypto.randomUUID();
  const r2Key = ext
    ? `promo-materials/${promoId}/${materialId}.${ext}`
    : `promo-materials/${promoId}/${materialId}`;

  // ---- Step 1: R2 PUT --------------------------------------------------------
  try {
    await env.PROMO_FILES.put(r2Key, file.stream(), {
      httpMetadata: { contentType: sniffedMime },
      customMetadata: {
        promoId,
        materialId,
        originalFilename: file.name
      }
    });
  } catch (err) {
    console.error("[promo.materials] R2 put failed", err);
    return jsonError(500, "r2_write_failed");
  }

  // ---- Step 2: DB INSERT (rollback R2 on failure) ---------------------------
  const nowIso = new Date().toISOString();
  try {
    const url = new URL("/rest/v1/promo_materials", env.SUPABASE_URL);
    const resp = await fetch(url.toString(), {
      method: "POST",
      headers: {
        ...pgHeaders(env),
        "Content-Type": "application/json",
        Prefer: "return=minimal"
      },
      body: JSON.stringify({
        id: materialId,
        promo_id: promoId,
        name,
        kind: kindFinal,
        r2_key: r2Key,
        file_mime: sniffedMime,
        file_size_bytes: file.size,
        uploaded_at: nowIso,
        uploaded_by: gate.session.userId
      })
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      console.error(
        "[promo.materials] INSERT failed",
        resp.status,
        errText
      );
      return await rollbackR2AndError(env, r2Key);
    }
  } catch (err) {
    console.error("[promo.materials] INSERT threw", err);
    return await rollbackR2AndError(env, r2Key);
  }

  // ---- Step 3: activity log (fail-soft) -------------------------------------
  await logActivity(env, promoId, gate.session.userId, "material_added", {
    materialId,
    name,
    kind: kindFinal,
    sizeBytes: file.size
  });

  return jsonResponse(
    {
      ok: true,
      material: {
        id: materialId,
        name,
        kind: kindFinal,
        r2Key,
        fileMime: sniffedMime,
        fileSizeBytes: file.size,
        uploadedAt: nowIso,
        uploadedBy: gate.session.userId
      }
    },
    201
  );
}

async function rollbackR2AndError(env: Env, r2Key: string): Promise<Response> {
  try {
    await env.PROMO_FILES.delete(r2Key);
  } catch (err) {
    console.error(
      "[promo.materials] orphan — manual R2 cleanup required for",
      r2Key,
      err
    );
    return new Response(
      JSON.stringify({
        error: "material_create_failed",
        orphan_r2_key: r2Key
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
  return jsonError(500, "material_create_failed");
}

// =============================================================================
// DELETE /promo/api/promos/{id}/materials/{materialId}
// =============================================================================

export async function handleDeleteMaterial(
  req: Request,
  env: Env,
  promoId: string,
  materialId: string
): Promise<Response> {
  const sk = requireServiceKey(env);
  if (sk) return sk;
  if (!isOriginAllowed(req)) return jsonError(403, "bad_origin");

  const gate = await gateCaller(env, req, ["super_admin", "it", "marketing"]);
  if (!gate.ok) return gate.response;

  if (!PROMO_ID_RE.test(promoId)) return jsonError(404, "promo_not_found");
  if (!MATERIAL_ID_RE.test(materialId)) return jsonError(404, "material_not_found");

  let row: MaterialRow | null;
  try {
    row = await fetchMaterial(env, promoId, materialId);
  } catch (err) {
    console.error("[promo.materials] fetchMaterial threw", err);
    return jsonError(500, "delete_failed");
  }
  if (!row) return jsonError(404, "material_not_found");

  // DELETE DB row first — cron sweep is the longer-term safety net if R2
  // delete fails afterwards. Inverted from the upload path on purpose:
  // the upload's risk is "DB miss after R2 succeeds" (orphan), the
  // delete's risk is "R2 succeeds, DB still has the row" (dangling
  // pointer), which is much worse for the read path. So we land the DB
  // row removal first.
  try {
    const url = new URL("/rest/v1/promo_materials", env.SUPABASE_URL);
    url.searchParams.set("promo_id", `eq.${promoId}`);
    url.searchParams.set("id", `eq.${materialId}`);
    const resp = await fetch(url.toString(), {
      method: "DELETE",
      headers: {
        ...pgHeaders(env),
        Prefer: "return=minimal"
      }
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      console.error(
        "[promo.materials] DELETE failed",
        resp.status,
        errText
      );
      return jsonError(500, "delete_failed");
    }
  } catch (err) {
    console.error("[promo.materials] DELETE threw", err);
    return jsonError(500, "delete_failed");
  }

  // R2 delete — best-effort. Failure leaves an orphan object the
  // operator can sweep manually.
  try {
    await env.PROMO_FILES.delete(row.r2_key);
  } catch (err) {
    console.error(
      "[promo.materials] R2 delete failed for",
      row.r2_key,
      err
    );
  }

  await logActivity(env, promoId, gate.session.userId, "material_removed", {
    materialId,
    name: row.name,
    kind: row.kind
  });

  return jsonResponse({ ok: true, removed: true });
}

// =============================================================================
// GET /promo/api/promos/{id}/materials/{materialId}/file
// =============================================================================

export async function handleServeMaterialFile(
  req: Request,
  env: Env,
  promoId: string,
  materialId: string
): Promise<Response> {
  const sk = requireServiceKey(env);
  if (sk) return sk;

  // Any non-null promoRole — anyone who can see the promo can see its
  // materials. No CSRF gate (read-only; same-origin GETs don't carry
  // Origin per spec).
  const gate = await gateCaller(env, req, []);
  if (!gate.ok) return gate.response;

  if (!PROMO_ID_RE.test(promoId)) return jsonError(404, "promo_not_found");
  if (!MATERIAL_ID_RE.test(materialId)) return jsonError(404, "material_not_found");

  let row: MaterialRow | null;
  try {
    row = await fetchMaterial(env, promoId, materialId);
  } catch (err) {
    console.error("[promo.materials] fetchMaterial threw on serve", err);
    return jsonError(500, "serve_failed");
  }
  // Anti-leak: out-of-scope OR missing row both return 404. Also stops
  // cross-promo material id guessing because the row lookup is keyed on
  // (promo_id, material_id) together.
  if (!row) return jsonError(404, "material_not_found");

  const obj = await env.PROMO_FILES.get(row.r2_key);
  if (!obj) {
    console.error(
      "[promo.materials] R2 drift — DB row exists but R2 object missing for",
      row.r2_key
    );
    return jsonError(404, "material_not_found");
  }

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  const contentType = row.file_mime || headers.get("Content-Type") || "application/octet-stream";
  headers.set("Content-Type", contentType);
  headers.set("Cache-Control", "private, max-age=300");
  headers.set("X-Content-Type-Options", "nosniff");

  // Inline for images, attachment for everything else (mirrors
  // forms-worker's admin serve route in apps/forms-worker/src/uploads/
  // serve.ts and damage-worker's photo serve).
  const safeName = row.name.replace(/"/g, "");
  if (contentType.startsWith("image/")) {
    headers.set("Content-Disposition", `inline; filename="${safeName}"`);
  } else {
    headers.set("Content-Disposition", `attachment; filename="${safeName}"`);
  }

  return new Response(obj.body, { status: 200, headers });
}
