// Brief 127 — `POST /forms/internal/api/email-queue/confirm`
//
// PA POSTs `{claim_id, results: [{id, status: "sent"|"failed", error?}]}`
// after attempting to send the batch claimed in the prior call.
//
// Per result:
//   - `sent`   — stamp `sent_at = now()`, clear `last_error`.
//   - `failed` — release the claim (clear `claimed_at` + `claim_id`),
//     increment `send_attempts`, record `last_error`.
//
// Rows are scoped by `(id, claim_id)` so a spoofed/replayed confirm
// can't touch rows it didn't claim. Rows whose `claim_id` no longer
// matches (stale 10-min reclaim already happened) are counted as
// `skipped` in the response.
//
// `send_attempts >= 5` rows naturally drop out of the claim function's
// eligible pool — no separate stuck state at v1.

import { jsonError } from "@splash/http";

import type { Env } from "../index.js";
import { checkQueueAuth } from "./claim.js";

interface ConfirmResultIn {
  id?: unknown;
  status?: unknown;
  error?: unknown;
}

interface ConfirmBody {
  claim_id?: unknown;
  results?: unknown;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function handleEmailQueueConfirm(
  env: Env,
  req: Request
): Promise<Response> {
  const tokenGate = checkQueueAuth(env, req);
  if (tokenGate) return tokenGate;

  let body: ConfirmBody;
  try {
    body = await req.json();
  } catch {
    return jsonError(400, "bad_json");
  }
  if (typeof body.claim_id !== "string" || !UUID_RE.test(body.claim_id)) {
    return jsonError(400, "bad_claim_id");
  }
  if (!Array.isArray(body.results)) {
    return jsonError(400, "bad_results");
  }
  const claimId: string = body.claim_id;

  let confirmedSent = 0;
  let confirmedFailed = 0;
  let skipped = 0;

  for (const raw of body.results) {
    if (!raw || typeof raw !== "object") {
      skipped += 1;
      continue;
    }
    const r = raw as ConfirmResultIn;
    if (typeof r.id !== "string" || !UUID_RE.test(r.id)) {
      skipped += 1;
      continue;
    }
    const id: string = r.id;
    if (r.status === "sent") {
      const ok = await markSent(env, id, claimId);
      if (ok) confirmedSent += 1;
      else skipped += 1;
    } else if (r.status === "failed") {
      const errStr =
        typeof r.error === "string" ? r.error.slice(0, 1000) : "send_failed";
      const ok = await markFailed(env, id, claimId, errStr);
      if (ok) confirmedFailed += 1;
      else skipped += 1;
    } else {
      skipped += 1;
    }
  }

  return new Response(
    JSON.stringify({
      confirmed_sent: confirmedSent,
      confirmed_failed: confirmedFailed,
      skipped
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store"
      }
    }
  );
}

async function markSent(
  env: Env,
  id: string,
  claimId: string
): Promise<boolean> {
  const url = new URL("/rest/v1/outbound_emails", env.SUPABASE_URL);
  url.searchParams.set("id", `eq.${id}`);
  url.searchParams.set("claim_id", `eq.${claimId}`);
  const resp = await fetch(url.toString(), {
    method: "PATCH",
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation"
    },
    body: JSON.stringify({
      sent_at: new Date().toISOString(),
      last_error: null
    })
  });
  if (!resp.ok) {
    console.error(
      `[forms.email-queue.confirm] markSent PATCH ${resp.status} for ${id}`
    );
    return false;
  }
  const rows = (await resp.json().catch(() => [])) as unknown[];
  return Array.isArray(rows) && rows.length > 0;
}

async function markFailed(
  env: Env,
  id: string,
  claimId: string,
  errorStr: string
): Promise<boolean> {
  // Two-call sequence: (1) read send_attempts so we can increment, (2)
  // PATCH. PostgREST doesn't expose `column = column + 1` arithmetic at
  // the table layer.
  const readUrl = new URL("/rest/v1/outbound_emails", env.SUPABASE_URL);
  readUrl.searchParams.set("id", `eq.${id}`);
  readUrl.searchParams.set("claim_id", `eq.${claimId}`);
  readUrl.searchParams.set("select", "send_attempts");
  readUrl.searchParams.set("limit", "1");
  const readResp = await fetch(readUrl.toString(), {
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      Accept: "application/json"
    }
  });
  if (!readResp.ok) {
    console.error(
      `[forms.email-queue.confirm] markFailed read ${readResp.status} for ${id}`
    );
    return false;
  }
  const readRows = (await readResp.json().catch(() => [])) as Array<{
    send_attempts?: number;
  }>;
  if (readRows.length === 0) return false;
  const next = (readRows[0]?.send_attempts ?? 0) + 1;

  const patchUrl = new URL("/rest/v1/outbound_emails", env.SUPABASE_URL);
  patchUrl.searchParams.set("id", `eq.${id}`);
  patchUrl.searchParams.set("claim_id", `eq.${claimId}`);
  const resp = await fetch(patchUrl.toString(), {
    method: "PATCH",
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation"
    },
    body: JSON.stringify({
      claimed_at: null,
      claim_id: null,
      send_attempts: next,
      last_error: errorStr
    })
  });
  if (!resp.ok) {
    console.error(
      `[forms.email-queue.confirm] markFailed PATCH ${resp.status} for ${id}`
    );
    return false;
  }
  const rows = (await resp.json().catch(() => [])) as unknown[];
  return Array.isArray(rows) && rows.length > 0;
}
