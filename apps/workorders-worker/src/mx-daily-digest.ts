// End-of-day per-site digest of reactive work-order activity.
//
// One email per site per day, to the site inbox and the Regional Manager,
// listing the reactive work orders that were worked on that day with the
// comments written on them and any expenses newly recorded.
//
// WHY "WORKED ON" IS A UNION OF THREE SIGNALS
//
//   The obvious key is `mx_updated_at`, and it is wrong on its own: adding a
//   comment does NOT move updatedAt in MaintainX. MEASURED over the week to
//   2026-09-15 at these six sites, comments consistently outnumbered
//   updated work orders (6 vs 2, 4 vs 2, 8 vs 6) -- so an updatedAt-keyed
//   digest would miss most of the activity it exists to report. A work order
//   qualifies if ANY of these happened in the window:
//
//     - a comment was written on it
//     - an expense was first recorded against it
//     - the work order itself changed (status, assignee, anything)
//
// WHY THE EXPENSE DATE IS OURS, NOT MAINTAINX'S
//
//   `mx_work_order_expenditure.first_seen_at` is stamped when OUR ingest first
//   saw the row, which is what the schema intends it for. Going forward that
//   is within about five minutes of reality. It is NOT a reliable historical
//   date: a backfill stamps everything it loads with the same instant, which
//   is why 2026-09-13 shows five expenses on a day with no other activity.
//   The digest only ever looks at today, so this is sound for its purpose and
//   unsound for anything retrospective.
//
// SCOPE
//
//   Six sites, operator-chosen for a trial. Widening is one array below --
//   and worth doing deliberately, because every added site is a daily email
//   to that site's inbox.

import {
  enqueueOutboundEmail,
  type SupabaseEnv
} from "@splash/db-supabase";
import { renderDailyDigestEmail, type DigestSite, type DigestWorkOrder } from "./mx-digest-render.js";

/** MaintainX location ids for the trial sites. Resolved 2026-09-15 from
 *  `locations`; none of them carry alias ids, so the canonical id is the whole
 *  story here (see accessibleMxIdsOf in index.ts for the alias case). */
export const DIGEST_SITES: ReadonlyArray<{ mxLocationId: number; name: string }> = [
  { mxLocationId: 1187635, name: "Binghamton" },
  { mxLocationId: 1187683, name: "Vestal" },
  { mxLocationId: 1187700, name: "Elmira Heights" },
  { mxLocationId: 2504365, name: "Johnson City" },
  { mxLocationId: 1187697, name: "Cicero" },
  { mxLocationId: 1187657, name: "Cortland" }
];

/** Comments shown per work order. A thread longer than this is a conversation
 *  the reader should open in MaintainX, not scroll in an email. */
const MAX_COMMENTS_PER_WO = 10;

export interface MxDigestEnv extends SupabaseEnv {
  /** Used to build the /workorders link in the email. */
  APPS_WEB_BASE_URL?: string;
}

export interface DigestResult {
  sitesWithActivity: number;
  workOrders: number;
  emailsQueued: number;
  failedRecipients: string[];
  skipped: string | null;
}

/* ============================================================
 * Eastern-time day boundaries
 * ============================================================ */

/**
 * Start of the current Eastern day, as an ISO instant.
 *
 * Cloudflare crons are UTC-only and the operator thinks in Eastern calendar
 * days, so the window has to be derived rather than assumed. The offset is
 * probed from Intl rather than hardcoded to -05:00/-04:00, which is the same
 * approach the jotform worker settled on (Brief 114/115) after stamping
 * Eastern wall-clock values as UTC and being four hours out.
 *
 * KNOWN GAP: the cron fires at 02:00 UTC, which is 22:00 Eastern the same
 * evening, so the window is [Eastern midnight, 22:00] and activity in the
 * last two hours of the day is not reported that night -- nor the next, since
 * the next run covers the next Eastern day. Reporting a full calendar day
 * would mean sending yesterday's news at 10pm tonight, which is worse. Moving
 * the cron later shrinks the tail.
 */
