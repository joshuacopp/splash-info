// POST /forms/admin/api/forms/{id}/re-resolve-approvers
//
// Re-points every IN-FLIGHT submission of a form at the approver list its
// CURRENT published version resolves to, and re-stamps
// `current_approver_emails`.
//
// WHY THIS HAS TO EXIST
//
//   `current_approver_emails` is denormalized -- written once at submit and
//   again at each transition -- and a submission is pinned to the version it
//   was filled on. Both are right on their own and together they produce a bad
//   operational failure:
//
//     200 tickets queue up, two people cannot keep up, a third is added to the
//     stage's approver list, a new version is published -- and the third
//     person sees NOTHING. Every existing row still carries the two original
//     addresses, and publishing does not rewrite rows.
//
//   So the change that was supposed to relieve the backlog applies only to
//   work that has not arrived yet. This endpoint re-stamps the backlog.
//
//   Version pinning stays correct for FORM FIELDS -- a submission must render
//   against the schema it was filled on, which is why this does NOT touch
//   `form_version_id`. It only rewrites routing, because who is on shift is
//   not a property of the form.
//
// PAIRS WITH the transition gate preferring the stamped column over
// re-resolving from the pinned schema. Without that half, this half would let
// somebody SEE 200 tickets and be refused on every one.

import { jsonError, isOriginAllowed } from "@splash/http";
import type { FormSchema } from "@splash/forms-schema";
import { adminGateResponse, requireServiceKey, submissionGate } from "./auth.js";
import { resolveApproverEmails } from "../workflow-resolution.js";
import type { Env } from "../index.js";

const FORM_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One pass is enough for any realistic backlog, and the cap stops a runaway
 *  from rewriting the world in a single request. */
const MAX_ROWS = 2000;

interface InFlightRow {
  id: string;
  workflow_stage: string | null;
  payload: Record<string, unknown>;
  current_approver_emails: string[] | null;
}

