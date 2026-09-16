// Ingest health check: say out loud when a sync pass has stopped working.
//
// WHY THIS EXISTS
//
//   On 2026-09-16 work_orders_live was found sitting on one cursor with
//   last_success_at NULL since the day the mirror went live, failing the same
//   error every five minutes. It had also silently disabled the daily
//   reconciliation, because mx-reconcile.ts declines while the live pass is
//   mid-cursor -- so the one mechanism whose whole job is finding rows nothing
//   else can see had been off for days.
//
//   Every fact needed to notice was already in mx_sync_state. Nothing read it.
//   The failure was not that a pass broke; passes break. The failure was that
//   a pass could break and stay broken indefinitely without anyone being told.
//
//   So this is deliberately not clever. It reads the table every morning and
//   emails when something in it looks wrong.
//
// WHY THE RULES ARE NARROW
//
//   An alert that fires on healthy states gets ignored, and an ignored alert is
//   worse than none because it also convinces people something is watching.
//
//   In particular, staleness alone is NOT a fault here. work_orders_history and
//   work_requests_full complete once and are then never run again -- the
//   dispatcher switches to the incremental sweep permanently -- so their
//   last_success_at is legitimately days or weeks old. A blanket "not succeeded
//   in 24h" rule would flag both of them forever, every morning.
//
//   The three rules below all describe a pass that is actively trying and
//   actively not working.

import { enqueueOutboundEmail } from "@splash/db-supabase";
import type { SupabaseEnv } from "@splash/db-supabase";
import { wrapInEmailShell, escapeHtml } from "@splash/email-shell";

export interface MxHealthEnv extends SupabaseEnv {
  /** Where the alert goes. Non-secret, so it is diff-able and changing it is a
   *  push rather than a secret rotation -- same posture as damage-worker's
   *  INCIDENTS_EMAIL. Unset means the check still runs and still logs; it just
   *  sends nothing. */
  INGEST_ALERT_EMAIL?: string;
  APPS_WEB_BASE_URL?: string;
}

/**
 * A pass mid-walk gets this long to finish before it is considered stuck.
 *
 * Generous on purpose. A cold backfill legitimately spans many ticks, and the
 * live walk has taken hours. What it must not do is span a DAY, which is what
 * the stuck cursor did -- for a fortnight.
 */
const STUCK_WALK_HOURS = 24;

export interface HealthProblem {
  key: string;
  /** Short reason, used as the bullet in the email and the log line. */
  problem: string;
  lastStatus: string | null;
  lastError: string | null;
  lastSuccessAt: string | null;
  lastRunAt: string | null;
}

export interface HealthResult {
  checked: number;
  problems: HealthProblem[];
  emailed: boolean;
  skipped: string | null;
}

interface SyncStateRow {
  key: string;
  cursor: string | null;
  last_run_at: string | null;
  last_success_at: string | null;
  last_status: string | null;
  last_error: string | null;
}

/**
 * Classify one pass. Returns null when it looks fine.
 *
 * Order matters only for which reason is reported; any one of them is enough.
 */
function diagnose(row: SyncStateRow, now: number): string | null {
  // 1. Saying so itself. The plainest signal there is, and the one that was
  //    sitting in the table unread for days.
  if (row.last_status === "ERROR") return "last run failed";

  // 2. Has run, has never once succeeded. Distinct from "has not run yet",
  //    which is a normal state for a pass that has not been reached.
  if (row.last_run_at !== null && row.last_success_at === null) {
    return "has never completed successfully";
  }

  // 3. Mid-walk for longer than any real walk takes. A cursor is not itself a
  //    problem -- it is how resumability works -- but a cursor that has not
  //    moved on to a success in a day is a walk that is not going to finish,
  //    and other passes may be standing down behind it.
  if (row.cursor !== null && row.last_success_at !== null) {
    const age = now - Date.parse(row.last_success_at);
    if (Number.isFinite(age) && age > STUCK_WALK_HOURS * 3_600_000) {
      return `mid-walk with no completion for over ${STUCK_WALK_HOURS}h`;
    }
  }

  return null;
}

/**
 * Read every sync-state row, report anything unhealthy.
 *
 * Never throws -- it shares a cron tick with the digest, and a rejection there
 * takes that down too.
 */
