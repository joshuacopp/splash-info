// Brief 125 — GET /forms/admin/api/users/search?q={query}
//
// Org-directory autosuggest backing the ApproverPicker's "Specific
// person" / "Multiple people" inputs. Reads from `auth_unified` (the
// view that joins `auth.users` with role info).
//
// Auth: same admin-tier gate as the rest of `/forms/admin/api/*`
// (super_admin OR dcRole admin/super_admin). Form builder access is
// already admin-tier; surfacing user emails to non-admins via the
// builder is unnecessary.
//
// Query matches `email` (substring, case-insensitive) and `full_name`
// (when present). 20-row cap; sorted by `email` ascending.

import { jsonError } from "@splash/http";
import { adminGate, adminGateResponse, requireServiceKey } from "./auth.js";
import type { Env } from "../index.js";

interface AuthUnifiedRow {
  user_id: string;
  email: string | null;
  dc_role?: string | null;
}

interface ResponseUser {
  email: string;
  full_name?: string | null;
  dc_role?: string | null;
}

const MAX_RESULTS = 20;

export async function handleUserSearch(
  env: Env,
  req: Request
): Promise<Response> {
  const sk = requireServiceKey(env);
  if (sk) return sk;
  const gate = await adminGate(env, req);
  if (!gate.ok) return adminGateResponse(gate);

  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  if (q.length < 2) {
    return new Response(JSON.stringify({ users: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }
  const escaped = q.replace(/[%,_]/g, "\\$&");

  // `auth_unified` exposes (user_id, email, role, locations,
  // must_change_password, tools, dc_role, dc_locations) — no
  // `full_name` column today (see packages/db-supabase/src/summary.ts
  // docblock). We match against `email` only. If the view is later
  // extended to surface `full_name`, widen the select + `or` filter
  // and the response shape already has a slot for it.
  const pgUrl = new URL("/rest/v1/auth_unified", env.SUPABASE_URL);
  pgUrl.searchParams.set("select", "user_id,email,dc_role");
  pgUrl.searchParams.set("email", `ilike.*${escaped}*`);
  pgUrl.searchParams.set("order", "email.asc");
  pgUrl.searchParams.set("limit", String(MAX_RESULTS));

  let rows: AuthUnifiedRow[];
  try {
    const resp = await fetch(pgUrl.toString(), {
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
        Accept: "application/json"
      }
    });
    if (!resp.ok) {
      console.error("[forms.users-search] supabase fetch failed", resp.status);
      return jsonError(502, "users_search_upstream");
    }
    rows = (await resp.json().catch(() => [])) as AuthUnifiedRow[];
  } catch (err) {
    console.error("[forms.users-search] threw", err);
    return jsonError(502, "users_search_failed");
  }

  const users: ResponseUser[] = [];
  for (const r of rows) {
    if (!r.email) continue;
    users.push({
      email: r.email,
      full_name: null,
      dc_role: r.dc_role ?? null
    });
  }

  return new Response(JSON.stringify({ users }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    }
  });
}
