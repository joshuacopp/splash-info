// Public submit handler: `POST /forms/api/submit/{slug}`.
//
// Per planning Decision 6 + Decision 8:
//   - CSRF gate via @splash/http isOriginAllowed (matches every other
//     monorepo write surface).
//   - Audience gating:
//       public      → Turnstile verified (fail-soft when secret unbound),
//                      submitter recorded as anonymous.
//       internal    → @splash/auth authenticate() validates the cookie;
//                      reject with 401 + structured JSON when stale so
//                      apps/web (and the Brief 90 form's user-facing JS)
//                      can surface a "session expired" message without
//                      losing in-memory form state.
//       link-only   → no auth required; if the user happens to have a
//                      valid session cookie we capture it (operator
//                      submitting from inside admin), else anonymous.
//   - Idempotent insert via the client-supplied `pending_submission_id`
//     (planning Decision 4) — re-POSTing the same id reads back the
//     existing row instead of double-inserting.
//   - Brief 92 — file/signature payloads carry r2_keys the client wrote
//     after out-of-band uploads. We HEAD each one against R2 to confirm
//     existence + authoritative size/mime, enforce per-submission ceilings,
//     enrich the payload before validation, then insert form_submission_files
//     rows after the canonical submission row lands.
//   - Brief 93 — lookup fields' payload values come from a server-side
//     re-resolve here, not from the parsed form data. The submit handler
//     ignores any client-supplied lookup value and writes the freshly
//     resolved one (defends against tampering AND handles mid-fill drift).

import { authenticate } from "@splash/auth";
import { isOriginAllowed, jsonError } from "@splash/http";
import { payloadValidatorFor, LOOKUP_SOURCES } from "@splash/forms-schema";
import { resolveLookup, createServiceClient } from "@splash/db-supabase";
import type { Env } from "../index.js";
import {
  getFormBySlug,
  getCurrentVersion,
  insertSubmissionIdempotent,
  insertSubmissionFiles,
  type SubmissionFileRowInsert,
  type SubmissionRow
} from "../db/forms.js";
import { parseSubmitFormData } from "./parse.js";
import { verifyTurnstile } from "./turnstile.js";
import { renderSuccessPage } from "./success.js";
import { fireSubmissionWebhook, type WebhookFile } from "./webhook.js";
import { HARD_LIMITS } from "../limits.js";