export async function runMxIngestHealth(
  env: MxHealthEnv,
  now = new Date()
): Promise<HealthResult> {
  const result: HealthResult = { checked: 0, problems: [], emailed: false, skipped: null };

  let rows: SyncStateRow[];
  try {
    const res = await fetch(
      `${env.SUPABASE_URL}/rest/v1/mx_sync_state` +
        `?select=key,cursor,last_run_at,last_success_at,last_status,last_error`,
      {
        headers: {
          apikey: env.SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`
        }
      }
    );
    if (!res.ok) {
      result.skipped = `sync-state read failed: ${res.status}`;
      console.error(`[mx-health] ${result.skipped}`);
      return result;
    }
    rows = (await res.json()) as SyncStateRow[];
  } catch (err) {
    result.skipped = err instanceof Error ? err.message : String(err);
    console.error("[mx-health] sync-state read threw:", err);
    return result;
  }

  result.checked = rows.length;
  const nowMs = now.getTime();

  for (const row of rows) {
    const problem = diagnose(row, nowMs);
    if (!problem) continue;
    result.problems.push({
      key: row.key,
      problem,
      lastStatus: row.last_status,
      lastError: row.last_error,
      lastSuccessAt: row.last_success_at,
      lastRunAt: row.last_run_at
    });
  }

  if (result.problems.length === 0) {
    // Logged on the healthy path too. This runs once a day, so one quiet line
    // is cheap, and its ABSENCE is how you notice the check itself stopped.
    console.log(`[mx-health] ${result.checked} pass(es) checked, all healthy`);
    return result;
  }

  for (const p of result.problems) {
    console.error(
      `[mx-health] ${p.key}: ${p.problem}` +
        (p.lastError ? ` — ${p.lastError.slice(0, 300)}` : "")
    );
  }

  if (!env.INGEST_ALERT_EMAIL) {
    result.skipped = "INGEST_ALERT_EMAIL not set — logged only";
    return result;
  }

  try {
    const { html, text, subject } = renderHealthEmail(result.problems, now);
    await enqueueOutboundEmail(env, {
      source_worker: "workorders-worker",
      source_kind: "workorders-ingest-health",
      // One alert per day per problem set. Re-running the cron on the same day
      // is a no-op via the queue's dedup index rather than a second email, and
      // a problem that persists still re-alerts TOMORROW -- which is the
      // behaviour wanted: a stuck pass should keep nagging, daily, not hourly.
      source_id: `${now.toISOString().slice(0, 10)}:${result.problems.map((p) => p.key).sort().join(",")}`,
      recipient: env.INGEST_ALERT_EMAIL,
      subject,
      body_html: html,
      body_text: text,
      attachments: []
    });
    result.emailed = true;
  } catch (err) {
    console.error("[mx-health] alert enqueue failed:", err);
    result.skipped = `alert enqueue failed: ${err instanceof Error ? err.message : String(err)}`;
  }

  return result;
}

function renderHealthEmail(
  problems: HealthProblem[],
  now: Date
): { html: string; text: string; subject: string } {
  const subject =
    problems.length === 1
      ? `MaintainX ingest: ${problems[0]!.key} needs attention`
      : `MaintainX ingest: ${problems.length} passes need attention`;

  const body =
    `<h2 style="margin:0 0 16px;font-size:20px;">MaintainX ingest health</h2>` +
    `<p style="margin:0 0 16px;">` +
    `The following sync pass${problems.length === 1 ? " is" : "es are"} not working. ` +
    `Everything below is read from <code>mx_sync_state</code>.` +
    `</p>` +
    problems
      .map(
        (p) =>
          `<div style="margin:0 0 20px;padding:12px 14px;background:#fff4f4;` +
          `border-left:4px solid #c0392b;">` +
          `<div style="font-weight:600;font-size:15px;">${escapeHtml(p.key)}</div>` +
          `<div style="margin:4px 0 8px;color:#c0392b;">${escapeHtml(p.problem)}</div>` +
          `<table style="font-size:13px;color:#444;border-collapse:collapse;">` +
          row("Last status", p.lastStatus) +
          row("Last run", p.lastRunAt) +
          row("Last success", p.lastSuccessAt ?? "never") +
          (p.lastError ? row("Error", p.lastError.slice(0, 400)) : "") +
          `</table></div>`
      )
      .join("") +
    `<p style="margin:16px 0 0;font-size:13px;color:#666;">` +
    `A pass stuck here can stand others down behind it — the daily ` +
    `reconciliation declines while the live walk is mid-cursor — so this is ` +
    `worth looking at the same day.` +
    `</p>`;

  const text =
    `MaintainX ingest health — ${now.toISOString().slice(0, 10)}\n\n` +
    problems
      .map(
        (p) =>
          `${p.key}: ${p.problem}\n` +
          `  last status:  ${p.lastStatus ?? "—"}\n` +
          `  last run:     ${p.lastRunAt ?? "—"}\n` +
          `  last success: ${p.lastSuccessAt ?? "never"}\n` +
          (p.lastError ? `  error:        ${p.lastError.slice(0, 400)}\n` : "")
      )
      .join("\n") +
    `\nA pass stuck here can stand others down behind it: the daily ` +
    `reconciliation declines while the live walk is mid-cursor.\n`;

  return { html: wrapInEmailShell(body, { preheader: subject }), text, subject };
}

function row(label: string, value: string | null): string {
  return (
    `<tr><td style="padding:2px 12px 2px 0;color:#888;">${escapeHtml(label)}</td>` +
    `<td style="padding:2px 0;font-family:monospace;">${escapeHtml(value ?? "—")}</td></tr>`
  );
}