export function easternDayStart(now: Date): { startIso: string; label: string } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZoneName: "longOffset"
  });
  const parts = new Map(fmt.formatToParts(now).map((p) => [p.type, p.value]));
  const y = parts.get("year")!;
  const m = parts.get("month")!;
  const d = parts.get("day")!;
  // "GMT-04:00" -> "-04:00". The offset at THIS instant, so DST is handled by
  // the platform rather than by a rule we would have to maintain.
  const offset = (parts.get("timeZoneName") ?? "GMT+00:00").replace("GMT", "") || "+00:00";

  const startIso = new Date(`${y}-${m}-${d}T00:00:00${offset}`).toISOString();

  const label = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "long",
    month: "long",
    day: "numeric"
  }).format(now);

  return { startIso, label };
}

/* ============================================================
 * Reads
 * ============================================================ */

async function selectRows<T>(env: MxDigestEnv, url: string): Promise<T[] | null> {
  try {
    const res = await fetch(url, {
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`
      }
    });
    if (!res.ok) {
      console.error(`[mx-digest] read failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
      return null;
    }
    return (await res.json()) as T[];
  } catch (err) {
    console.error("[mx-digest] read threw:", err);
    return null;
  }
}

interface CommentRow {
  work_order_id: number;
  author_id: number | null;
  content: string | null;
  mx_created_at: string | null;
}

interface ExpenseRow {
  work_order_id: number;
  description: string | null;
  type: string | null;
  quantity: number | null;
  row_total_cents: number | null;
}

interface WorkOrderRow {
  id: number;
  sequential_id: number | null;
  title: string | null;
  description: string | null;
  status: string | null;
  priority: string | null;
  mx_location_id: number | null;
  mx_updated_at: string | null;
}

/**
 * Gather a day's activity for the trial sites.
 *
 * Four reads rather than one: "has a comment OR an expense OR changed itself"
 * spans three tables and PostgREST cannot express a disjunction across
 * embedded resources. Collecting candidate ids from each signal and then
 * fetching the work orders once is both simpler to read and cheaper than the
 * alternatives at this volume (2-7 work orders a day across all six sites).
 */
async function gatherActivity(
  env: MxDigestEnv,
  sinceIso: string
): Promise<{
  workOrders: Map<number, WorkOrderRow>;
  commentsByWo: Map<number, CommentRow[]>;
  expensesByWo: Map<number, ExpenseRow[]>;
} | null> {
  const locIds = DIGEST_SITES.map((s) => s.mxLocationId).join(",");
  const since = encodeURIComponent(sinceIso);

  // 1. Comments written today, on reactive work orders at these sites.
  //    The `mx_work_order!inner(...)` embed applies the site + type filter at
  //    the parent, which is the only way to scope a child query in PostgREST.
  const comments = await selectRows<CommentRow>(
    env,
    `${env.SUPABASE_URL}/rest/v1/mx_work_order_comment` +
      `?select=work_order_id,author_id,content,mx_created_at,` +
      `mx_work_order!inner(mx_location_id,type,deleted_at)` +
      `&mx_created_at=gte.${since}` +
      `&mx_work_order.mx_location_id=in.(${locIds})` +
      `&mx_work_order.type=not.eq.PREVENTIVE` +
      `&mx_work_order.deleted_at=is.null` +
      `&order=mx_created_at.asc`
  );
  if (comments === null) return null;

  // 2. Expenses first seen today. See the header on why this date is ours.
  const expenses = await selectRows<ExpenseRow>(
    env,
    `${env.SUPABASE_URL}/rest/v1/mx_work_order_expenditure` +
      `?select=work_order_id,description,type,quantity,row_total_cents,` +
      `mx_work_order!inner(mx_location_id,type,deleted_at)` +
      `&first_seen_at=gte.${since}` +
      `&mx_work_order.mx_location_id=in.(${locIds})` +
      `&mx_work_order.type=not.eq.PREVENTIVE` +
      `&mx_work_order.deleted_at=is.null` +
      `&order=ordinal.asc`
  );
  if (expenses === null) return null;

  // 3. Work orders that changed today. Catches status moves and reassignments
  //    -- the activity that leaves no comment and costs nothing.
  const touched = await selectRows<{ id: number }>(
    env,
    `${env.SUPABASE_URL}/rest/v1/mx_work_order` +
      `?select=id` +
      `&mx_location_id=in.(${locIds})` +
      `&type=not.eq.PREVENTIVE` +
      `&deleted_at=is.null` +
      `&mx_updated_at=gte.${since}`
  );
  if (touched === null) return null;

  const ids = new Set<number>();
  for (const c of comments) ids.add(c.work_order_id);
  for (const e of expenses) ids.add(e.work_order_id);
  for (const t of touched) ids.add(t.id);

  const workOrders = new Map<number, WorkOrderRow>();
  if (ids.size > 0) {
    const rows = await selectRows<WorkOrderRow>(
      env,
      `${env.SUPABASE_URL}/rest/v1/mx_work_order` +
        `?select=id,sequential_id,title,description,status,priority,mx_location_id,mx_updated_at` +
        `&id=in.(${[...ids].join(",")})`
    );
    if (rows === null) return null;
    for (const r of rows) workOrders.set(r.id, r);
  }

  const commentsByWo = new Map<number, CommentRow[]>();
  for (const c of comments) {
    if (typeof c.content !== "string" || c.content.trim() === "") continue;
    const list = commentsByWo.get(c.work_order_id) ?? [];
    list.push(c);
    commentsByWo.set(c.work_order_id, list);
  }

  const expensesByWo = new Map<number, ExpenseRow[]>();
  for (const e of expenses) {
    const list = expensesByWo.get(e.work_order_id) ?? [];
    list.push(e);
    expensesByWo.set(e.work_order_id, list);
  }

  return { workOrders, commentsByWo, expensesByWo };
}

/** Site contact addresses, keyed by MaintainX location id. */
async function siteRecipients(
  env: MxDigestEnv
): Promise<Map<number, { siteEmail: string | null; rmEmail: string | null }>> {
  const out = new Map<number, { siteEmail: string | null; rmEmail: string | null }>();
  const locIds = DIGEST_SITES.map((s) => s.mxLocationId).join(",");
  const rows = await selectRows<{
    maintainx_id: number | null;
    site_email: string | null;
    rm_email: string | null;
  }>(
    env,
    `${env.SUPABASE_URL}/rest/v1/locations` +
      `?select=maintainx_id,site_email,rm_email&maintainx_id=in.(${locIds})`
  );
  for (const r of rows ?? []) {
    if (r.maintainx_id === null) continue;
    out.set(r.maintainx_id, { siteEmail: r.site_email, rmEmail: r.rm_email });
  }
  return out;
}

/** Author display names for the comment lines. */
async function authorNames(
  env: MxDigestEnv,
  ids: number[]
): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (ids.length === 0) return out;
  const rows = await selectRows<{ id: number; full_name: string | null }>(
    env,
    `${env.SUPABASE_URL}/rest/v1/maintainx_users?select=id,full_name&id=in.(${ids.join(",")})`
  );
  for (const r of rows ?? []) {
    if (r.full_name) out.set(r.id, r.full_name);
  }
  return out;
}

