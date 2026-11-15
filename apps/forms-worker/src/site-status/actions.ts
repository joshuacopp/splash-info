// Site status -- the state changes, shared by the board API (signed in), the
// company-wide reopen link and the emailed "extend / mark open" link. Every
// path goes through these functions so they cannot drift on rules or emails.
//
// Writes are compare-and-sets: reopening only matches a closure that is still
// open, so two people tapping "open" at once yields one reopen and one
// "already open" message, never two reopen emails.

import type { Env } from "../index.js";
import {
  REASONS,
  getSettings,
  getSite,
  insertClosure,
  insertClosureLink,
  insertDownItem,
  listOpenClosures,
  patchClosure,
  clearDownItem,
  type Closure,
  type EstimateChange,
  type Reason,
  type SiteInfo
} from "./data.js";
import { APP_BASE, reopenLinkUrl, sendBroadcast, sendOverdue } from "./emails.js";

export type Result<T = Closure> = { ok: true; value: T } | { ok: false; status: number; error: string };

const MAX_ESTIMATE_MS = 30 * 24 * 60 * 60 * 1000;

function fail(status: number, error: string): { ok: false; status: number; error: string } {
  return { ok: false, status, error };
}

function cleanText(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim().replace(/\s+/g, " ");
  return t ? t.slice(0, max) : null;
}

/**
 * Work out an estimated reopen time from either `minutes` (from now) or an
 * explicit `reopen_at` ISO time. Must be in the future and within 30 days.
 */
export function parseEstimate(body: Record<string, unknown>, now = new Date()): Date | string {
  let at: Date | null = null;
  if (typeof body.minutes === "number" || (typeof body.minutes === "string" && body.minutes !== "")) {
    const m = Number(body.minutes);
    if (!Number.isFinite(m) || m < 5) return "Pick how long the site will be closed.";
    at = new Date(now.getTime() + Math.round(m) * 60000);
  } else if (typeof body.reopen_at === "string" && body.reopen_at) {
    at = new Date(body.reopen_at);
    if (Number.isNaN(at.getTime())) return "That reopen time isn't a valid date and time.";
  } else {
    return "Say when the site is expected to reopen.";
  }
  if (at.getTime() <= now.getTime()) return "The expected reopen time has to be in the future.";
  if (at.getTime() - now.getTime() > MAX_ESTIMATE_MS) return "The expected reopen time can't be more than 30 days out.";
  return at;
}

async function testTo(env: Env): Promise<string | null> {
  const s = await getSettings(env);
  return s?.test_email_to?.trim() || null;
}

// ---- close ---------------------------------------------------------------------

export async function closeSite(
  env: Env,
  args: { site: SiteInfo; reason: unknown; reasonDetail: unknown; estimate: Date; by: string }
): Promise<Result> {
  const reason = typeof args.reason === "string" && (REASONS as readonly string[]).includes(args.reason) ? (args.reason as Reason) : null;
  if (!reason) return fail(400, "Pick a reason for the closure.");
  const detail = cleanText(args.reasonDetail, 1000);
  if (reason === "other" && !detail) return fail(400, "Say what the reason is.");

  const now = new Date().toISOString();
  const est = args.estimate.toISOString();
  const inserted = await insertClosure(env, {
    site_number: args.site.site_number,
    site_name: args.site.site,
    rd_name: args.site.rd_name,
    rd_email: args.site.rd_email,
    rm_name: args.site.rm_name,
    rm_email: args.site.rm_email,
    reason,
    reason_detail: detail,
    closed_at: now,
    closed_by: args.by,
    original_est_reopen_at: est,
    est_reopen_at: est
  });
  if (!inserted.ok) {
    return inserted.alreadyClosed
      ? fail(409, `${args.site.site} is already marked closed.`)
      : fail(500, "Couldn't save the closure. Try again.");
  }
  const settings = await getSettings(env);
  await sendBroadcast(env, "closed", inserted.closure, args.site, {
    testTo: settings?.test_email_to?.trim() || null,
    reopenUrl: settings ? reopenLinkUrl(settings.open_token, args.site.site_number) : null,
    eventKey: "closed"
  });
  return { ok: true, value: inserted.closure };
}

// ---- reopen --------------------------------------------------------------------

export async function reopenClosure(
  env: Env,
  closure: Closure,
  args: { by: string; via: "board" | "link" | "email_link"; note?: unknown }
): Promise<Result> {
  if (closure.reopened_at) return fail(409, `${closure.site_name} is already open.`);
  const updated = await patchClosure(
    env,
    closure.id,
    {
      reopened_at: new Date().toISOString(),
      reopened_by: args.by,
      reopened_via: args.via,
      reopen_note: cleanText(args.note, 1000)
    },
    { reopened_at: "is.null" }
  );
  if (!updated) return fail(409, `${closure.site_name} is already open.`);
  const site = await getSite(env, closure.site_number).catch(() => null);
  if (site) {
    await sendBroadcast(env, "reopened", updated, site, { testTo: await testTo(env), eventKey: "reopened" });
  }
  return { ok: true, value: updated };
}

