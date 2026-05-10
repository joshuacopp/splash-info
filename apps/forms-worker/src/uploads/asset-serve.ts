// Public in-form asset serve.
//
// `GET /forms/api/asset/{form_id}/{asset_id}` — no auth. Backs the image
// renderer's <img src=...> URL (apps/forms-worker/src/render/fields/image.ts)
// for in-form display images. Public because the form itself can be public
// (or internal / link-only) — once a viewer has the form URL they're already
// entitled to see whatever's embedded in it.
//
// Scoping: we look up the asset by id and confirm form_id matches the URL
// parameter. This isn't an auth boundary (assets are public by design) — it's
// just defense against a typo'd URL pulling the wrong form's asset by accident.
//
// Distinct from `serve.ts` (which is admin-gated and serves submission files
// + assets by raw r2_key). This route serves only `form_assets` rows by their
// (form_id, asset_id) tuple. We resolve the actual r2_key from the DB row so
// the URL never exposes the R2 path or the file extension.

import { getFormAsset } from "../db/admin-forms.js";
import type { Env } from "../index.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function handlePublicAssetServe(
  env: Env,
  _req: Request,
  formId: string,
  assetId: string
): Promise<Response> {
  if (!UUID_RE.test(formId) || !UUID_RE.test(assetId)) {
    return new Response("Bad id", { status: 400 });
  }

  let asset;
  try {
    asset = await getFormAsset(env, assetId);
  } catch (err) {
    console.error("[forms.asset] lookup failed", err);
    return new Response("Server error", { status: 500 });
  }
  if (!asset) return new Response("Not Found", { status: 404 });
  if (asset.formId !== formId) {
    // Asset exists but belongs to a different form — treat as 404 rather
    // than 403 to avoid leaking the existence of cross-form asset IDs.
    return new Response("Not Found", { status: 404 });
  }

  const obj = await env.FORMS_FILES.get(asset.r2Key);
  if (!obj) return new Response("Not Found", { status: 404 });

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  // Public, edge-cacheable for an hour. Form assets are immutable per
  // upload (a "replace" creates a new asset_id), so caching is safe.
  headers.set("Cache-Control", "public, max-age=3600");

  return new Response(obj.body, { status: 200, headers });
}