/* ============================================================
 * Entry point
 * ============================================================ */

/**
 * Build and queue one email per site with activity. Never throws -- the caller
 * is a scheduled handler.
 *
 * Sites with nothing to report get NO email. A daily "nothing happened"
 * message trains people to ignore the whole series, which costs more than the
 * missing reassurance is worth.
 */
export async function runMxDailyDigest(env: MxDigestEnv, now = new Date()): Promise<DigestResult> {
  const result: DigestResult = {
    sitesWithActivity: 0,
    workOrders: 0,
    emailsQueued: 0,
    failedRecipients: [],
    skipped: null
  };

  const { startIso, label } = easternDayStart(now);
  const activity = await gatherActivity(env, startIso);
  if (activity === null) {
    result.skipped = "activity read failed";
    return result;
  }
  if (activity.workOrders.size === 0) return result;

  const recipients = await siteRecipients(env);
  const authorIds = [
    ...new Set(
      [...activity.commentsByWo.values()]
        .flat()
        .map((c) => c.author_id)
        .filter((id): id is number => typeof id === "number")
    )
  ];
  const authors = await authorNames(env, authorIds);

  // Group the work orders under their site.
  const bySite = new Map<number, DigestWorkOrder[]>();
  for (const wo of activity.workOrders.values()) {
    if (wo.mx_location_id === null) continue;
    const comments = (activity.commentsByWo.get(wo.id) ?? []).slice(0, MAX_COMMENTS_PER_WO);
    const list = bySite.get(wo.mx_location_id) ?? [];
    list.push({
      id: wo.id,
      sequentialId: wo.sequential_id,
      title: wo.title ?? "(no title)",
      description: wo.description,
      status: wo.status ?? "",
      priority: wo.priority ?? "NONE",
      comments: comments.map((c) => ({
        author: c.author_id != null ? (authors.get(c.author_id) ?? null) : null,
        content: (c.content ?? "").trim(),
        createdAt: c.mx_created_at
      })),
      commentsTruncated: (activity.commentsByWo.get(wo.id) ?? []).length > MAX_COMMENTS_PER_WO,
      expenses: (activity.expensesByWo.get(wo.id) ?? []).map((e) => ({
        description: e.description?.trim() || "(no description)",
        type: e.type,
        quantity: e.quantity,
        totalCents: e.row_total_cents
      }))
    });
    bySite.set(wo.mx_location_id, list);
  }
  result.workOrders = activity.workOrders.size;

  const appsWebBase = env.APPS_WEB_BASE_URL ?? "https://splashcarwashes.info";

  for (const site of DIGEST_SITES) {
    const workOrders = bySite.get(site.mxLocationId);
    if (!workOrders || workOrders.length === 0) continue;
    result.sitesWithActivity += 1;

    // Highest priority first, then most recently touched, so the thing that
    // most wants attention is at the top of the mail.
    workOrders.sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority));

    const contacts = recipients.get(site.mxLocationId);
    const to = [contacts?.siteEmail, contacts?.rmEmail]
      .filter((e): e is string => typeof e === "string" && e.trim() !== "")
      .map((e) => e.trim().toLowerCase());
    // Case-insensitive dedup: a site whose RM address IS the site address
    // should get one email, not two.
    const unique = [...new Set(to)];
    if (unique.length === 0) {
      console.warn(`[mx-digest] ${site.name}: no recipients on file, skipping`);
      continue;
    }

    const digestSite: DigestSite = { name: site.name, dayLabel: label, workOrders };
    const { html, text, subject } = renderDailyDigestEmail(digestSite, appsWebBase);

    for (const recipient of unique) {
      try {
        await enqueueOutboundEmail(env, {
          source_worker: "workorders-worker",
          source_kind: "workorders-daily-digest",
          // Date + location, so a re-run on the same day is a no-op via the
          // queue's dedup index rather than a second email.
          source_id: `${startIso.slice(0, 10)}:${site.mxLocationId}`,
          recipient,
          subject,
          body_html: html,
          body_text: text,
          attachments: []
        });
        result.emailsQueued += 1;
      } catch (err) {
        // Per-recipient, so one bad address cannot cost the other their email.
        result.failedRecipients.push(recipient);
        console.error(`[mx-digest] enqueue failed for ${recipient}:`, err);
      }
    }
  }

  return result;
}

const PRIORITY_RANK: Record<string, number> = { HIGH: 0, MEDIUM: 1, LOW: 2, NONE: 3 };
function priorityRank(p: string): number {
  return PRIORITY_RANK[(p ?? "").toUpperCase()] ?? 3;
}
