// GET /forms/api/visible-to-me — credentialed-user index endpoint (Brief 99).
//
// Returns the list of forms the calling session can see in their /forms
// index page on apps/web: published internal-audience forms the caller may
// fill out per `forms.fill_audience` (2026-10-30, see fill-audience.ts). The
// render and submit paths apply the same rule, so hiding a form here is not
// the only thing keeping it closed.
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
import {
  anyRestricted,
  canFillForm,
  normalizeFillAudience,
  resolveFillCaller,
  type FillRule
} from "./fill-audience.js";
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
  fill_audience: unknown;
  access_tag: string | null;
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

  // Published + internal, then narrowed by fill_audience below.
  const url = new URL("/rest/v1/forms", env.SUPABASE_URL);
  url.searchParams.set("status", "eq.published");
  url.searchParams.set("audience", "eq.internal");
  url.searchParams.set("select", "slug,title,description,audience,fill_audience,access_tag");
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

  const all = (await resp.json().catch(() => [])) as FormsRow[];
  const rules = new Map<FormsRow, FillRule>(
    all.map((r) => [
      r,
      { fillAudience: normalizeFillAudience(r.fill_audience), accessTag: r.access_tag ?? null }
    ])
  );
  // The caller lookup is two reads; skip it while no form is restricted.
  let rows = all;
  if (anyRestricted([...rules.values()])) {
    const caller = await resolveFillCaller(env, auth.session);
    rows = all.filter((r) => canFillForm(rules.get(r)!, caller));
  }
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
