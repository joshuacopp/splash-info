// Daily damage-claim changes email (2026-10-29).
//
// One email a day to INCIDENTS_EMAIL listing every claim that changed in the
// 24 hours before the cron fired: new claims, status changes, notes, and
// documents added/removed. Source is the D1 `claim_activity` log alone -- a
// new claim is the status_change row with status_from NULL written at submit.
//
// WINDOW comes from controller.scheduledTime, not Date.now(), so a cron that
// starts a few seconds late neither drops nor double-counts the boundary row.
// Bounds are [end - 24h, end); claim_activity.created_at is SQLite
// datetime('now') text in UTC ("YYYY-MM-DD HH:MM:SS"), which compares
// correctly as a string against the same format.
//
// QUIET DAYS SEND NOTHING (operator 2026-10-29). A missing email therefore
// means either no changes or a failed run; Workers Logs carries
// `[daily-changes]` lines for both.
//
// Delivery is the shared outbound_emails queue (Brief 127), keyed
// source_id = the ET date of the window's end, so a re-fired cron for the
// same day is a no-op at the dedup index. Transport follows
// outbound_email_routes for source_kind 'damage-daily-changes' (PA when no
// route row exists).

import { enqueueOutboundEmail, type SupabaseEnv } from "@splash/db-supabase";
import { escapeAttr, escapeHtml, wrapInEmailShell } from "@splash/email-shell";

export interface DailyChangesEnv extends SupabaseEnv {
  DB: D1Database;
  INCIDENTS_EMAIL?: string;
  APPS_WEB_BASE_URL?: string;
}

export interface ActivityJoinRow {
  id: number;
  claim_id: string;
  activity_type: string;
  status_from: string | null;
  status_to: string | null;
  notes: string | null;
  actor_email: string | null;
  actor_name: string | null;
  created_at: string;
  location_pretty: string | null;
  customer_name: string | null;
  claim_status: string | null;
}

interface ClaimGroup {
  claimId: string;
  locationPretty: string;
  customerName: string;
  currentStatus: string;
  isNew: boolean;
  events: ActivityJoinRow[];
}

const WINDOW_MS = 24 * 60 * 60 * 1000;
const NOTE_MAX_CHARS = 500;
const ET = "America/New_York";

export async function runDailyChangesEmail(
  env: DailyChangesEnv,
  scheduledTime: number
): Promise<void> {
  const recipient = (env.INCIDENTS_EMAIL ?? "").trim();
  if (!recipient) {
    console.warn("[daily-changes] INCIDENTS_EMAIL unset — skipping");
    return;
  }

  const end = new Date(Math.floor(scheduledTime / 60000) * 60000);
  const start = new Date(end.getTime() - WINDOW_MS);

  const { results } = await env.DB
    .prepare(
      `SELECT a.id, a.claim_id, a.activity_type, a.status_from, a.status_to,
              a.notes, a.actor_email, a.actor_name, a.created_at,
              c.location_pretty, c.customer_name, c.claim_status
         FROM claim_activity a
         JOIN claims c ON c.claim_id = a.claim_id
        WHERE a.created_at >= ? AND a.created_at < ?
          AND c.deleted_at IS NULL
        ORDER BY a.created_at, a.id`
    )
    .bind(toSqliteUtc(start), toSqliteUtc(end))
    .all<ActivityJoinRow>();

  const rows = results ?? [];
  if (rows.length === 0) {
    console.log("[daily-changes] no changes in window — not sending", {
      from: start.toISOString(),
      to: end.toISOString()
    });
    return;
  }

  const groups = groupByClaim(rows);
  const reportDate = etDate(end);
  const adminBase = (env.APPS_WEB_BASE_URL ?? "https://splashcarwashes.info").replace(/\/$/, "");
  const email = buildDailyChangesEmail(rows, start, end, adminBase);

  const result = await enqueueOutboundEmail(env, {
    source_worker: "damage-worker",
    source_kind: "damage-daily-changes",
    source_id: reportDate,
    recipient,
    subject: email.subject,
    body_html: email.html,
    body_text: email.text
  });

  console.log("[daily-changes] enqueued", {
    reportDate,
    claims: groups.length,
    events: rows.length,
    result
  });
}

