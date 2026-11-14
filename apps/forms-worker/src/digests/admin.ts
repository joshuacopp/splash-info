// Admin API for form digests. Admin tier only (operator, 2026-11-14), the same
// gate as the form builder.
//
//   GET    /forms/admin/api/forms/{id}/digests              list
//   POST   /forms/admin/api/forms/{id}/digests              create {name, enabled, config}
//   PATCH  /forms/admin/api/forms/{id}/digests/{digestId}   update {name?, enabled?, config?}
//   DELETE /forms/admin/api/forms/{id}/digests/{digestId}
//   POST   /forms/admin/api/forms/{id}/digests/preview      {config} -> DigestPreview
//   POST   /forms/admin/api/forms/{id}/digests/test         {name, config} -> mails the caller

import { isOriginAllowed, jsonError } from "@splash/http";
import { digestConfigSchema, type DigestConfig, type Field } from "@splash/forms-schema";
import type { Env } from "../index.js";
import { adminGate, adminGateResponse, requireServiceKey } from "../admin/auth.js";
import { deleteDigest, getDigest, insertDigest, listDigests, loadDigestForm, updateDigest } from "./data.js";
import { previewDigest, sendTestDigest } from "./run.js";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}

const CHOICE_TYPES = new Set(["radio", "dropdown", "multi"]);

/** Schema-level check, then: every field the config names exists on the form and fits its use. */
function validateConfig(raw: unknown, fields: Field[]): { ok: true; config: DigestConfig } | { ok: false; error: string } {
  const r = digestConfigSchema.safeParse(raw);
  if (!r.success) {
    const i = r.error.issues[0];
    return { ok: false, error: `${i?.path.join(".") || "config"}: ${i?.message ?? "invalid"}` };
  }
  const config = r.data as DigestConfig;
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const numeric = (k?: string) => {
    const f = k ? byKey.get(k) : undefined;
    return !!f && f.type === "short_text" && !!(f as { numeric?: unknown }).numeric;
  };
  const metrics = [...config.charts.map((c) => c.y), ...(config.table.metrics ?? [])];
  for (const m of metrics) {
    if (m.agg !== "count" && !numeric(m.field_key)) {
      return { ok: false, error: `"${m.field_key}" is not a number field, so it can't be summed or averaged` };
    }
  }
  const dims: string[] = config.charts.flatMap((c) => (c.split ? [c.x, c.split] : [c.x]));
  for (const d of dims) {
    if (!d.startsWith("field:")) continue;
    const f = byKey.get(d.slice(6));
    if (!f || !CHOICE_TYPES.has(f.type)) return { ok: false, error: `"${d.slice(6)}" is not a choice field` };
  }
  for (const k of config.table.fields ?? []) {
    if (!byKey.has(k)) return { ok: false, error: `Unknown field "${k}"` };
  }
  return { ok: true, config };
}

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const b = await req.json();
    return b && typeof b === "object" ? (b as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function cleanName(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length >= 1 && t.length <= 120 ? t : null;
}

export async function handleDigestsRoute(
  env: Env,
  req: Request,
  formId: string,
  rest: string // "" | "/preview" | "/test" | "/{digestId}"
): Promise<Response> {
  const sk = requireServiceKey(env);
  if (sk) return sk;
  const gate = await adminGate(env, req);
  if (!gate.ok) return adminGateResponse(gate);
  if (req.method !== "GET" && !isOriginAllowed(req)) return jsonError(403, "bad_origin");

  try {
    if (rest === "" && req.method === "GET") {
      return json(200, { digests: await listDigests(env, { formId }) });
    }

    const form = await loadDigestForm(env, formId);
    if (!form) return json(404, { error: "form_not_found" });

    if (rest === "/preview" && req.method === "POST") {
      const body = await readJson(req);
      const v = validateConfig(body?.config, form.fields);
      if (!v.ok) return json(400, { error: "invalid_config", message: v.error });
      return json(200, await previewDigest(env, formId, v.config));
    }

    if (rest === "/test" && req.method === "POST") {
      const body = await readJson(req);
      const v = validateConfig(body?.config, form.fields);
      if (!v.ok) return json(400, { error: "invalid_config", message: v.error });
      const to = gate.session.email;
      if (!to) return json(400, { error: "no_email", message: "Your account has no email address to send the test to." });
      const r = await sendTestDigest(env, formId, { name: cleanName(body?.name) ?? "Digest", config: v.config }, to);
      return json(200, { ok: true, to, submissions: r.submissions });
    }

    if (rest === "" && req.method === "POST") {
      const body = await readJson(req);
      const name = cleanName(body?.name);
      if (!name) return json(400, { error: "invalid_name", message: "Give the digest a name (up to 120 characters)." });
      const v = validateConfig(body?.config, form.fields);
      if (!v.ok) return json(400, { error: "invalid_config", message: v.error });
      const digest = await insertDigest(env, {
        form_id: formId,
        name,
        enabled: body?.enabled !== false,
        config: v.config,
        created_by: gate.session.email ?? null
      });
      return json(201, { digest });
    }

    const m = /^\/([0-9a-f-]{36})$/i.exec(rest);
    if (m) {
      const existing = await getDigest(env, m[1]!);
      // Scoped by (form, digest) so a digest id can't be edited through another form's URL.
      if (!existing || existing.form_id !== formId) return json(404, { error: "digest_not_found" });
      if (req.method === "DELETE") {
        await deleteDigest(env, existing.id);
        return json(200, { ok: true });
      }
      if (req.method === "PATCH") {
        const body = await readJson(req);
        if (!body) return json(400, { error: "bad_request" });
        const patch: Parameters<typeof updateDigest>[2] = {};
        if ("name" in body) {
          const name = cleanName(body.name);
          if (!name) return json(400, { error: "invalid_name", message: "Give the digest a name (up to 120 characters)." });
          patch.name = name;
        }
        if ("enabled" in body) {
          if (typeof body.enabled !== "boolean") return json(400, { error: "bad_request" });
          patch.enabled = body.enabled;
        }
        if ("config" in body) {
          const v = validateConfig(body.config, form.fields);
          if (!v.ok) return json(400, { error: "invalid_config", message: v.error });
          patch.config = v.config;
        }
        return json(200, { digest: await updateDigest(env, existing.id, patch) });
      }
    }

    return json(405, { error: "method_not_allowed" });
  } catch (err) {
    console.error("[forms.digest.admin] failed", err);
    return json(500, { error: "digest_failed" });
  }
}
