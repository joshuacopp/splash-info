// GET /forms/api/visible-to-me — credentialed-user index endpoint (Brief 99).
//
// Returns the list of forms the calling session can see in their /forms
// index page on apps/web. v1 returns published internal-audience forms
// (no per-user filtering yet). The endpoint name is intentionally
// semantic ("visible to me") so option 3 (per-role / per-location
// visibility — see Brief 99 architecture context) is a strictly
// additive filter inside this handler with no contract change.
//
// Forward-compat: response always includes `audience` even though v1 only
// returns "internal" forms — option 3 will widen to surface link-only
// forms the user is entitled to.
//
// Auth: any valid session. Unlike admin/* routes, this is NOT gated to
// super_admin/admin — gm, rm, location_admin all see the index. The
// underlying forms-worker render path (Brief 90) re-checks audience-level
// access on click-through anyway.

import { authenticate } from "@splash/auth";
import { jsonError } from "@splash/http";
import { requireServiceKey } from "./admin/auth.js";
import type { Env } from "./index.js";

interface VisibleForm {
  slug: string;
  title: string;
  description: string | null;
  audience: "public" | "internal" | "link-only";
}

interface FormsRow {
  slug: string;
  title: string;
  description: string | null;
  audience: "public" | "internal" | "link-only";
}

export async function handleVisibleToMe(
  env: Env,
  req: Request
): Promise<Response> {
  const sk = requireServiceKey(env);
  if (sk) return sk;

  const auth = await authenticate(req, env);
  if (auth.status !== "authenticated") {
    return jsonError(401, "unauthorized");
  }

  // v1: published + internal only. Option 3 adds a visibility filter here.
  const url = new URL("/rest/v1/forms", env.SUPABASE_URL);
  url.searchParams.set("status", "eq.published");
  url.searchParams.set("audience", "eq.internal");
  url.searchParams.set("select", "slug,title,description,audience");
  url.searchParams.set("order", "title.asc");
  url.searchParams.set("limit", "500");

  const resp = await fetch(url.toString(), {
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`
    }
  });
  if (!resp.ok) {
    console.error("[forms.visible-to-me] supabase fetch failed", resp.status);
    return jsonError(500, "list_failed");
  }

  const rows = (await resp.json().catch(() => [])) as FormsRow[];
  const forms: VisibleForm[] = rows.map((r) => ({
    slug: r.slug,
    title: r.title,
    description: r.description,
    audience: r.audience
  }));

  return new Response(JSON.stringify({ forms }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}