/** Pure render from activity rows; exported for previewing without D1/Supabase. */
export function buildDailyChangesEmail(
  rows: ActivityJoinRow[],
  start: Date,
  end: Date,
  adminBase: string
): { subject: string; html: string; text: string } {
  return renderDailyChanges(groupByClaim(rows), start, end, adminBase);
}

function groupByClaim(rows: ActivityJoinRow[]): ClaimGroup[] {
  const byId = new Map<string, ClaimGroup>();
  for (const r of rows) {
    let g = byId.get(r.claim_id);
    if (!g) {
      g = {
        claimId: r.claim_id,
        locationPretty: r.location_pretty || "Unknown location",
        customerName: r.customer_name || "Unknown customer",
        currentStatus: r.claim_status || "",
        isNew: false,
        events: []
      };
      byId.set(r.claim_id, g);
    }
    if (isNewClaimEvent(r)) g.isNew = true;
    g.events.push(r);
  }
  // New claims first, then by location, then customer.
  return [...byId.values()].sort(
    (a, b) =>
      Number(b.isNew) - Number(a.isNew) ||
      a.locationPretty.localeCompare(b.locationPretty) ||
      a.customerName.localeCompare(b.customerName)
  );
}

function isNewClaimEvent(r: ActivityJoinRow): boolean {
  return r.activity_type === "status_change" && r.status_from === null;
}

/** One-line description of an event, plain text (caller escapes for HTML). */
function describeEvent(r: ActivityJoinRow): { headline: string; detail: string | null } {
  const note = r.notes ? truncate(r.notes.trim(), NOTE_MAX_CHARS) : null;
  switch (r.activity_type) {
    case "status_change":
      if (r.status_from === null) {
        return { headline: `New claim submitted (${r.status_to ?? "no status"})`, detail: note };
      }
      return {
        headline: `Status: ${r.status_from} → ${r.status_to ?? "?"}`,
        detail: note
      };
    case "note":
      return { headline: "Note added", detail: note };
    case "document_added":
      return { headline: "Document added", detail: note };
    case "document_removed":
      return { headline: "Document removed", detail: note };
    default:
      return { headline: r.activity_type.replace(/_/g, " "), detail: note };
  }
}

function actorLabel(r: ActivityJoinRow): string {
  const name = (r.actor_name ?? "").trim();
  const email = (r.actor_email ?? "").trim();
  // actor_name is frequently the email itself; don't print it twice.
  if (name && name !== "Unknown" && email && name.toLowerCase() !== email.toLowerCase()) {
    return `${name} (${email})`;
  }
  return email || name || "Unknown";
}

