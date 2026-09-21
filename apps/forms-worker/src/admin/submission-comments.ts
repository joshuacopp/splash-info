// Brief 174 — comment threads on form submissions.
//
// Endpoints:
//   GET  /forms/admin/api/forms/{id}/submissions/{subId}/comments
//   POST /forms/admin/api/forms/{id}/submissions/{subId}/comments
//
// WHY THIS EXISTS ALONGSIDE workflow_history
//
//   History audits what HAPPENED to a ticket. Before this, the only way to say
//   anything about a submission was a transition note -- so information moved
//   only when the ticket moved, and asking a question meant bouncing the ticket
//   to somebody else's queue to ask it. The state machine was being driven by
//   the need to talk. Transitions stay the record of state changes; comments
//   carry the conversation and move nothing.
//
// COMMENTS NOTIFY NOBODY AT v1. Deliberate, and a real limitation rather than
// an oversight: a transition is still the only thing that lands a ticket in
// somebody's queue, so it remains the "your turn" signal. Adding notification
// later should ride the Brief 127 outbound_emails queue rather than a webhook.

import { authenticate } from "@splash/auth";
import { isOriginAllowed, jsonError } from "@splash/http";
import { requireServiceKey } from "./auth.js";
import { getSubmission } from "../db/admin-submissions.js";
import { resolveApproverEmails } from "../workflow-resolution.js";
import type { Env } from "../index.js";

const FORM_ID_RE = /^[0-9a-f-]{36}$/i;
const SUB_ID_RE = /^[0-9a-f-]{36}$/i;

/** Matches the CHECK on the table. Enforced in both places on purpose: the
 *  column guards a direct SQL insert, this guards the API. */
const BODY_MAX = 10_000;

/** Newest kept when a thread runs long. A ticket with more discussion than
 *  this has a problem no scrollback will solve. */
const THREAD_CAP = 200;

export interface SubmissionComment {
  id: string;
  author_email: string;
  body: string;
  created_at: string;
}

/**
 * May this caller read and post on this submission's thread?
 *
 * FOUR PATHS, and the last two are what make it a conversation rather than a
 * pair of monologues:
 *
 *   - admin tier — the existing escape hatch everywhere else on this surface
 *   - the CURRENT stage's resolved approver — it is their ticket right now
 *   - the SUBMITTER — covers the site before it has acted on anything
 *   - anyone already in workflow_history — covers everyone after
 *
 * Scoping to the current approver alone reads as the obvious rule and breaks
 * the exact case this feature is for: a site that hands a ticket back to CRD
 * could not answer CRD's follow-up question, because it is no longer their
 * turn. Whoever has been involved stays able to speak.
 *
 * Returns a discriminated result rather than a boolean so the POST handler can
 * tell "not allowed" from "no such submission" without a second fetch.
 */
async function authorizeDiscussion(
  env: Env,
  req: Request
): Promise<
  | { ok: true; session: { email: string; userId: string | null } }
  | { ok: false; status: number; error: string }
> {
  const auth = await authenticate(req, env);
  if (auth.status !== "authenticated") {
    return { ok: false, status: 401, error: "unauthenticated" };
  }
  const { session } = auth;
  return {
    ok: true,
    session: {
      email: session.email.trim().toLowerCase(),
      userId: (session as { userId?: string | null }).userId ?? null
    }
  };
}

/** The authority rule itself, given an already-loaded submission. Split from
 *  the fetch so both endpoints share one definition -- two copies of an
 *  authority rule is the mistake Brief 173 was written to avoid. */
async function callerMayDiscuss(
  env: Env,
  req: Request,
  callerEmail: string,
  submission: {
    submitter_email: string | null;
    workflow_stage: string | null;
    workflow_history: unknown;
    payload: unknown;
    version: { schema: unknown };
  }
): Promise<boolean> {
  const auth = await authenticate(req, env);
  if (auth.status !== "authenticated") return false;
  const { session } = auth;

  // 1. Admin tier.
  if (
    session.role === "super_admin" ||
    session.dcRole === "admin" ||
    session.dcRole === "super_admin"
  ) {
    return true;
  }

  // 2. The submitter.
  if (
    typeof submission.submitter_email === "string" &&
    submission.submitter_email.trim().toLowerCase() === callerEmail
  ) {
    return true;
  }

  // 3. Already acted on it. Cheap -- the array is on the row we already have.
  const history = Array.isArray(submission.workflow_history)
    ? (submission.workflow_history as { actor_email?: unknown }[])
    : [];
  for (const h of history) {
    if (
      typeof h?.actor_email === "string" &&
      h.actor_email.trim().toLowerCase() === callerEmail
    ) {
      return true;
    }
  }

  // 4. Current stage's resolved approver. Last because it is the only branch
  //    that costs a resolve, and because a form with no workflow at all stops
  //    here rather than throwing.
  try {
    const schema = submission.version.schema as {
      workflow?: {
        default_stage: string;
        stages: { id: string; approver_source?: unknown }[];
      };
    };
    const workflow = schema?.workflow;
    if (!workflow) return false;
    const stageId = submission.workflow_stage ?? workflow.default_stage;
    const stage = workflow.stages.find((s) => s.id === stageId);
    if (!stage?.approver_source) return false;
    const allowed = await resolveApproverEmails(
      env,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stage.approver_source as any,
      {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        schema: schema as any,
        payload: (submission.payload ?? {}) as Record<string, unknown>
      }
    );
    return allowed.includes(callerEmail);
  } catch (err) {
    // A resolver failure is "not authorised", which is the safe direction. The
    // alternative is a 500 that reads as an outage on a page that should
    // simply have said no.
    console.error("[forms.comments] approver resolve failed", err);
    return false;
  }
}