// ---- change estimate -------------------------------------------------------------

export async function changeEstimate(
  env: Env,
  closure: Closure,
  args: { estimate: Date; by: string; note?: unknown }
): Promise<Result> {
  if (closure.reopened_at) return fail(409, `${closure.site_name} is already open.`);
  const note = cleanText(args.note, 500);
  const change: EstimateChange = {
    at: new Date().toISOString(),
    by: args.by,
    from: closure.est_reopen_at,
    to: args.estimate.toISOString(),
    note
  };
  const updated = await patchClosure(
    env,
    closure.id,
    { est_reopen_at: change.to, estimate_changes: [...(closure.estimate_changes ?? []), change] },
    // Compare-and-set on the estimate we read, so two edits don't lose one.
    { reopened_at: "is.null", est_reopen_at: `eq.${closure.est_reopen_at}` }
  );
  if (!updated) return fail(409, "Someone else just changed this closure. Reload and try again.");
  const site = await getSite(env, closure.site_number).catch(() => null);
  if (site) {
    await sendBroadcast(env, "estimate", updated, site, {
      testTo: await testTo(env),
      estimateNote: note,
      eventKey: `estimate:${updated.estimate_changes.length}`
    });
  }
  return { ok: true, value: updated };
}

// ---- equipment down (partial outage) ------------------------------------------------

export const DOWN_ITEM_SUGGESTIONS = [
  "Vacuums",
  "Tunnel / conveyor",
  "Pay station",
  "Dryers",
  "Tire shine",
  "Express lane",
  "Credit cards"
];

export async function reportDownItem(
  env: Env,
  args: { siteNumber: number; item: unknown; note: unknown; by: string; via: "board" | "link" }
): Promise<Result<unknown>> {
  const item = cleanText(args.item, 80);
  if (!item) return fail(400, "Say what is down.");
  const row = await insertDownItem(env, {
    site_number: args.siteNumber,
    item,
    note: cleanText(args.note, 500),
    reported_by: args.by,
    reported_via: args.via
  });
  return row ? { ok: true, value: row } : fail(500, "Couldn't save that. Try again.");
}

export async function clearDown(env: Env, id: string, by: string, via: "board" | "link"): Promise<Result<unknown>> {
  return (await clearDownItem(env, id, by, via))
    ? { ok: true, value: null }
    : fail(409, "That item was already cleared.");
}

// ---- emailed manage links ------------------------------------------------------------

const LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function mintManageLink(env: Env, closureId: string, recipient: string): Promise<string | null> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const token = base64url(bytes);
  const ok = await insertClosureLink(env, {
    closure_id: closureId,
    token_hash: await sha256Hex(token),
    recipient,
    expires_at: new Date(Date.now() + LINK_TTL_MS).toISOString()
  });
  return ok ? `${APP_BASE}/forms/site-status/manage/${token}` : null;
}

// ---- overdue cron --------------------------------------------------------------------

/**
 * Every open closure past its estimate gets ONE overdue email per estimate.
 * The send is claimed by compare-and-set on overdue_notified_for, so
 * overlapping cron ticks cannot double-mail; extending moves est_reopen_at
 * and the next pass past the new time mails again.
 */
export async function runOverdueCheck(env: Env, now = new Date()): Promise<{ sent: number }> {
  const open = await listOpenClosures(env);
  const due = open.filter(
    (c) => new Date(c.est_reopen_at).getTime() <= now.getTime() && c.overdue_notified_for !== c.est_reopen_at
  );
  if (due.length === 0) return { sent: 0 };
  const settings = await getSettings(env);
  const test = settings?.test_email_to?.trim() || null;
  let sent = 0;
  for (const c of due) {
    const claimed = await patchClosure(
      env,
      c.id,
      { overdue_notified_for: c.est_reopen_at },
      {
        reopened_at: "is.null",
        est_reopen_at: `eq.${c.est_reopen_at}`,
        or: `(overdue_notified_for.is.null,overdue_notified_for.neq.${c.est_reopen_at})`
      }
    );
    if (!claimed) continue;
    const site = await getSite(env, c.site_number).catch(() => null);
    sent += await sendOverdue(env, claimed, site, {
      testTo: test,
      mintLink: (r) => mintManageLink(env, c.id, r)
    });
  }
  return { sent };
}
