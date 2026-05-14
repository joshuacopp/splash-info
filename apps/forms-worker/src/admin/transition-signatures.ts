// Brief 131 — admin transition-signature upload.
//
// POST /forms/admin/api/transition-signatures/{submission_id}
//
// The admin transition modal renders an inline <canvas>-backed
// signature pad (replacing Brief 120's r2_key paste input). When the
// approver clicks Confirm on the canvas, the client POSTs the rendered
// PNG blob here; the worker writes it to R2 and returns the r2_key.
// That r2_key feeds back into the hidden form input the transition
// server action submits to `POST .../transition` — which the Brief 120
// transition handler accepts via the existing `signature_r2_key`
// parameter (no contract change needed there).
//
// Auth: admin-tier gated, same posture as the rest of /forms/admin/api/*.
// The transition handler itself is broader (any authenticated session
// can transition when their email is on `current_approver_emails`); a
// follow-up brief can widen this endpoint if non-admin approvers need
// to capture signatures directly. Today the apps/web submission detail
// page is admin-tier-only, so the admin-tier gate here is consistent.

import { isOriginAllowed, jsonError } from "@splash/http";
import { adminGate, adminGateResponse, requireServiceKey } from "./auth.js";
import type { Env } from "../index.js";

const SUBMISSION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SIGNATURE_MAX_BYTES = 1 * 1024 * 1024; // 1 MB (mirrors HARD_LIMITS)

export async function handleTransitionSignatureUpload(
  env: Env,
  req: Request,
  submissionId: string
): Promise<Response> {
  const sk = requireServiceKey(env);
  if (sk) return sk;
  if (!isOriginAllowed(req)) return jsonError(403, "bad_origin");
  const gate = await adminGate(env, req);
  if (!gate.ok) return adminGateResponse(gate);

  if (!SUBMISSION_ID_RE.test(submissionId)) {
    return jsonError(400, "bad_submission_id");
  }

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch (err) {
    console.error("[forms.admin] transition-signature: bad form data", err);
    return jsonError(400, "invalid_form_data");
  }

  const sigEntry = formData.get("signature");
  if (!(sigEntry instanceof Blob)) return jsonError(400, "no_signature");
  if (sigEntry.size === 0) return jsonError(400, "empty_signature");
  if (sigEntry.size > SIGNATURE_MAX_BYTES) {
    return jsonError(413, "signature_too_large");
  }

  // Single-shot random suffix per upload. We don't need cryptographic
  // strength here — the r2_key is opaque + admin-gated on read. The
  // suffix just avoids collisions when the same operator captures
  // multiple signatures on the same submission (note + signature for
  // each of several transitions over time).
  const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  const r2_key = `transition-signatures/${submissionId}/${suffix}.png`;

  try {
    await env.FORMS_FILES.put(r2_key, sigEntry.stream(), {
      httpMetadata: { contentType: "image/png" },
      customMetadata: {
        submissionId,
        actor: gate.session.email,
        originalFilename: `${suffix}.png`
      }
    });
  } catch (err) {
    console.error("[forms.admin] transition-signature: R2 put failed", err);
    return jsonError(500, "r2_write_failed");
  }

  return new Response(
    JSON.stringify({
      r2_key,
      mime: "image/png",
      size_bytes: sigEntry.size
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" }
    }
  );
}