/**
 * Load the submission and decide authority in one place.
 *
 * Deliberately UNSCOPED by location: authority here is per-submission, which is
 * already narrower than any location filter, and scoping would break the
 * legitimate approver who holds no locations at all -- the normal case for the
 * people this exists for.
 */
async function loadAndAuthorize(
  env: Env,
  req: Request,
  formId: string,
  subId: string,
  callerEmail: string
): Promise<
  | { ok: true }
  | { ok: false; status: number; error: string }
> {
  let submission: Awaited<ReturnType<typeof getSubmission>>;
  try {
    submission = await getSubmission(env, formId, subId);
  } catch (err) {
    console.error("[forms.comments] load submission failed", err);
    return { ok: false, status: 500, error: "load_failed" };
  }
  if (!submission) return { ok: false, status: 404, error: "not_found" };

  const may = await callerMayDiscuss(
    env,
    req,
    callerEmail,
    submission as unknown as Parameters<typeof callerMayDiscuss>[3]
  );
  // Refused and missing are the SAME answer on the wire. Telling a prober that
  // a submission exists but is not theirs is itself an answer, and the rest of
  // this admin surface (jotform out-of-scope rows, promo materials) already
  // takes that posture.
  if (!may) return { ok: false, status: 404, error: "not_found" };
  return { ok: true };
}

// =============================================================================
// GET
// =============================================================================

export async function handleListComments(
  env: Env,
  req: Request,
  formId: string,
  subId: string
): Promise<Response> {
  const sk = requireServiceKey(env);
  if (sk) return sk;
  if (!FORM_ID_RE.test(formId) || !SUB_ID_RE.test(subId)) {
    return jsonError(400, "bad_id");
  }

  const authed = await authorizeDiscussion(env, req);
  if (!authed.ok) return jsonError(authed.status, authed.error);

  const gate = await loadAndAuthorize(env, req, formId, subId, authed.session.email);
  if (!gate.ok) return jsonError(gate.status, gate.error);

  const url = new URL("/rest/v1/form_submission_comments", env.SUPABASE_URL);
  url.searchParams.set("select", "id,author_email,body,created_at");
  url.searchParams.set("submission_id", `eq.${subId}`);
  // Oldest first reads as a conversation. The cap keeps the NEWEST when a
  // thread overruns, so ordering is applied after the limit, below.
  url.searchParams.set("order", "created_at.desc");
  url.searchParams.set("limit", String(THREAD_CAP));

  let resp: Response;
  try {
    resp = await fetch(url.toString(), {
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`
      }
    });
  } catch (err) {
    console.error("[forms.comments] list fetch threw", err);
    return jsonError(500, "list_failed");
  }
  if (!resp.ok) {
    console.error("[forms.comments] list returned", resp.status, await resp.text().catch(() => ""));
    return jsonError(500, "list_failed");
  }

  const rows = (await resp.json().catch(() => [])) as SubmissionComment[];
  return new Response(JSON.stringify({ comments: rows.reverse() }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}

// =============================================================================
// POST
// =============================================================================

export async function handleCreateComment(
  env: Env,
  req: Request,
  formId: string,
  subId: string
): Promise<Response> {
  const sk = requireServiceKey(env);
  if (sk) return sk;
  if (!isOriginAllowed(req)) return jsonError(403, "bad_origin");
  if (!FORM_ID_RE.test(formId) || !SUB_ID_RE.test(subId)) {
    return jsonError(400, "bad_id");
  }

  const authed = await authorizeDiscussion(env, req);
  if (!authed.ok) return jsonError(authed.status, authed.error);

  let body: { body?: unknown };
  try {
    body = (await req.json()) as { body?: unknown };
  } catch {
    return jsonError(400, "bad_json");
  }
  const text = typeof body.body === "string" ? body.body.trim() : "";
  if (text === "") return jsonError(400, "empty_body");
  if (text.length > BODY_MAX) return jsonError(400, "body_too_long");

  const gate = await loadAndAuthorize(env, req, formId, subId, authed.session.email);
  if (!gate.ok) return jsonError(gate.status, gate.error);

  const url = new URL("/rest/v1/form_submission_comments", env.SUPABASE_URL);
  let resp: Response;
  try {
    resp = await fetch(url.toString(), {
      method: "POST",
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=representation"
      },
      body: JSON.stringify({
        submission_id: subId,
        author_email: authed.session.email,
        author_user_id: authed.session.userId,
        body: text
      })
    });
  } catch (err) {
    console.error("[forms.comments] insert threw", err);
    return jsonError(500, "create_failed");
  }
  if (!resp.ok) {
    console.error("[forms.comments] insert returned", resp.status, await resp.text().catch(() => ""));
    return jsonError(500, "create_failed");
  }

  const rows = (await resp.json().catch(() => [])) as SubmissionComment[];
  return new Response(JSON.stringify({ comment: rows[0] ?? null }), {
    status: 201,
    headers: { "Content-Type": "application/json" }
  });
}
