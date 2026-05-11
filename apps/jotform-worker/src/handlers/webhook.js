// JotForm webhook receiver (Brief 107).
//
// Route: POST /jotform/webhook/{token}/{form_id}
//
// Auth: URL-path token matched against env.JOTFORM_WEBHOOK_TOKEN. The
// JotForm Enterprise webhook UI does NOT expose a signing secret per
// operator-confirmed; URL secrecy is the entire auth posture. Anyone
// hitting /jotform/webhook/<wrong-token>/... gets 403. (Constant-time
// compare to defend against early-byte timing leaks; the token has ~32
// chars of entropy so this is belt-and-suspenders.)
//
// Status code policy: 2xx for accepted / 5xx for retry. JotForm retries
// on 5xx and treats 4xx as permanent failure — so an unknown form_id is
// 200 (don't make JotForm retry forever) but a transient JotForm API
// failure during the re-fetch is 500 (JotForm tries again).
//
// Flow:
//   1. Validate token against env.JOTFORM_WEBHOOK_TOKEN.
//   2. Look up form_id in `jotform_forms`; reject if disabled / unknown.
//   3. Parse application/x-www-form-urlencoded body; extract submissionID.
//   4. fetchSubmissionById to get the rich payload.
//   5. normalizeSubmission → insert row.
//   6. PostgREST upsert with on_conflict=id, Prefer:
//      resolution=merge-duplicates,return=minimal.
//   7. 200 OK.

import { jsonError } from "@splash/http";
import { fetchSubmissionById } from "../jotform.js";
import { normalizeSubmission } from "../normalize.js";
import { loadFormById } from "../db.js";

export async function handleWebhook(request, env, ctx, token, formId) {
  if (request.method !== "POST") {
    return jsonError(405, "method not allowed");
  }

  if (!env.JOTFORM_WEBHOOK_TOKEN) {
    console.error("[jotform.webhook] JOTFORM_WEBHOOK_TOKEN unbound");
    return jsonError(503, "webhook not configured");
  }
  if (!constantTimeEqual(token, env.JOTFORM_WEBHOOK_TOKEN)) {
    return new Response("forbidden", { status: 403 });
  }

  if (!env.SUPABASE_SERVICE_KEY || !env.JOTFORM_API_KEY) {
    console.error(
      "[jotform.webhook] required bindings missing (SUPABASE_SERVICE_KEY or JOTFORM_API_KEY)"
    );
    // 5xx so JotForm retries — the operator can re-bind and the queued
    // submissions catch up automatically.
    return jsonError(503, "webhook not configured");
  }

  const form = await loadFormById(env, formId);
  if (!form) {
    console.warn(
      `[jotform.webhook] unknown form_id=${formId}; returning 200 to halt JotForm retries`
    );
    return new Response("ok-unknown-form", { status: 200 });
  }
  if (form.enabled === false) {
    console.warn(
      `[jotform.webhook] form_id=${formId} disabled; returning 200 to halt JotForm retries`
    );
    return new Response("ok-disabled-form", { status: 200 });
  }

  // JotForm webhook bodies are application/x-www-form-urlencoded with a
  // small set of top-level fields (submissionID, formID, rawRequest,
  // pretty, ip, ...). We only need submissionID — the rest comes from
  // the API re-fetch.
  let formData;
  try {
    formData = await request.formData();
  } catch (err) {
    console.error("[jotform.webhook] formData parse error:", err);
    return jsonError(400, "malformed body");
  }
  const submissionID = formData.get("submissionID");
  if (!submissionID || typeof submissionID !== "string") {
    return jsonError(400, "submissionID missing");
  }

  let raw;
  try {
    raw = await fetchSubmissionById(env, submissionID);
  } catch (err) {
    console.error(
      `[jotform.webhook] fetchSubmissionById failed for ${submissionID}:`,
      err
    );
    return jsonError(500, "upstream fetch failed");
  }

  let row;
  try {
    row = normalizeSubmission(raw);
  } catch (err) {
    console.error("[jotform.webhook] normalize failed:", err);
    return jsonError(500, "normalize failed");
  }

  // Defense in depth — confirm the webhook's form_id matches the
  // submission's own form_id. JotForm bumps form_id on form
  // duplication/rename in some workflows; a mismatch means a stale
  // webhook URL is still pointed at a form whose id has changed. Log +
  // ignore (200 so retries stop).
  if (row.form_id !== formId) {
    console.warn(
      `[jotform.webhook] form_id mismatch: url=${formId} submission=${row.form_id}; halting retries`
    );
    return new Response("ok-form-mismatch", { status: 200 });
  }

  const upsertUrl = new URL("/rest/v1/jotform_submissions", env.SUPABASE_URL);
  upsertUrl.searchParams.set("on_conflict", "id");
  let resp;
  try {
    resp = await fetch(upsertUrl.toString(), {
      method: "POST",
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal"
      },
      body: JSON.stringify([row])
    });
  } catch (err) {
    console.error("[jotform.webhook] supabase upsert threw:", err);
    return jsonError(500, "supabase upsert failed");
  }
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    console.error(
      `[jotform.webhook] supabase upsert non-2xx (${resp.status}): ${body.slice(0, 200)}`
    );
    return jsonError(500, `supabase upsert ${resp.status}`);
  }

  return new Response(JSON.stringify({ ok: true, id: row.id }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

/**
 * Constant-time string compare. Branchless byte-by-byte XOR-accumulate;
 * early-byte timing differences across the loop don't leak the prefix.
 * Returns false if lengths differ.
 */
function constantTimeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