const PENDING_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function handleSubmit(
  env: Env,
  req: Request,
  ctx: ExecutionContext,
  slug: string
): Promise<Response> {
  if (!isOriginAllowed(req)) {
    return jsonError(403, "bad_origin");
  }

  const form = await getFormBySlug(env, slug);
  if (!form) return jsonError(404, "form_not_found");
  if (form.status !== "published") {
    return jsonError(410, "form_not_accepting_submissions");
  }
  if (!form.currentVersionId) {
    return jsonError(410, "form_has_no_published_version");
  }

  const version = await getCurrentVersion(env, form.id, form.currentVersionId);
  if (!version) return jsonError(500, "form_version_missing");

  // -----------------------------------------------------------------
  // Audience gate — derives submitterKind / submitterUserId / email.
  // -----------------------------------------------------------------
  let submitterKind: "authenticated" | "anonymous" = "anonymous";
  let submitterUserId: string | null = null;
  let submitterEmail: string | null = null;

  if (form.audience === "internal") {
    const auth = await authenticate(req, env);
    if (auth.status !== "authenticated") {
      // Structured 401 so the Brief 90 form's user-facing JS (and any
      // future apps/web preview surface) can surface a "session expired"
      // CTA without losing in-memory form state. Decision 8b.
      return jsonError(
        401,
        "session_expired: log in again in a new tab and click Retry on the form"
      );
    }
    submitterKind = "authenticated";
    submitterUserId = auth.session.userId;
    submitterEmail = auth.session.email;
  } else if (form.audience === "link-only") {
    // Best-effort capture of the operator's session if they happen to
    // already be authed. A stale / invalid cookie collapses to anonymous
    // (matches the brief's flag — link-only's slug is the gate, NOT the
    // session). authenticate() returns "unauthenticated" on either no
    // cookie or invalid cookie; either way we just stay anonymous.
    const auth = await authenticate(req, env);
    if (auth.status === "authenticated") {
      submitterKind = "authenticated";
      submitterUserId = auth.session.userId;
      submitterEmail = auth.session.email;
    }
  }
  // public: stays anonymous.

  // -----------------------------------------------------------------
  // Parse the multipart body.
  // -----------------------------------------------------------------
  let formData: FormData;
  try {
    formData = await req.formData();
  } catch (err) {
    console.error("[forms] handleSubmit: formData parse failed", err);
    return jsonError(400, "invalid_form_data");
  }
  const { payload, pendingSubmissionId, turnstileResponse } =
    parseSubmitFormData(formData, version.schema);

  if (!pendingSubmissionId || !PENDING_ID_RE.test(pendingSubmissionId)) {
    return jsonError(
      400,
      "invalid_pending_id: form submission identifier missing or malformed"
    );
  }

  // -----------------------------------------------------------------
  // Turnstile (public audience + form opted in via turnstile_required).
  // -----------------------------------------------------------------
  if (form.audience === "public" && form.turnstileRequired) {
    const remoteIp = req.headers.get("CF-Connecting-IP");
    const tr = await verifyTurnstile(
      env.TURNSTILE_SECRET_KEY,
      turnstileResponse,
      remoteIp
    );
    if (!tr.ok) {
      return jsonError(
        400,
        `turnstile_failed: ${tr.reason}. Please reload and try again.`
      );
    }
  }

  // -----------------------------------------------------------------
  // Brief 92 — resolve file/signature references against R2.
  //
  // For each file/signature payload entry, HEAD the R2 object to confirm
  // it exists at the expected prefix, then enrich the payload with
  // authoritative size/mime/original_filename so the validator sees the
  // full object shape (and the JSONB row carries it). Aggregate the
  // form_submission_files inserts for after the canonical submission
  // row lands.
  // -----------------------------------------------------------------
  const fileRowsToInsert: SubmissionFileRowInsert[] = [];
  let totalBytes = 0;
  let totalFiles = 0;
  for (const field of version.schema.fields) {
    if (field.type !== "file" && field.type !== "signature") continue;
    const entry = payload[field.key];
    if (!entry || typeof entry !== "object") continue;
    const r2_key = (entry as { r2_key?: unknown }).r2_key;
    if (typeof r2_key !== "string" || r2_key.length === 0) continue;

    const expectedPrefix = `form-submission-files/${form.id}/${pendingSubmissionId}/${field.key}/`;
    if (!r2_key.startsWith(expectedPrefix)) {
      return jsonError(
        400,
        `bad_r2_key: file reference for ${field.key} doesn't match this submission`
      );
    }

    let head: R2Object | null;
    try {
      head = await env.FORMS_FILES.head(r2_key);
    } catch (err) {
      console.error("[forms] handleSubmit: R2 head threw", err);
      return jsonError(500, "r2_head_failed: please try again");
    }
    if (!head) {
      return jsonError(
        400,
        `missing_file: file for ${field.key} not found in storage. Re-upload and try again.`
      );
    }

    totalFiles += 1;
    totalBytes += head.size;
    if (totalFiles > HARD_LIMITS.PER_SUBMISSION_MAX_FILES) {
      return jsonError(413, "too_many_files");
    }
    if (totalBytes > HARD_LIMITS.PER_SUBMISSION_MAX_BYTES) {
      return jsonError(413, "submission_too_large");
    }

    const mime = head.httpMetadata?.contentType ?? "application/octet-stream";
    const originalFilename = head.customMetadata?.originalFilename ?? null;

    payload[field.key] =
      field.type === "signature"
        ? { r2_key, format: field.format }
        : {
            r2_key,
            mime,
            size_bytes: head.size,
            original_filename: originalFilename
          };

    fileRowsToInsert.push({
      submissionId: pendingSubmissionId,
      fieldKey: field.key,
      r2Key: r2_key,
      mime,
      sizeBytes: head.size,
      originalFilename
    });
  }

  // -----------------------------------------------------------------
  // Brief 93 — server-side lookup re-resolve.
  //
  // Per planning Decision 5a.ii: the submit handler always writes the
  // SERVER-side fresh value, ignoring whatever the client sent. This
  // defends against tampering AND handles the rare mid-fill data drift
  // case (operator changes pricing_simple between render and submit).
  //
  // For each lookup field:
  //   - Find its key field; read the submitted key value.
  //   - Empty key value: clear the lookup payload (or skip for display_only).
  //   - Otherwise resolve via @splash/db-supabase resolveLookup.
  //   - Log a warning if the client value differs from the fresh value
  //     (drift / tampering signal).
  //   - For display_only mode: drop the payload key entirely.
  //   - Otherwise store the fresh value (empty string if null).
  //   - When `nullBehavior === "block_submit"` AND required AND fresh is
  //     null, surface an error so the operator sees `lookup_failed`.
  // -----------------------------------------------------------------
  const lookupResolveErrors: Record<string, string> = {};
  let supabaseClient: ReturnType<typeof createServiceClient> | null = null;
  for (const field of version.schema.fields) {
    if (field.type !== "lookup") continue;

    const keyField = version.schema.fields.find((f) => f.id === field.keyFieldId);
    if (!keyField) {
      lookupResolveErrors[field.key] = "Lookup misconfigured — key field missing from schema.";
      continue;
    }

    const keyValue = String(payload[keyField.key] ?? "").trim();
    if (!keyValue) {
      // No key value submitted. Per Decision 5: empty payload value
      // unless display_only (which drops the key entirely).
      if (field.resolutionMode === "display_only") {
        delete payload[field.key];
      } else {
        payload[field.key] = "";
      }
      continue;
    }

    const allowedSource = LOOKUP_SOURCES.find(
      (s) => s.table === field.sourceTable && s.column === field.sourceColumn
    );
    if (!allowedSource) {
      lookupResolveErrors[field.key] = "Lookup source not in registry.";
      continue;
    }

    if (!supabaseClient) supabaseClient = createServiceClient(env);
    const fresh = await resolveLookup({
      client: supabaseClient,
      source: allowedSource,
      keyColumn: field.keyColumn,
      keyValue
    });

    // Drift logging: compare client value (if any) to fresh value.
    const clientValue = payload[field.key];
    if (
      typeof clientValue === "string" &&
      clientValue !== "" &&
      clientValue !== fresh
    ) {
      console.warn("[forms.lookup] drift detected at submit", {
        formId: form.id,
        fieldKey: field.key,
        clientValue,
        freshValue: fresh
      });
    }

    if (fresh == null && field.required && field.nullBehavior === "block_submit") {
      lookupResolveErrors[field.key] =
        `Could not resolve ${field.label} for the selected ${keyField.label}.`;
      continue;
    }

    if (field.resolutionMode === "display_only") {
      delete payload[field.key];
    } else {
      payload[field.key] = fresh ?? "";
    }
  }

  if (Object.keys(lookupResolveErrors).length > 0) {
    return new Response(
      JSON.stringify({ error: "lookup_failed", fields: lookupResolveErrors }),
      {
        status: 422,
        headers: { "Content-Type": "application/json" }
      }
    );
  }

  // -----------------------------------------------------------------
  // Validate payload field-by-field. Aggregate errors so the user sees
  // every problem at once instead of fixing one and discovering the next.
  // -----------------------------------------------------------------
  const validationErrors: Record<string, string> = {};
  for (const field of version.schema.fields) {
    const validator = payloadValidatorFor(field);
    if (!validator) continue;
    const value = payload[field.key];
    const result = validator.safeParse(value);
    if (!result.success) {
      const firstIssue = result.error.issues[0];
      validationErrors[field.key] = firstIssue?.message ?? "Invalid value";
    }
  }
  if (Object.keys(validationErrors).length > 0) {
    return new Response(
      JSON.stringify({ error: "validation_failed", fields: validationErrors }),
      {
        status: 422,
        headers: { "Content-Type": "application/json" }
      }
    );
  }

  // -----------------------------------------------------------------
  // Idempotent insert.
  // -----------------------------------------------------------------
  const submitterIp = req.headers.get("CF-Connecting-IP");
  let inserted: { row: SubmissionRow; wasNew: boolean };
  try {
    inserted = await insertSubmissionIdempotent(env, {
      pendingSubmissionId,
      formId: form.id,
      formVersionId: form.currentVersionId,
      payload,
      submitterKind,
      submitterUserId,
      submitterEmail,
      submitterIp
    });
  } catch (err) {
    console.error("[forms] handleSubmit: insert failed", err);
    return jsonError(500, "insert_failed: please try again");
  }

  if (!inserted.wasNew) {
    console.log("[forms] handleSubmit: idempotent re-submit", inserted.row.id);
  }

  // -----------------------------------------------------------------
  // Brief 92 — record file/signature uploads in form_submission_files.
  // Best-effort: failure here doesn't reverse the submission. Brief 97's
  // orphan-cleanup cron sweeps any R2 objects that lose their DB row.
  // We only attempt the insert on a fresh submission; idempotent
  // re-submits already have their rows.
  // -----------------------------------------------------------------
  if (inserted.wasNew && fileRowsToInsert.length > 0) {
    await insertSubmissionFiles(env, fileRowsToInsert);
  }

  // -----------------------------------------------------------------
  // Brief 97 — fire FORMS_SUBMISSION_WEBHOOK_URL (Power Automate hook).
  //
  // Skip for idempotent re-submits — the original POST already fired
  // the webhook; re-firing would deliver duplicate notifications to PA.
  // ctx.waitUntil keeps the worker alive long enough to complete the
  // POST after the response is returned to the browser. Failure is
  // fully fail-soft inside fireSubmissionWebhook (logs only).
  // -----------------------------------------------------------------
  if (inserted.wasNew && env.FORMS_SUBMISSION_WEBHOOK_URL && form.notifyWebhook) {
    const reqUrl = new URL(req.url);
    const reqOrigin = `${reqUrl.protocol}//${reqUrl.host}`;
    const webhookFiles: WebhookFile[] = fileRowsToInsert.map((row) => ({
      field_key: row.fieldKey,
      r2_key: row.r2Key,
      mime: row.mime,
      size_bytes: row.sizeBytes,
      download_url: `${reqOrigin}/forms/admin/api/files/${encodeURIComponent(row.r2Key)}`
    }));
    ctx.waitUntil(
      fireSubmissionWebhook({
        env,
        reqOrigin,
        form,
        version,
        submission: inserted.row,
        files: webhookFiles
      })
    );
  }

  return renderSuccessPage(form);
}
