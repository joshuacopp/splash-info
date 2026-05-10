// Brief 92 — admin-gated R2 serve route.
//
// `GET /forms/admin/api/files/{r2_key}` — returns the R2 object's bytes
// to a logged-in super_admin or admin. Used by Brief 96's admin
// submissions UI to render file previews / download links.
//
// Auth posture mirrors Brief 83's fleet admin gate:
//   - super_admin (user_permissions.role)        → allow
//   - dcRole === "super_admin" or "admin"        → allow
//   - everyone else                              → 403
//
// The brief's draft referenced `validateSession` from @splash/auth, but
// the actual exported entry point is `authenticate(req, env)` — we use
// that here. Same outcome, just the canonical surface.

import { authenticate } from "@splash/auth";
import type { Env } from "../index.js";

export async function handleFileServe(
  env: Env,
  req: Request,
  r2_key: string
): Promise<Response> {
  const auth = await authenticate(req, env);
  if (auth.status !== "authenticated") {
    return new Response("Unauthorized", { status: 401 });
  }
  const session = auth.session;
  const allowed =
    session.role === "super_admin" ||
    session.dcRole === "admin" ||
    session.dcRole === "super_admin";
  if (!allowed) return new Response("Forbidden", { status: 403 });

  // Path traversal + prefix validation. Only the two known R2 namespaces
  // (form-submission-files/, form-assets/) are reachable through this
  // route; everything else 400s.
  if (
    !r2_key.startsWith("form-submission-files/") &&
    !r2_key.startsWith("form-assets/")
  ) {
    return new Response("Bad key", { status: 400 });
  }
  if (r2_key.includes("..")) return new Response("Bad key", { status: 400 });

  const obj = await env.FORMS_FILES.get(r2_key);
  if (!obj) return new Response("Not Found", { status: 404 });

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("Cache-Control", "private, max-age=300");

  // Inline display for images; attachment download for everything else.
  // Matches damage-worker's photo serve posture (inline JPEG for the
  // claim detail view, force-download PDFs).
  const contentType = headers.get("Content-Type") ?? "";
  if (!contentType.startsWith("image/")) {
    const filename = obj.customMetadata?.originalFilename ?? "download";
    const safe = filename.replace(/"/g, "");
    headers.set("Content-Disposition", `attachment; filename="${safe}"`);
  }

  return new Response(obj.body, { status: 200, headers });
}
