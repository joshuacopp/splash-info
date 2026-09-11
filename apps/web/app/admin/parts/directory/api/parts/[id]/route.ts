// Update / delete a part — PATCH and DELETE
// /admin/parts/directory/api/parts/{id}. super_admin only.
//
// Proxies onto `PATCH|DELETE /workorders/api/parts/{id}`. Same posture as the
// sibling POST route: body forwarded verbatim, worker owns validation, worker
// owns the 409, status and body come straight back.
//
// THE ONE PIECE OF REAL LOGIC HERE IS THE R2 CLEANUP ON DELETE.
// splash-workorders has no R2 binding — `splash-parts-manuals` is bound to
// apps/web as PARTS_FILES — so the worker deletes the row and hands the
// now-orphaned `photo_r2_key` back in its response specifically so this
// handler can finish the job (see the PHOTOS note at the top of
// apps/workorders-worker/src/parts.ts).
//
// That cleanup is BEST EFFORT AND NEVER FATAL. The row is already gone by the
// time we try; failing the response would tell the operator the delete didn't
// happen, they would retry, and the retry would 404 — leaving them staring at
// an error for a part that no longer exists. A leaked object costs a few KB.
// So: log it and return the worker's success.

import { getCloudflareContext } from "@opennextjs/cloudflare";
import { partsWorkerFetch, PARTS_API_PATH } from "../../../_lib/parts";
import { requirePartsAdmin } from "../../../_lib/admin-gate";
import { readJsonText, relayWorkerResponse } from "../../../_lib/write-proxy";

export const dynamic = "force-dynamic";

/** Same prefix the upload route mints under and the serve route enforces. */
const KEY_PREFIX = "parts-directory/";

function itemPath(id: string): string {
  return `${PARTS_API_PATH}/${encodeURIComponent(id)}`;
}

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> }
): Promise<Response> {
  const gate = await requirePartsAdmin();
  if (!gate.ok) return gate.response;

  const { id } = await ctx.params;
  const body = await readJsonText(req);
  if (!body.ok) return body.response;

  const upstream = await partsWorkerFetch(itemPath(id), {
    method: "PATCH",
    jsonBody: body.text
  });

  const relayed = await relayWorkerResponse(upstream);
  if (relayed.status === 200) {
    console.log(`[parts.update] id=${id} by ${gate.session.email}`);
  }
  return relayed.response;
}

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string }> }
): Promise<Response> {
  const gate = await requirePartsAdmin();
  if (!gate.ok) return gate.response;

  const { id } = await ctx.params;

  const upstream = await partsWorkerFetch(itemPath(id), { method: "DELETE" });
  const relayed = await relayWorkerResponse(upstream);

  if (relayed.status === 200) {
    console.log(`[parts.delete] id=${id} by ${gate.session.email}`);
    await cleanUpPhoto(readPhotoKey(relayed.body), id);
  }

  return relayed.response;
}

/** `photo_r2_key` off the worker's delete response, when it had one. */
function readPhotoKey(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const key = (body as { photo_r2_key?: unknown }).photo_r2_key;
  return typeof key === "string" && key ? key : null;
}

/**
 * Drop the orphaned object. Swallows everything — see the note in the file
 * header. The prefix check is not paranoia theatre: the manuals live in the
 * same bucket, so a `photo_r2_key` that somehow said `manifest.json` would
 * otherwise take the whole /admin/parts index down on one delete.
 */
async function cleanUpPhoto(key: string | null, id: string): Promise<void> {
  if (!key) return;
  if (!key.startsWith(KEY_PREFIX) || key.includes("..")) {
    console.error(
      `[parts.delete] refusing to delete out-of-prefix key for id=${id}:`,
      key
    );
    return;
  }

  try {
    const { env } = await getCloudflareContext({ async: true });
    if (!env?.PARTS_FILES) {
      console.warn(
        `[parts.delete] no PARTS_FILES binding; leaked photo ${key} (id=${id})`
      );
      return;
    }
    await env.PARTS_FILES.delete(key);
    console.log(`[parts.delete] removed photo ${key} (id=${id})`);
  } catch (err) {
    console.error(
      `[parts.delete] photo cleanup failed, leaked ${key} (id=${id})`,
      err
    );
  }
}
