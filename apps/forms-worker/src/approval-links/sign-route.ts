// GET /forms/admin/api/forms/{formId}/submissions/{subId}/sign
//
// Opens the emailed-link signing page (/forms/approve/{token}) for a SIGNED-IN
// approver, so a step that has its own signing page -- a stage with
// `page_intro`, e.g. the Pay Change employee acknowledgement -- can be reached
// from the Pending Approvals queue and the submission page, not only from the
// email (operator, 2026-11-13: relying on emails alone is not acceptable).
//
// The caller must be on the submission's CURRENT approver list. A fresh link is
// minted for the caller's own address and the browser is redirected to it; the
// link page then applies all of its usual checks (stage still current,
// recipient still an approver, expiry) and records the decision through the
// same applyTransition as every other path. Admins who are not on the list are
// refused rather than handed a link: the signing page records WHO signed, and
// an admin is not the person this step is waiting on.
//
// Same-origin redirect (path only), so it works on staging and production
// alike regardless of the base URL baked into minted links.

import { authenticate } from "@splash/auth";
import type { Env } from "../index.js";
import { mintApprovalLink } from "./tokens.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function page(status: number, message: string): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>Signing page</title><body style="font-family:system-ui,sans-serif;max-width:560px;margin:48px auto;padding:0 16px;color:#0e2745">` +
      `<p>${message}</p><p><a href="/admin/approvals">Back to Pending Approvals</a></p></body>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } }
  );
}

export async function handleOpenSigningPage(
  env: Env,
  req: Request,
  formId: string,
  submissionId: string
): Promise<Response> {
  const auth = await authenticate(req, env);
  if (auth.status !== "authenticated") {
    const next = new URL(req.url).pathname;
    return Response.redirect(new URL(`/login?next=${encodeURIComponent(next)}`, req.url).toString(), 302);
  }
  if (!UUID_RE.test(formId) || !UUID_RE.test(submissionId)) return page(404, "That request was not found.");

  const url = new URL("/rest/v1/form_submissions", env.SUPABASE_URL);
  url.searchParams.set("select", "id,form_id,workflow_stage,current_approver_emails");
  url.searchParams.set("id", `eq.${submissionId}`);
  url.searchParams.set("form_id", `eq.${formId}`);
  url.searchParams.set("limit", "1");
  const resp = await fetch(url.toString(), {
    headers: { apikey: env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}` }
  });
  if (!resp.ok) return page(502, "Couldn't load the request. Try again.");
  const row = ((await resp.json().catch(() => [])) as {
    workflow_stage: string | null;
    current_approver_emails: string[] | null;
  }[])[0];

  const me = auth.session.email.trim().toLowerCase();
  const approvers = (row?.current_approver_emails ?? []).map((e) => e.trim().toLowerCase());
  // Not found and not yours read the same, like every other submission read.
  if (!row || !row.workflow_stage || !approvers.includes(me)) {
    return page(404, "This step isn't waiting on you. It may already be done.");
  }

  const link = await mintApprovalLink(env, {
    formId,
    submissionId,
    stageId: row.workflow_stage,
    recipient: me
  });
  if (!link) return page(502, "Couldn't open the signing page. Try again.");
  return Response.redirect(new URL(new URL(link).pathname, req.url).toString(), 302);
}
