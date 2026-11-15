// Site status -- signed-in API behind /admin/site-status.
//
//   GET  /forms/admin/api/site-status/board
//   POST /forms/admin/api/site-status/close                  {site_number, reason, reason_detail?, minutes | reopen_at}
//   POST /forms/admin/api/site-status/closures/{id}/reopen   {note?}
//   POST /forms/admin/api/site-status/closures/{id}/estimate {minutes | reopen_at, note?}
//   POST /forms/admin/api/site-status/down-items             {site_number, item, note?}
//   POST /forms/admin/api/site-status/down-items/{id}/clear
//   POST /forms/admin/api/site-status/settings               {rotate_link?, test_email_to?}   admin tier
//   GET  /forms/admin/api/site-status/report?from_iso=&to_iso=
//
// WHO: anyone signed in may READ the board and reports. Closing, reopening from
// the board, changing an estimate and logging equipment down need the site's
// RD (am_email) or RM (rm_email) -- operator 2026-11-15 -- or admin tier as the
// escape hatch. Reopening WITHOUT signing in is the company-wide link
// (public.ts), by design.

import { isOriginAllowed } from "@splash/http";
import type { Session } from "@splash/auth";
import type { Env } from "../index.js";
import { authenticate } from "../admin/auth.js";
import {
  REASONS,
  REASON_LABEL,
  getClosure,
  getDownItem,
  getSettings,
  lastClosureBySite,
  listClosuresBetween,
  listOpenClosures,
  listOpenDownItems,
  listSites,
  patchSettings,
  type SiteInfo
} from "./data.js";
import { reopenLinkUrl } from "./emails.js";
import {
  DOWN_ITEM_SUGGESTIONS,
  changeEstimate,
  clearDown,
  closeSite,
  parseEstimate,
  reopenClosure,
  reportDownItem,
  type Result
} from "./actions.js";

const PREFIX = "/forms/admin/api/site-status";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}

function isAdminTier(s: Session): boolean {
  return s.role === "super_admin" || s.dcRole === "admin" || s.dcRole === "super_admin";
}

function canManage(s: Session, site: SiteInfo): boolean {
  if (isAdminTier(s)) return true;
  const me = (s.email ?? "").toLowerCase();
  return !!me && (me === site.rd_email || me === site.rm_email);
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const b = await req.json();
    return b && typeof b === "object" ? (b as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function fromResult(r: Result<unknown>): Response {
  return r.ok ? json(200, { ok: true }) : json(r.status, { error: r.error });
}

export async function handleSiteStatusAdmin(env: Env, req: Request, url: URL): Promise<Response | null> {
  if (!url.pathname.startsWith(PREFIX)) return null;
  const path = url.pathname.slice(PREFIX.length) || "/";

  if (!env.SUPABASE_SERVICE_KEY) return json(503, { error: "service_key_unbound" });
  const auth = await authenticate(req, env);
  if (auth.status !== "authenticated") return json(401, { error: "Sign in to use the site status board." });
  const session = auth.session;
  const me = (session.email ?? "").toLowerCase();

  if (req.method === "GET") {
    if (path === "/board") return board(env, session);
    if (path === "/report") return report(env, url);
    return json(404, { error: "no_such_endpoint" });
  }

  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });
  if (!isOriginAllowed(req)) return json(403, { error: "Couldn't verify the page. Reload and try again." });
  const body = await readBody(req);

  if (path === "/close") {
    const siteNumber = Number(body.site_number);
    const sites = await listSites(env);
    const site = sites.find((s) => s.site_number === siteNumber);
    if (!site) return json(400, { error: "Pick a site." });
    if (!canManage(session, site)) {
      return json(403, { error: `Only ${site.site}'s RD or RM can close it.` });
    }
    const est = parseEstimate(body);
    if (typeof est === "string") return json(400, { error: est });
    return fromResult(await closeSite(env, { site, reason: body.reason, reasonDetail: body.reason_detail, estimate: est, by: me }));
  }

  const closureMatch = path.match(/^\/closures\/([0-9a-f-]{36})\/(reopen|estimate)$/i);
  if (closureMatch && closureMatch[1] && closureMatch[2]) {
    const closure = await getClosure(env, closureMatch[1]);
    if (!closure) return json(404, { error: "That closure no longer exists." });
    const site = (await listSites(env)).find((s) => s.site_number === closure.site_number);
    if (!site || !canManage(session, site)) {
      return json(403, { error: `Only ${closure.site_name}'s RD or RM can change this closure here.` });
    }
    if (closureMatch[2] === "reopen") {
      return fromResult(await reopenClosure(env, closure, { by: me, via: "board", note: body.note }));
    }
    const est = parseEstimate(body);
    if (typeof est === "string") return json(400, { error: est });
    return fromResult(await changeEstimate(env, closure, { estimate: est, by: me, note: body.note }));
  }

  if (path === "/down-items") {
    const siteNumber = Number(body.site_number);
    const site = (await listSites(env)).find((s) => s.site_number === siteNumber);
    if (!site) return json(400, { error: "Pick a site." });
    if (!canManage(session, site)) return json(403, { error: `Only ${site.site}'s RD or RM can do that here.` });
    return fromResult(await reportDownItem(env, { siteNumber, item: body.item, note: body.note, by: me, via: "board" }));
  }

  const clearMatch = path.match(/^\/down-items\/([0-9a-f-]{36})\/clear$/i);
  if (clearMatch && clearMatch[1]) {
    const item = await getDownItem(env, clearMatch[1]);
    if (!item) return json(409, { error: "That item was already cleared." });
    const site = (await listSites(env)).find((s) => s.site_number === item.site_number);
    if (!site || !canManage(session, site)) return json(403, { error: "Only the site's RD or RM can do that here." });
    return fromResult(await clearDown(env, item.id, me, "board"));
  }

  if (path === "/settings") {
    if (!isAdminTier(session)) return json(403, { error: "Admins only." });
    const patch: Record<string, unknown> = { updated_by: me };
    if (body.rotate_link === true) {
      const bytes = new Uint8Array(24);
      crypto.getRandomValues(bytes);
      patch.open_token = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
    }
    if ("test_email_to" in body) {
      const v = typeof body.test_email_to === "string" ? body.test_email_to.trim().toLowerCase() : "";
      if (v && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) return json(400, { error: "That isn't an email address." });
      patch.test_email_to = v || null;
    }
    const saved = await patchSettings(env, patch);
    return saved ? json(200, { ok: true }) : json(500, { error: "Couldn't save settings." });
  }

  return json(404, { error: "no_such_endpoint" });
}