export async function handleReResolveApprovers(
  env: Env,
  req: Request,
  formId: string
): Promise<Response> {
  const sk = requireServiceKey(env);
  if (sk) return sk;
  if (!isOriginAllowed(req)) return jsonError(403, "bad_origin");
  if (!FORM_ID_RE.test(formId)) return jsonError(400, "bad_id");

  // ADMIN TIER ONLY, deliberately narrower than reading a submission. This
  // rewrites who is responsible for in-flight work across a whole form; it is
  // a staffing action, not a queue action.
  const gate = await submissionGate(env, req);
  if (!gate.ok) return adminGateResponse(gate);
  if (gate.scope !== "all") return jsonError(403, "forbidden");

  // The form's CURRENT published version -- the point is to pick up an
  // approver list that changed after these rows were created.
  let schema: FormSchema;
  try {
    // TWO QUERIES, NOT AN EMBED. db/admin-forms.ts deliberately reads
    // current_version_id and then fetches form_versions by id rather than
    // embedding, because the FK's name is not what PostgREST's implicit
    // naming would guess. Inferring a relationship name here would 400 at
    // runtime and typecheck perfectly -- the exact bug class CLAUDE.md records
    // from Briefs 62, 76, 80 and 86. One extra round-trip is the cost.
    const auth = {
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`
    };

    const fUrl = new URL("/rest/v1/forms", env.SUPABASE_URL);
    fUrl.searchParams.set("id", `eq.${formId}`);
    fUrl.searchParams.set("select", "current_version_id");
    fUrl.searchParams.set("limit", "1");
    const r = await fetch(fUrl.toString(), { headers: auth });
    if (!r.ok) {
      console.error("[forms.re-resolve] form read failed", r.status, await r.text().catch(() => ""));
      return jsonError(500, "form_read_failed");
    }
    const formRows = (await r.json().catch(() => [])) as {
      current_version_id: string | null;
    }[];
    const versionId = formRows[0]?.current_version_id;
    if (!versionId) return jsonError(404, "no_published_version");

    const vUrl = new URL("/rest/v1/form_versions", env.SUPABASE_URL);
    vUrl.searchParams.set("id", `eq.${versionId}`);
    vUrl.searchParams.set("select", "schema");
    vUrl.searchParams.set("limit", "1");
    const vr = await fetch(vUrl.toString(), { headers: auth });
    if (!vr.ok) {
      console.error("[forms.re-resolve] version read failed", vr.status);
      return jsonError(500, "form_read_failed");
    }
    const vRows = (await vr.json().catch(() => [])) as { schema: FormSchema }[];
    if (!vRows[0]?.schema) return jsonError(404, "no_published_version");
    schema = vRows[0].schema;
  } catch (err) {
    console.error("[forms.re-resolve] form read threw", err);
    return jsonError(500, "form_read_failed");
  }

  const workflow = schema.workflow;
  if (!workflow) return jsonError(400, "no_workflow");

  // In-flight rows only. A submission that has reached an outcome is nobody's
  // work and must not be resurrected into somebody's queue by a staffing
  // change.
  let rows: InFlightRow[];
  try {
    const sUrl = new URL("/rest/v1/form_submissions", env.SUPABASE_URL);
    sUrl.searchParams.set("form_id", `eq.${formId}`);
    sUrl.searchParams.set("workflow_stage", "not.is.null");
    sUrl.searchParams.set(
      "select",
      "id,workflow_stage,payload,current_approver_emails"
    );
    sUrl.searchParams.set("limit", String(MAX_ROWS));
    const r = await fetch(sUrl.toString(), {
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`
      }
    });
    if (!r.ok) {
      console.error("[forms.re-resolve] list failed", r.status, await r.text().catch(() => ""));
      return jsonError(500, "list_failed");
    }
    rows = (await r.json().catch(() => [])) as InFlightRow[];
  } catch (err) {
    console.error("[forms.re-resolve] list threw", err);
    return jsonError(500, "list_failed");
  }

  let updated = 0;
  let unchanged = 0;
  let skippedTerminal = 0;
  let skippedUnknownStage = 0;
  const failed: string[] = [];

  for (const row of rows) {
    const stage = workflow.stages.find((s) => s.id === row.workflow_stage);
    // The stage was renamed or removed between versions. Skipped rather than
    // guessed: re-pointing a ticket at a stage nobody chose would move work
    // silently, which is exactly the class of bug this endpoint fixes.
    if (!stage) {
      skippedUnknownStage += 1;
      continue;
    }
    if (!stage.approver_source) {
      skippedTerminal += 1;
      continue;
    }

    let resolved: string[];
    try {
      resolved = await resolveApproverEmails(env, stage.approver_source, {
        schema,
        payload: row.payload ?? {}
      });
    } catch (err) {
      console.error(`[forms.re-resolve] resolve failed for ${row.id}`, err);
      failed.push(row.id);
      continue;
    }

    const before = [...(row.current_approver_emails ?? [])].sort().join(",");
    const after = [...resolved].sort().join(",");
    if (before === after) {
      unchanged += 1;
      continue;
    }

    try {
      const pUrl = new URL("/rest/v1/form_submissions", env.SUPABASE_URL);
      pUrl.searchParams.set("id", `eq.${row.id}`);
      const pr = await fetch(pUrl.toString(), {
        method: "PATCH",
        headers: {
          apikey: env.SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
          "Content-Type": "application/json",
          Prefer: "return=minimal"
        },
        body: JSON.stringify({ current_approver_emails: resolved })
      });
      if (!pr.ok) {
        console.error(`[forms.re-resolve] patch failed for ${row.id}`, pr.status);
        failed.push(row.id);
        continue;
      }
      updated += 1;
    } catch (err) {
      console.error(`[forms.re-resolve] patch threw for ${row.id}`, err);
      failed.push(row.id);
    }
  }

  console.log(
    `[forms.re-resolve] form=${formId} scanned=${rows.length} updated=${updated} ` +
      `unchanged=${unchanged} terminal=${skippedTerminal} unknown_stage=${skippedUnknownStage} ` +
      `failed=${failed.length}`
  );

  return new Response(
    JSON.stringify({
      ok: true,
      scanned: rows.length,
      updated,
      unchanged,
      skipped_terminal: skippedTerminal,
      skipped_unknown_stage: skippedUnknownStage,
      failed,
      cap_reached: rows.length >= MAX_ROWS
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}
