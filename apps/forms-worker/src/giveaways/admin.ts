// Giveaways -- signed-in API behind /admin/giveaways.
//
//   GET    /forms/admin/api/giveaways                         list + counts
//   POST   /forms/admin/api/giveaways                         create  {settings}
//   GET    /forms/admin/api/giveaways/{id}                    one giveaway + its entries
//   PATCH  /forms/admin/api/giveaways/{id}                    {settings?, archived?, new_link?}
//   DELETE /forms/admin/api/giveaways/{id}/entries/{entryId}  remove one entry (e.g. a test)
//
// WHO: admin tier, or anyone holding the `giveaways` form access grant
// (Sysadmin -> the user -> Access). Everything here -- including reading
// entries, which carry customers' names, phones and emails -- needs one of
// the two; nobody else gets past the gate.

import { isOriginAllowed } from "@splash/http";
import type { Session } from "@splash/auth";
import { parseGiveawaySettings } from "@splash/forms-schema";
import type { Env } from "../index.js";
import { authenticate } from "../admin/auth.js";
import {
  createGiveaway,
  deleteEntry,
  easternToday,
  entryCounts,
  getGiveaway,
  giveawayState,
  listEntries,
  listGiveaways,
  newToken,
  patchGiveaway,
  type Giveaway
} from "./data.js";

export const GIVEAWAYS_ACCESS_TAG = "giveaways";
const PREFIX = "/forms/admin/api/giveaways";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}

function isAdminTier(s: Session): boolean {
  return s.role === "super_admin" || s.dcRole === "admin" || s.dcRole === "super_admin";
}

async function hasGrant(env: Env, userId: string): Promise<boolean> {
  const url = new URL("/rest/v1/form_access_grants", env.SUPABASE_URL);
  url.searchParams.set("select", "tag");
  url.searchParams.set("user_id", `eq.${userId}`);
  url.searchParams.set("tag", `eq.${GIVEAWAYS_ACCESS_TAG}`);
  url.searchParams.set("limit", "1");
  const resp = await fetch(url.toString(), {
    headers: { apikey: env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}` }
  });
  if (!resp.ok) throw new Error(`[giveaways] grant read ${resp.status}`);
  return ((await resp.json()) as unknown[]).length > 0;
}

function linkPath(g: Giveaway): string {
  return `/forms/giveaway/${g.token}`;
}

function summary(g: Giveaway, today: string) {
  return { ...g, link_path: linkPath(g), state: giveawayState(g, today) };
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const b = await req.json();
    return b && typeof b === "object" ? (b as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export async function handleGiveawaysAdmin(env: Env, req: Request, url: URL): Promise<Response | null> {
  if (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`)) return null;
  const path = url.pathname.slice(PREFIX.length) || "/";

  if (!env.SUPABASE_SERVICE_KEY) return json(503, { error: "service_key_unbound" });
  const auth = await authenticate(req, env);
  if (auth.status !== "authenticated") return json(401, { error: "Sign in to manage giveaways." });
  const session = auth.session;
  const me = (session.email ?? "").toLowerCase();

  try {
    const allowed = isAdminTier(session) || (!!session.userId && (await hasGrant(env, session.userId)));
    if (!allowed) return json(403, { error: "Giveaways are set up by admins and people given Giveaways access." });

    if (req.method !== "GET" && !isOriginAllowed(req)) {
      return json(403, { error: "Couldn't verify the page. Reload and try again." });
    }
    const today = easternToday();

    if (path === "/") {
      if (req.method === "GET") {
        const all = await listGiveaways(env);
        const counts = await Promise.all(all.map((g) => entryCounts(env, g.id)));
        return json(200, {
          today,
          giveaways: all.map((g, i) => ({ ...summary(g, today), entry_count: counts[i]!.entries, sms_count: counts[i]!.sms }))
        });
      }
      if (req.method === "POST") {
        const parsed = parseGiveawaySettings(await readBody(req));
        if (!parsed.ok) return json(400, { error: parsed.error });
        const g = await createGiveaway(env, parsed.value, me);
        return json(200, { ok: true, id: g.id });
      }
      return json(405, { error: "method_not_allowed" });
    }

    const entryMatch = path.match(/^\/([0-9a-f-]{36})\/entries\/([0-9a-f-]{36})$/i);
    if (entryMatch && req.method === "DELETE") {
      const removed = await deleteEntry(env, entryMatch[1]!, entryMatch[2]!);
      return removed ? json(200, { ok: true }) : json(404, { error: "That entry is already gone." });
    }

    const idMatch = path.match(/^\/([0-9a-f-]{36})$/i);
    if (!idMatch) return json(404, { error: "no_such_endpoint" });
    const g = await getGiveaway(env, idMatch[1]!);
    if (!g) return json(404, { error: "That giveaway no longer exists." });

    if (req.method === "GET") {
      const [counts, list] = await Promise.all([entryCounts(env, g.id), listEntries(env, g.id)]);
      return json(200, {
        today,
        giveaway: { ...summary(g, today), entry_count: counts.entries, sms_count: counts.sms },
        entries: list.entries,
        entries_capped: list.capped
      });
    }

    if (req.method === "PATCH") {
      const body = await readBody(req);
      const patch: Record<string, unknown> = {};
      if (body.settings !== undefined) {
        const parsed = parseGiveawaySettings(body.settings);
        if (!parsed.ok) return json(400, { error: parsed.error });
        Object.assign(patch, parsed.value);
      }
      if (typeof body.archived === "boolean") patch.archived_at = body.archived ? new Date().toISOString() : null;
      // A new link kills every copy of the old one (e.g. a QR that got out).
      if (body.new_link === true) patch.token = newToken();
      if (Object.keys(patch).length === 0) return json(400, { error: "Nothing to change." });
      await patchGiveaway(env, g.id, patch, me);
      return json(200, { ok: true });
    }

    return json(405, { error: "method_not_allowed" });
  } catch (err) {
    console.error("[giveaways] admin failed", err);
    return json(500, { error: "Something went wrong. Try again." });
  }
}