async function board(env: Env, session: Session): Promise<Response> {
  const [sites, open, last, down, settings] = await Promise.all([
    listSites(env),
    listOpenClosures(env),
    lastClosureBySite(env),
    listOpenDownItems(env),
    getSettings(env)
  ]);
  const openBySite = new Map(open.map((c) => [c.site_number, c]));
  const downBySite = new Map<number, typeof down>();
  for (const d of down) {
    const list = downBySite.get(d.site_number) ?? [];
    list.push(d);
    downBySite.set(d.site_number, list);
  }

  const rows = sites.map((s) => {
    const closure = openBySite.get(s.site_number) ?? null;
    const prev = last.get(s.site_number) ?? null;
    return {
      site_number: s.site_number,
      site: s.site,
      rd_name: s.rd_name,
      rd_email: s.rd_email,
      rm_name: s.rm_name,
      rm_email: s.rm_email,
      can_manage: canManage(session, s),
      closure,
      last_closure: prev
        ? {
            closed_at: prev.closed_at,
            reopened_at: prev.reopened_at,
            reason: prev.reason,
            reason_detail: prev.reason_detail,
            closed_by: prev.closed_by
          }
        : null,
      down_items: downBySite.get(s.site_number) ?? []
    };
  });

  // Closed first (longest closed at the top), then sites with something down,
  // then everyone else by site number.
  rows.sort((a, b) => {
    if (!!a.closure !== !!b.closure) return a.closure ? -1 : 1;
    if (a.closure && b.closure) return a.closure.closed_at.localeCompare(b.closure.closed_at);
    const ad = a.down_items.length > 0;
    const bd = b.down_items.length > 0;
    if (ad !== bd) return ad ? -1 : 1;
    return a.site_number - b.site_number;
  });

  const canCloseAny = rows.some((r) => r.can_manage);
  const admin = isAdminTier(session);
  return json(200, {
    now: new Date().toISOString(),
    sites: rows,
    reasons: REASONS.map((r) => ({ value: r, label: REASON_LABEL[r] })),
    down_item_suggestions: DOWN_ITEM_SUGGESTIONS,
    can_close_any: canCloseAny,
    is_admin: admin,
    // The reopen link is shared with the sites by the people who run them.
    open_link: (canCloseAny || admin) && settings ? reopenLinkUrl(settings.open_token) : null,
    test_email_to: canCloseAny || admin ? settings?.test_email_to ?? null : null
  });
}

async function report(env: Env, url: URL): Promise<Response> {
  const from = url.searchParams.get("from_iso") ?? "";
  const to = url.searchParams.get("to_iso") ?? "";
  if (Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) {
    return json(400, { error: "from_iso and to_iso are required" });
  }
  const [closures, sites] = await Promise.all([listClosuresBetween(env, from, to), listSites(env)]);
  return json(200, {
    now: new Date().toISOString(),
    closures,
    sites: sites.map((s) => ({ site_number: s.site_number, site: s.site, rd_name: s.rd_name, rm_name: s.rm_name }))
  });
}