function renderDailyChanges(
  groups: ClaimGroup[],
  start: Date,
  end: Date,
  adminBase: string
): { subject: string; html: string; text: string } {
  const newCount = groups.filter((g) => g.isNew).length;
  const eventCount = groups.reduce((n, g) => n + g.events.length, 0);
  const windowLabel = `${etDateTime(start)} – ${etDateTime(end)} ET`;
  const claimWord = groups.length === 1 ? "claim" : "claims";
  const subject =
    `Damage claims: ${groups.length} ${claimWord} changed` +
    (newCount > 0 ? `, ${newCount} new` : "") +
    ` (${etShortDate(end)})`;

  const htmlParts: string[] = [];
  const textParts: string[] = [];

  htmlParts.push(
    `<h2 style="margin: 0 0 8px 0; font-size: 20px; color: #0E2745;">Damage claim changes</h2>`,
    `<p style="margin: 0 0 20px 0; font-size: 14px; color: #6B7280;">${escapeHtml(windowLabel)}<br />` +
      `${groups.length} ${claimWord}, ${newCount} new, ${eventCount} ${eventCount === 1 ? "change" : "changes"}</p>`
  );
  textParts.push(
    "Damage claim changes",
    windowLabel,
    `${groups.length} ${claimWord}, ${newCount} new, ${eventCount} ${eventCount === 1 ? "change" : "changes"}`,
    ""
  );

  for (const g of groups) {
    const url = `${adminBase}/admin/damage/${encodeURIComponent(g.claimId)}`;
    const badge = g.isNew
      ? ` <span style="display: inline-block; padding: 1px 8px; border-radius: 9999px; background: #DCFCE7; color: #166534; font-size: 11px; font-weight: 600; vertical-align: middle;">NEW</span>`
      : "";

    htmlParts.push(
      `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin: 0 0 16px 0; border: 1px solid #E5E7EB; border-radius: 6px;">`,
      `<tr><td style="padding: 12px 14px; background: #F9FAFB; border-bottom: 1px solid #E5E7EB;">`,
      `<div style="font-size: 15px; font-weight: 600; color: #0E2745;">${escapeHtml(g.locationPretty)} — ${escapeHtml(g.customerName)}${badge}</div>`,
      `<div style="font-size: 12px; color: #6B7280; margin-top: 2px;">Claim ${escapeHtml(g.claimId)}` +
        (g.currentStatus ? ` · Now: ${escapeHtml(g.currentStatus)}` : "") +
        ` · <a href="${escapeAttr(url)}" style="color: #1D7FC1;">Open claim</a></div>`,
      `</td></tr>`,
      `<tr><td style="padding: 8px 14px;">`
    );
    textParts.push(
      `${g.locationPretty} — ${g.customerName}${g.isNew ? " [NEW]" : ""}`,
      `Claim ${g.claimId}${g.currentStatus ? ` · Now: ${g.currentStatus}` : ""}`,
      url
    );

    for (const ev of g.events) {
      const { headline, detail } = describeEvent(ev);
      const when = etTime(parseSqliteUtc(ev.created_at));
      const who = actorLabel(ev);
      htmlParts.push(
        `<div style="padding: 6px 0; font-size: 14px; color: #111827;">`,
        `<div><strong>${escapeHtml(headline)}</strong></div>`,
        `<div style="font-size: 12px; color: #6B7280;">${escapeHtml(when)} · ${escapeHtml(who)}</div>`,
        detail
          ? `<div style="margin-top: 4px; font-size: 13px; color: #374151; white-space: pre-wrap;">${escapeHtml(detail)}</div>`
          : "",
        `</div>`
      );
      textParts.push(`  - ${when} · ${headline} · ${who}`);
      if (detail) textParts.push(`      ${detail.replace(/\n/g, "\n      ")}`);
    }

    htmlParts.push(`</td></tr></table>`);
    textParts.push("");
  }

  const html = wrapInEmailShell(htmlParts.join("\n"), {
    title: "Damage claim changes",
    preheader: `${groups.length} ${claimWord} changed, ${newCount} new`
  });
  return { subject, html, text: textParts.join("\n") };
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** Date → "YYYY-MM-DD HH:MM:SS" (UTC), matching SQLite datetime('now'). */
function toSqliteUtc(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

function parseSqliteUtc(s: string): Date {
  return new Date(`${s.replace(" ", "T")}Z`);
}

/** ET calendar date as YYYY-MM-DD (en-CA formats ISO-style). */
function etDate(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: ET,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(d);
}

function etShortDate(d: Date): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: ET, month: "short", day: "numeric" }).format(d);
}

function etDateTime(d: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: ET,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(d);
}

function etTime(d: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: ET,
    weekday: "short",
    hour: "numeric",
    minute: "2-digit"
  }).format(d);
}
