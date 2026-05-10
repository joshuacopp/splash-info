// Brief 93 — on-demand lookup resolve endpoint.
// `POST /forms/api/lookup/{slug}` body `{lookup_field_id, key_value}`
// → `{value: string | null, resolved_at: ISO}`.
//
// Per planning Decision 5b: the public form's client JS calls this when
// the user changes the key field's value, so the dependent lookup field
// can populate visibly. The submit handler does its own server-side
// re-resolve (Decision 5a.ii) — this endpoint is for UX only.
//
// Defenses:
//   - Same-origin via @splash/http isOriginAllowed.
//   - Form must be published; `lookup_field_id` must be a `lookup` field
//     in the current schema.
//   - sourceTable + sourceColumn must appear in LOOKUP_SOURCES — defense
//     against a hand-edited `form_versions.schema` JSONB exfiltrating an
//     arbitrary pricing_simple/locations column.

import { isOriginAllowed, jsonError } from "@splash/http";
import { resolveLookup, createServiceClient } from "@splash/db-supabase";
import { LOOKUP_SOURCES } from "@splash/forms-schema";
import type { LookupField } from "@splash/forms-schema";
import type { Env } from "../index.js";
import { getFormBySlug, getCurrentVersion } from "../db/forms.js";

export async function handleLookupResolve(
  env: Env,
  req: Request,
  slug: string
): Promise<Response> {
  if (!isOriginAllowed(req)) {
    return jsonError(403, "bad_origin");
  }

  const form = await getFormBySlug(env, slug);
  if (!form) return jsonError(404, "form_not_found");
  if (form.status !== "published" || !form.currentVersionId) {
    return jsonError(410, "form_not_accepting");
  }

  const version = await getCurrentVersion(env, form.id, form.currentVersionId);
  if (!version) return jsonError(500, "form_version_missing");

  let body: { lookup_field_id?: unknown; key_value?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return jsonError(400, "bad_json: body must be valid JSON");
  }
  if (typeof body.lookup_field_id !== "string" || body.lookup_field_id.length === 0) {
    return jsonError(400, "missing_field_id: lookup_field_id required");
  }

  const fieldId = body.lookup_field_id;
  const field = version.schema.fields.find(
    (f) => f.id === fieldId && f.type === "lookup"
  ) as LookupField | undefined;
  if (!field) {
    return jsonError(400, "unknown_field: lookup field not found in this form's schema");
  }

  const allowedSource = LOOKUP_SOURCES.find(
    (s) => s.table === field.sourceTable && s.column === field.sourceColumn
  );
  if (!allowedSource) {
    return jsonError(
      400,
      `unknown_source: source ${field.sourceTable}.${field.sourceColumn} not in registry`
    );
  }

  const keyValue =
    typeof body.key_value === "string" ? body.key_value : "";
  if (!keyValue) {
    return new Response(
      JSON.stringify({ value: null, resolved_at: new Date().toISOString() }),
      {
        status: 200,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
      }
    );
  }

  const client = createServiceClient(env);
  const value = await resolveLookup({
    client,
    source: allowedSource,
    keyColumn: field.keyColumn,
    keyValue
  });

  return new Response(
    JSON.stringify({ value, resolved_at: new Date().toISOString() }),
    {
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
    }
  );
}
