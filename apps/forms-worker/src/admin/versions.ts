// Brief 96 — admin version-history handler.
//
// Route (mounted in src/index.ts):
//
//   GET /forms/admin/api/forms/{id}/versions
//
// Returns every form_versions row for the form (newest first), including
// the embedded submission count + computed field count. Powers the
// `/admin/forms/[id]/versions` audit-trail table.
//
// No diff renderer at v1 (planning Decision 7) — operators see the count
// of fields per version and the published-at + published-by tuple, which
// is enough to spot when a schema change rolled out and which submissions
// land under it.

import { jsonError } from "@splash/http";
import { adminGate, adminGateResponse, requireServiceKey } from "./auth.js";
import { listVersionsWithCounts } from "../db/admin-submissions.js";
import type { Env } from "../index.js";

const FORM_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function handleListVersions(
  env: Env,
  req: Request,
  formId: string
): Promise<Response> {
  const sk = requireServiceKey(env);
  if (sk) return sk;
  const gate = await adminGate(env, req);
  if (!gate.ok) return adminGateResponse(gate);

  if (!FORM_ID_RE.test(formId)) return jsonError(400, "bad_id");

  try {
    const items = await listVersionsWithCounts(env, formId);
    return new Response(JSON.stringify({ items }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store"
      }
    });
  } catch (err) {
    console.error("[forms.admin] list versions failed", err);
    return jsonError(500, "list_failed");
  }
}
