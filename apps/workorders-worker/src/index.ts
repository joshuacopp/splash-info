// Splash Work Orders Worker — Brief 70 + Brief 71.
//
// Read-only MaintainX integration. apps/web's /workorders page SSR-fetches
// GET /workorders/api/list via the WORKORDERS_WORKER service binding; the
// response is server-bucketed Reactive vs Preventive (by MaintainX
// `wo.type`) and grouped by MaintainX location, with per-group sort by
// priority HIGH → MEDIUM → LOW → NONE then `updatedAt` desc.
//
// PERMISSION DOMAIN — pure email-on-locations (Brief 71):
//   Each user sees the locations whose `am_email`, `rm_email`, or
//   `site_email` (`locations` table) equals their session email.
//   super_admin / admin do NOT have a global override; if they want
//   global visibility they need their email on the relevant rows.
//   No dc_role check, no global path, no "unmatched" bucket.
//
//   EXCEPTION — /workorders/api/parts/* (see ./parts.ts). The Parts
//   Directory is a single company-wide reference list, not per-site
//   data, so it is deliberately NOT scoped by email-on-locations: every
//   authenticated session reads all of it, and writes are gated on the
//   platform `session.role === "super_admin"`.
//
// FAIL-SOFT POSTURE:
//   - MAINTAINX_API_KEY unbound → 503 with friendly body
//   - MaintainX upstream non-2xx → 502
//   - Network / abort → 504
//   - Anything else → 500
//
// SCHEDULED HANDLER (Brief 71, extended Brief 74):
//   The default export is { fetch, scheduled }. TWO cron expressions are
//   registered in wrangler.toml and the handler branches on
//   `controller.cron` — see the comment above `scheduled` below. Same
//   pattern as damage-worker post-Brief 65; Workers Logs
//   `[observability.logs]` block from Brief 63 covers scheduled
//   invocations automatically (eventType: scheduled).

import { authenticate, type Session } from "@splash/auth";
import { MX_WEBHOOK_PATH, handleMxWebhook } from "./mx-webhook.js";
import { processMxWebhookDelivery } from "./mx-webhook-process.js";
import {
  getLocationsByContactEmail,
  getMaintainXTeamsByIds,
  getMaintainXUserByEmail,
  getMaintainXUsersByIds,
  type MaintainXTeamRow,
  type MaintainXUserRow,
  type SupabaseEnv,
  type UserAccessibleLocation
} from "@splash/db-supabase";
import { isOriginAllowed, json, jsonError } from "@splash/http";
import {
  createMaintainXWorkRequest,
  fetchMaintainXWorkOrders,
  fetchMaintainXWorkRequests,
  uploadMaintainXWorkRequestFile,
  type RawWorkOrder,
  type RawWorkRequest
} from "@splash/maintainx";
import { runMxIngest } from "./mx-ingest.js";
import { runMxWebhookDrain } from "./mx-webhook-drain.js";
import {
  fetchWorkOrdersFromPg,
  fetchWorkRequestsFromPg,
  type PgWorkOrderExtras
} from "./mx-list-pg.js";
import { runMxReconcile } from "./mx-reconcile.js";
import { runMxTimeSweep } from "./mx-timesweep.js";
import { runMxAttachmentMirror } from "./mx-attachments.js";
import { runMxDailyDigest } from "./mx-daily-digest.js";
import { fetchPmOnTime, type PmOnTimeResult } from "./mx-pm-ontime.js";
import { handlePartsRequest } from "./parts.js";
import { runMaintainXUserTeamSync, type SyncResult } from "./sync.js";

// The two cron expressions registered under `[triggers] crons` in
// wrangler.toml. `controller.cron` hands back the literal string from that
// file, so matching is EXACT: editing a schedule in wrangler.toml without
// editing the constant here does not throw, it silently stops running the
// pass. The fall-through arm of the branch below logs loudly for that reason.
const USER_SYNC_CRON = "30 11 * * *";
const MX_INGEST_CRON = "*/5 * * * *";
/** 05:00 UTC -- 1 AM Eastern in summer, midnight in winter, so it is always
 *  at or after Eastern midnight and the previous day is always complete. Must
 *  match wrangler.toml exactly: the dispatcher compares the literal string, so
 *  a schedule edited in one place and not the other silently stops running. */
const DAILY_DIGEST_CRON = "0 5 * * *";

interface Env extends SupabaseEnv {
  /**
   * Where GET /workorders/api/list reads from.
   *
   *   "maintainx" (default) — live API calls, the behaviour since Brief 70.
   *   "postgres"            — the local mirror the ingest and webhooks fill.
   *
   * Unset or unrecognised means "maintainx": a typo in wrangler.toml must not
   * silently move every operator onto the other source. The flip is a `[vars]`
   * edit and therefore a push, which is deliberate -- this repo deploys from
   * pushes and a read-path swap should be visible in the diff.
   *
   * Individual operators can override per request with `?source=` before the
   * global flip; see resolveReadSource.
   */
  WORKORDERS_READ_SOURCE?: string;
  /** MaintainX bearer token. Same value as on splash-damage (Brief 42).
   *  Optional: when unbound the worker returns 503. */
  MAINTAINX_API_KEY?: string;
  /** R2 mirror of MaintainX attachments (splash-workorder-files). Optional so
   *  an unbound bucket degrades to "no images" rather than breaking the page;
   *  the mirror pass reports it and skips. */
  WORKORDER_FILES?: R2Bucket;
  /** REST root, no trailing /workorders. `[vars]` entry. */
  MAINTAINX_BASE_URL: string;
  /** Populated for parity with damage-worker; not consumed in v1. */
  APPS_WEB_BASE_URL: string;
  /** MaintainX webhook signing secret, returned by POST /subscriptions and
   *  re-readable from GET /subscriptions/{id}/secret.
   *  `wrangler secret put MAINTAINX_WEBHOOK_SECRET`.
   *
   *  Optional in the type, fatal in effect: unbound, every delivery is
   *  refused with 401 rather than falling open. */
  MAINTAINX_WEBHOOK_SECRET?: string;
}

// Brief 72: pagination limits.
//   - Single-location users: skip pagination; MaintainX's 200-per-call
//     cap is enough headroom for any one site's open queue.
//   - Multi-location users: paginate up to MAX_WORK_ORDERS_MULTI total.
//     Past the cap, the page renders a truncation banner.
const MAX_WORK_ORDERS_SINGLE = 200;
const MAX_WORK_ORDERS_MULTI = 1000;
const TIMEOUT_SINGLE_MS = 8_000;
const TIMEOUT_MULTI_MS = 30_000;

// Brief 80: work-requests read path. Fetched in parallel with the WO
// list (its own AbortController) so it never delays or aborts the main
// fetch. Row cap bounds memory; the request queue we care about
// (PENDING + REJECTED) is small, so this ceiling is generous headroom.
const MAX_WORK_REQUESTS = 1000;
const TIMEOUT_REQUESTS_MS = 20_000;
// Brief 80: only these two statuses surface on the Requests tab.
// APPROVED / DONE requests have been promoted to work orders and show
// up on the Reactive/Preventative tabs instead.
const REQUEST_VISIBLE_STATUSES = new Set<string>(["PENDING", "REJECTED"]);

/** Hardcoded super-admin allow-list for the on-demand sync trigger. Mirrors
 *  the operator/super_admin list called out in CLAUDE.md "operator
 *  preferences"; defense-in-depth backed by `session.dcRole === "super_admin"`
 *  fallback in `isSyncTriggerAllowed`. */
const SYNC_ADMIN_EMAILS = new Set<string>([
  "joshua.copp@gmail.com",
  "josh.copp@splashcarwashes.com",
  "noah@splashcarwashes.com",
  "alexandro@splashcarwashes.com",
  "jacob@splashcarwashes.com",
  "rwilliams@splashcarwashes.com"
]);

/* ============================================================
 * Response shape — server already bucketed + grouped + decorated.
 * ============================================================ */

interface AssigneeOut {
  id: number | null;
  type: "USER" | "TEAM" | "OTHER";
  name: string;
  email: string | null;
}

/** A comment on the expanded row. Author resolved against the same
 *  maintainx_users cache the assignee list uses; `author` is null when the id
 *  is absent or not in the cache, which renders as "Unknown" rather than
 *  hiding the comment -- the text is the point, not the attribution. */
interface CommentOut {
  id: string;
  author: string | null;
  content: string;
  createdAt: string | null;
}

/**
 * Cost breakdown. Present only on the Postgres path -- the MaintainX list
 * endpoint does not carry costs, and fetching them live would be one API call
 * per work order.
 *
 * Every figure is CENTS, matching the MaintainX API and the schema. Formatting
 * to dollars is the UI's job; doing it here would invite the same 100x error
 * that had these columns wrong until 9a920d1.
 */
interface CostOut {
  partCents: number;
  expenditureCents: number;
  totalCents: number;
  laborSeconds: number | null;
  parts: Array<{
    name: string;
    quantity: number | null;
    unitCostCents: number | null;
    lineTotalCents: number | null;
  }>;
  expenditures: Array<{
    description: string;
    type: string | null;
    quantity: number | null;
    costPerUnitCents: number | null;
    rowTotalCents: number | null;
  }>;
}

/** A mirrored attachment. `id` is what the serve route takes; there is no URL
 *  here because the client builds one from the id and the route checks
 *  permissions on every request. */
interface AttachmentOut {
  id: number;
  fileName: string | null;
  mimeType: string | null;
  width: number | null;
  height: number | null;
  isThumbnail: boolean;
}

interface WorkOrderOut {
  id: number;
  sequentialId: number | null;
  title: string;
  status: "OPEN" | "IN_PROGRESS" | "ON_HOLD" | string;
  priority: "HIGH" | "MEDIUM" | "LOW" | "NONE" | string;
  type: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  dueDate: string | null;
  description: string | null;
  assignees: AssigneeOut[];
  categories: string[];
  locationId: number | null;
  /** Newest-first, capped. Empty on the MaintainX path and for a work order
   *  with no comments -- the UI cannot tell those apart, and does not need to:
   *  both render as "no comments". */
  comments: CommentOut[];
  /** True when older comments exist beyond the cap. */
  commentsTruncated: boolean;
  /** Null when nothing was recorded, which is the common case: 28 of 22,910
   *  work orders carry a cost. Null renders as no cost section at all rather
   *  than a row of zeroes. */
  cost: CostOut | null;
  /** Mirrored photos, thumbnail first. Empty on the MaintainX path and for
   *  anything not yet copied into R2. */
  attachments: AttachmentOut[];
}

interface GroupOut {
  /** MaintainX location ID — group key. */
  maintainx_id: number;
  /** Header label. Prefers MaintainX's own `expand=location.name`; falls
   *  back to the Splash-side postal address from `locations.location`,
   *  then to a "(unknown location)" placeholder. */
  location_pretty: string;
  work_orders: WorkOrderOut[];
}

/** Brief 80 — projected work request for the Requests sub-tab. Distinct
 *  from WorkOrderOut: a request carries `requestStatus` + an optional
 *  promoted `workOrderId`, and a single `creator` rather than an
 *  assignee list. No `type` (reactive/preventive) — requests aren't
 *  bucketed that way. */
interface RequestCreatorOut {
  id: number | null;
  name: string;
  email: string | null;
}

interface WorkRequestOut {
  id: number;
  title: string;
  /** MaintainX `requestStatus` — PENDING or REJECTED (the only two the
   *  Requests tab surfaces). */
  status: string;
  priority: "HIGH" | "MEDIUM" | "LOW" | "NONE" | string;
  createdAt: string | null;
  updatedAt: string | null;
  description: string | null;
  locationId: number | null;
  /** Set once staff promote the request; null while PENDING/REJECTED. */
  workOrderId: number | null;
  /** Null when creatorId is absent or unresolved in the users cache. */
  creator: RequestCreatorOut | null;
  /** Mirrored photos, thumbnail first. Empty on the MaintainX path and for
   *  anything not yet copied into R2. Only PENDING requests are mirrored --
   *  see REQUEST_STATUSES_TO_MIRROR in mx-attachments.ts -- so a REJECTED one
   *  renders without photos even when MaintainX has them. */
  attachments: AttachmentOut[];
}

interface RequestGroupOut {
  maintainx_id: number;
  location_pretty: string;
  work_requests: WorkRequestOut[];
}

/** Brief 74 — surfaced to apps/web so the New Request tab's Location
 *  dropdown has the data it needs without a second fetch. The shape is
 *  the read-path's `UserAccessibleLocation` plus `location_name` (from
 *  MX `expand=location.name` on the work-order list — null when no WO
 *  has yet referenced this loc). The form filters to `maintainx_id !==
 *  null` (a request can't post to an unmapped location). */
interface AccessibleLocationOut {
  maintainx_id: number | null;
  location_address: string | null;
  location_name: string | null;
}

interface CurrentUserOut {
  email: string;
  /** Operator's MaintainX `full_name` (sourced from the cached
   *  `maintainx_users` row); null when no row matches their session
   *  email. apps/web defaults the Requester Name input to this when
   *  rendering the New Request tab. */
  full_name: string | null;
}

interface ListResponse {
  reactive: { groups: GroupOut[] };
  preventive: { groups: GroupOut[] };
  /** Brief 80 — PENDING + REJECTED work requests for the user's mapped
   *  locations, grouped like the WO buckets. */
  requests: { groups: RequestGroupOut[] };
  fetchedAt: string;
  truncated: boolean;
  /** Brief 80 — true iff the work-requests fetch hit its row/page cap
   *  before exhausting the cursor. Independent of `truncated` (WOs). */
  requestsTruncated: boolean;
  /** Brief 72: number of MaintainX API calls made (1 for single-location
   *  users, 1-5 for multi-location users on the paginated path). */
  pageCount: number;
  accessibleLocationCount: number;
  mappedLocationCount: number;
  email: string;
  /** Brief 74 — passed through to the New Request tab's form. */
  accessibleLocations: AccessibleLocationOut[];
  currentUser: CurrentUserOut;
  /** Which source answered. Additive and ignored by apps/web; it exists so a
   *  response can be attributed during the Postgres cutover -- without it,
   *  "did this come from the mirror?" is unanswerable from the payload. */
  source: ReadSource;
  /** Current-week preventive on-time rate, per location and overall. Null when
   *  the mirror could not answer, or on the MaintainX read path, which has no
   *  access to completed work orders -- the page renders nothing rather than
   *  an invented figure. */
  pmOnTime: PmOnTimeResult | null;
}

/* ============================================================
 * Top-level fetch
 * ============================================================ */

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/+/, "");

    try {
      // ---- THE ONE UNAUTHENTICATED ROUTE ----------------------------------
      //
      // Deliberately first, and deliberately an EXACT equality check on a
      // single constant. MaintainX cannot hold a Supabase session, so the HMAC
      // in mx-webhook-verify.ts is the entire gate. A prefix match here would
      // silently expose anything later added under the same stem; equality
      // cannot widen by accident.
      //
      // Everything below this block calls authenticate(). This is the only
      // thing that does not.
      if (path === MX_WEBHOOK_PATH) {
        return handleMxWebhook(request, env, ctx, {
          // Runs after the 202, inside ctx.waitUntil(). Never throws -- a
          // rejection there would be an unhandled rejection with no response
          // left to attach it to.
          process: (delivery, eventRowId) =>
            processMxWebhookDelivery(env, delivery, eventRowId)
        });
      }

      if (path === "workorders/api/list" && request.method === "GET") {
        const auth = await authenticate(request, env);
        if (auth.status !== "authenticated") return jsonError(401, "unauthorized");
        return handleList(env, auth.session, resolveReadSource(env, url, auth.session));
      }

      // Attachment bytes from the R2 mirror. Path carries the MaintainX
      // attachment id; the handler resolves the owning work order and checks
      // the caller can see THAT, so the id alone grants nothing.
      const attachmentMatch = /^workorders\/api\/attachment\/(\d+)$/.exec(path);
      if (attachmentMatch && request.method === "GET") {
        const auth = await authenticate(request, env);
        if (auth.status !== "authenticated") return jsonError(401, "unauthorized");
        return handleAttachment(env, auth.session, Number(attachmentMatch[1]));
      }

      if (path === "workorders/api/sync-maintainx-users" && request.method === "POST") {
        const auth = await authenticate(request, env);
        if (auth.status !== "authenticated") return jsonError(401, "unauthorized");
        if (!isSyncTriggerAllowed(auth.session)) {
          return jsonError(403, "manual sync requires super_admin");
        }
        const result = await runMaintainXUserTeamSync(env);
        console.log("workorders-worker manual sync complete:", JSON.stringify(result));
        return json(result satisfies SyncResult);
      }

      // Manual kick for the MaintainX -> Postgres ingest. Same super_admin
      // gate as the user sync above. One call runs ONE bounded pass
      // (mx-ingest.ts owns the page and time budgets) and checkpoints into
      // mx_sync_state, so during backfill this has to be called repeatedly —
      // it is a debugging handle, not a "sync everything now" button. Safe to
      // call while the cron is also running: every write is an upsert.
      if (path === "workorders/api/mx-ingest" && request.method === "POST") {
        const auth = await authenticate(request, env);
        if (auth.status !== "authenticated") return jsonError(401, "unauthorized");
        if (!isSyncTriggerAllowed(auth.session)) {
          return jsonError(403, "manual ingest requires super_admin");
        }
        const result = await runMxIngest(env);
        console.log("workorders-worker manual mx ingest complete:", JSON.stringify(result));
        return json(result);
      }

      if (path === "workorders/api/request" && request.method === "POST") {
        const auth = await authenticate(request, env);
        if (auth.status !== "authenticated") {
          return buildRequestRedirect(request, "Sign in to file a work request.");
        }
        return handleCreateRequest(request, env, auth.session);
      }

      // Parts Directory — /workorders/api/parts[/{id}]. Handlers live in
      // ./parts.js; see that file's header for why this surface is hosted
      // here and why its permission domain is deliberately NOT the
      // email-on-locations gate the MaintainX routes above use. Auth is
      // checked once here (401); the super_admin gate on writes is inside.
      if (
        path === "workorders/api/parts" ||
        path.startsWith("workorders/api/parts/")
      ) {
        const auth = await authenticate(request, env);
        if (auth.status !== "authenticated") return jsonError(401, "unauthorized");
        return handlePartsRequest(request, env, path, auth.session);
      }

      return new Response("Not found", { status: 404 });
    } catch (err) {
      console.error("workorders-worker request failed:", path, err);
      return jsonError(500, err instanceof Error ? err.message : "server error");
    }
  },

  // Two crons land here and the ONLY thing that distinguishes them is
  // `controller.cron`:
  //
  //   "30 11 * * *"  daily MaintainX user/team sync (Brief 71).
  //   "*/5 * * * *"  webhook drain then MaintainX -> Postgres ingest
  //                  (Brief 74). The drain retries deliveries the inline
  //                  waitUntil path did not finish; see mx-webhook-drain.ts.
  //                  The ingest is deliberately
  //                  chunked: one pass per invocation, bounded by
  //                  TIME_BUDGET_MS / PAGE_BUDGET in mx-ingest.ts and resumed
  //                  from the cursor in mx_sync_state. The 6-month backfill
  //                  therefore completes across many ticks rather than in one
  //                  long-running invocation; once every backfill pass is
  //                  marked complete, this tick costs a single incremental
  //                  sweep that usually finds nothing.
  //
  // Both arms swallow their own errors. A throw out of a `waitUntil` promise
  // fails the whole scheduled invocation, and with two independent jobs
  // sharing this handler that would let one job's bad day mask the other's.
  // Nothing here retries, either — the next tick is the retry, and because
  // every write is an upsert keyed on the MaintainX id, re-running a pass is
  // free.
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const cron = controller.cron;
    ctx.waitUntil(
      (async () => {
        if (cron === MX_INGEST_CRON) {
          // Drain BEFORE ingest, and in its own try. Order matters: the ingest
          // is budgeted to use most of the tick, so running it first would
          // routinely leave the drain no time and the backlog would only ever
          // clear on a tick where the ingest happened to finish early. The
          // drain's own budget is the smaller of the two for the same reason
          // in reverse -- it must not starve the ingest.
          //
          // Separate try blocks because these are independent jobs sharing a
          // tick: a drain that throws must not stop the sweep that is the
          // backstop for everything the drain failed to apply.
          try {
            const drained = await runMxWebhookDrain(env);
            // Silent on the common case -- an empty queue every 5 minutes is
            // noise that would bury the passes that did something.
            if (drained.claimed > 0) {
              console.log("workorders-worker mx webhook drain:", JSON.stringify(drained));
            }
          } catch (err) {
            console.error("workorders-worker mx webhook drain failed:", err);
          }

          try {
            const result = await runMxIngest(env);
            console.log("workorders-worker mx ingest complete:", JSON.stringify(result));
          } catch (err) {
            console.error("workorders-worker mx ingest failed:", err);
          }

          // Time-item sweep. AFTER the ingest, because the ingest is the
          // thing that finishes and this one only ever rotates, and BEFORE the
          // attachment mirror, because unsynced labor is data nobody can see
          // and an unmirrored image is a picture that loads later.
          //
          // This is not a duplicate of the ingest and cannot be folded into
          // it. The ingest asks MaintainX for work orders whose updatedAt
          // moved; MaintainX does not move updatedAt for time or cost edits,
          // so the rows carrying unsynced hours are precisely the rows the
          // ingest can never be told about. See mx-timesweep.ts.
          try {
            const swept = await runMxTimeSweep(env);
            // Quiet only when a pass did nothing AND nothing went wrong. A
            // skip reason is always worth a line -- "the sweep has not run for
            // a week" should be visible, not inferred from silence.
            if (swept.refetched > 0 || swept.failed > 0 || swept.skipped) {
              console.log("workorders-worker mx time sweep:", JSON.stringify(swept));
            }
          } catch (err) {
            console.error("workorders-worker mx time sweep failed:", err);
          }

          // Attachment mirror LAST of the four. Images are the least urgent
          // thing on this tick and a slow download must not delay either the
          // drain or the sweep that keep the work orders themselves current.
          // Its own try for the same reason the other two have one.
          try {
            const mirror = await runMxAttachmentMirror(env);
            // Silent when a pass did nothing, which is the steady state once
            // the backfill is done -- otherwise this logs every 5 minutes
            // forever and buries the passes that mattered.
            if (
              mirror.mirrored > 0 ||
              mirror.failed > 0 ||
              mirror.metadataFailures > 0 ||
              mirror.skipped
            ) {
              console.log("workorders-worker mx attachment mirror:", JSON.stringify(mirror));
            }
          } catch (err) {
            console.error("workorders-worker mx attachment mirror failed:", err);
          }
          return;
        }

        if (cron === USER_SYNC_CRON) {
          try {
            const result = await runMaintainXUserTeamSync(env);
            console.log("workorders-worker scheduled sync complete:", JSON.stringify(result));
          } catch (err) {
            console.error("workorders-worker scheduled sync failed:", err);
          }

          // Daily reconciliation. Schedules a full re-walk of the active queue
          // so a row the incremental sweep can no longer see -- one skipped
          // while the watermark ran ahead of it, whose updatedAt is now
          // permanently behind -- is found without anyone noticing first.
          // Separate try: it must not be able to take the user sync down, and
          // the user sync must not stop it running.
          try {
            const rec = await runMxReconcile(env);
            console.log("workorders-worker mx reconcile:", JSON.stringify(rec));
          } catch (err) {
            console.error("workorders-worker mx reconcile failed:", err);
          }
          return;
        }

        if (cron === DAILY_DIGEST_CRON) {
          try {
            const digest = await runMxDailyDigest(env);
            // Always logged, including the nothing-happened case: this runs
            // once a day, so a quiet line is cheap and its ABSENCE is the
            // signal that the cron did not fire at all.
            console.log("workorders-worker daily digest:", JSON.stringify(digest));
          } catch (err) {
            console.error("workorders-worker daily digest failed:", err);
          }
          return;
        }

        console.error(
          `workorders-worker: scheduled fired for an unrecognised cron ${JSON.stringify(cron)} — wrangler.toml and the cron constants in src/index.ts have drifted; nothing ran`
        );
      })()
    );
  }
} satisfies ExportedHandler<Env>;

export type ReadSource = "maintainx" | "postgres";

/**
 * Decide which source answers this request.
 *
 * The `[vars]` entry is the global setting. `?source=` overrides it for ONE
 * request and only for a super_admin, which is what makes a cutover checkable:
 * an operator with the right role can load the same page from both sources and
 * diff them, on production data, without moving anyone else. A non-super_admin
 * passing `?source=` is ignored rather than rejected -- it is not an attack,
 * and failing their page load over a stray query param would be worse than
 * serving them the default.
 *
 * Anything unrecognised resolves to "maintainx". The safe direction is the one
 * that has been serving operators since Brief 70.
 */
function resolveReadSource(env: Env, url: URL, session: Session): ReadSource {
  const override = url.searchParams.get("source");
  if (override && isSyncTriggerAllowed(session)) {
    if (override === "postgres" || override === "maintainx") return override;
  }
  return env.WORKORDERS_READ_SOURCE === "postgres" ? "postgres" : "maintainx";
}

function isSyncTriggerAllowed(session: Session): boolean {
  const email = session.email?.trim().toLowerCase() ?? "";
  if (email && SYNC_ADMIN_EMAILS.has(email)) return true;
  return session.dcRole === "super_admin";
}

/* ============================================================
 * GET /workorders/api/list — pure email-on-locations gate.
 * ============================================================ */

/**
 * Serve one mirrored attachment.
 *
 * THE PERMISSION CHECK IS THE POINT. An attachment id is a small integer and
 * an operator could try another one, so possessing an id must grant nothing on
 * its own. The handler resolves the attachment's owning work order, then its
 * MaintainX location, and requires that location to be in the caller's
 * accessible set -- the SAME set that gates the list. A miss returns 404, not
 * 403: telling a prober that an id exists but is out of reach is itself an
 * answer.
 *
 * Bytes come from R2, never from MaintainX. The presigned source URLs expired
 * an hour after the sync that fetched them; the mirror is the only durable
 * copy. An attachment whose bytes have not been mirrored yet is a 404 too --
 * there is nothing to serve, and waiting on a live fetch would be a request
 * that usually fails.
 */
async function handleAttachment(
  env: Env,
  session: Session,
  attachmentId: number
): Promise<Response> {
  const bucket = env.WORKORDER_FILES;
  if (!bucket) return jsonError(503, "attachment storage not configured");

  const email = session.email?.trim().toLowerCase() ?? "";
  if (!email) return jsonError(401, "no session email");

  // One read: the attachment plus the owning work order's location, via the
  // FK embed. Doing it in two would open a window where the second answer no
  // longer matches the first.
  // Both parents are embedded with !left, not !inner. An attachment has
  // exactly one (CHECK-enforced), so an inner join on either would drop every
  // row belonging to the other kind -- which would have made request photos
  // 404 while looking like a permission failure.
  const url =
    `${env.SUPABASE_URL}/rest/v1/mx_work_order_attachment` +
    `?select=id,work_order_id,work_request_id,r2_key,mime_type,file_name,` +
    `mx_work_order!left(mx_location_id,deleted_at),` +
    `mx_work_request!left(mx_location_id)` +
    `&id=eq.${attachmentId}` +
    `&limit=1`;

  let rows: Array<{
    r2_key: string | null;
    mime_type: string | null;
    file_name: string | null;
    mx_work_order: { mx_location_id: number | null; deleted_at: string | null } | null;
    mx_work_request: { mx_location_id: number | null } | null;
  }>;
  try {
    const res = await fetch(url, {
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`
      }
    });
    if (!res.ok) return jsonError(502, "attachment lookup failed");
    rows = await res.json();
  } catch {
    return jsonError(504, "attachment lookup timeout");
  }

  const row = rows[0];
  if (!row || !row.r2_key) return jsonError(404, "not found");

  // Resolve the location through whichever parent this attachment has. A
  // soft-deleted work order is treated as absent -- serving photos for a work
  // order the list will not show would leak past the page's own filter.
  let locationId: number | null = null;
  if (row.mx_work_order) {
    if (row.mx_work_order.deleted_at !== null) return jsonError(404, "not found");
    locationId = row.mx_work_order.mx_location_id;
  } else if (row.mx_work_request) {
    locationId = row.mx_work_request.mx_location_id;
  }
  if (locationId === null) return jsonError(404, "not found");

  const accessible = await getLocationsByContactEmail(env, email);
  const allowed = new Set(accessibleMxIdsOf(accessible));
  if (!allowed.has(locationId)) return jsonError(404, "not found");

  const object = await bucket.get(row.r2_key);
  if (!object) {
    // The row claims a copy the bucket does not have. Loud, because it means
    // the two have drifted -- r2_key is written only after the PUT resolves,
    // so this should be unreachable.
    console.error(`[mx-attach] r2 miss for key ${row.r2_key} (attachment ${attachmentId})`);
    return jsonError(404, "not found");
  }

  const headers = new Headers();
  headers.set("Content-Type", row.mime_type ?? "application/octet-stream");
  // Private: the response is scoped to one operator's permissions, so a shared
  // cache must never hold it. Immutable because a MaintainX attachment id
  // always names the same bytes.
  headers.set("Cache-Control", "private, max-age=3600, immutable");
  headers.set("X-Content-Type-Options", "nosniff");
  if (row.file_name) {
    headers.set("Content-Disposition", `inline; filename="${sanitizeFilename(row.file_name)}"`);
  }
  return new Response(object.body, { status: 200, headers });
}

async function handleList(
  env: Env,
  session: Session,
  source: ReadSource = "maintainx"
): Promise<Response> {
  const email = session.email?.trim().toLowerCase() ?? "";
  if (!email) return jsonError(401, "no session email");

  // Only the MaintainX path needs the bearer token. The Postgres path reads a
  // mirror that the ingest and webhook receiver filled earlier, so an unbound
  // key stops the data going stale but does not stop the page rendering --
  // which is one of the reasons for having the mirror at all.
  if (source === "maintainx" && !env.MAINTAINX_API_KEY) {
    return jsonError(503, "MaintainX integration not configured");
  }

  // Phase 1 — resolve user's accessible locations via email match.
  const accessible = await getLocationsByContactEmail(env, email);
  const mappedMxIds = accessibleMxIdsOf(accessible);

  // Brief 74 — operator's MaintainX `full_name` for the New Request tab's
  // requester-name default. Fail-soft: null when no row matches the
  // session email; apps/web falls back to an empty default.
  const mxUser = await getMaintainXUserByEmail(env, email).catch(() => null);
  const currentUser: CurrentUserOut = {
    email,
    full_name: mxUser?.full_name ?? null
  };

  const fetchedAt = new Date().toISOString();
  if (mappedMxIds.length === 0) {
    return json({
      reactive: { groups: [] },
      preventive: { groups: [] },
      requests: { groups: [] },
      fetchedAt,
      truncated: false,
      requestsTruncated: false,
      pageCount: 0,
      accessibleLocationCount: accessible.length,
      mappedLocationCount: 0,
      email,
      accessibleLocations: buildAccessibleLocations(accessible, new Map()),
      currentUser,
      source,
      // No locations means no denominator. Null, not a zeroed bucket -- a
      // caller cannot tell 0/0 from "we failed to look" once it is rendered.
      pmOnTime: null
    } satisfies ListResponse);
  }

  // Phase 2 — fetch MaintainX work orders AND work requests for those
  // location IDs, concurrently. Brief 72: multi-location WO users
  // paginate the cursor; single-location users keep the single-call
  // posture. Brief 80: the work-requests fetch runs in parallel under
  // its own AbortController/timeout so it neither delays nor aborts the
  // WO fetch — and a request-side failure is non-fatal (the WO tabs
  // still render).
  const shouldPaginate = mappedMxIds.length > 1;
  const timeoutMs = shouldPaginate ? TIMEOUT_MULTI_MS : TIMEOUT_SINGLE_MS;
  const maxWorkOrders = shouldPaginate ? MAX_WORK_ORDERS_MULTI : MAX_WORK_ORDERS_SINGLE;

  const woController = new AbortController();
  const woTimeout = setTimeout(() => woController.abort(), timeoutMs);
  const requestsController = new AbortController();
  const requestsTimeout = setTimeout(
    () => requestsController.abort(),
    TIMEOUT_REQUESTS_MS
  );

  // Structurally typed rather than importing either source's result type: the
  // point is that the two are interchangeable here, and naming one of them
  // would suggest the other is the special case.
  let result: {
    ok: boolean;
    workOrders: RawWorkOrder[];
    truncated: boolean;
    pageCount: number;
    status: number;
  };
  let requestsResult: {
    ok: boolean;
    workRequests: RawWorkRequest[];
    truncated: boolean;
    pageCount: number;
  };

  let extrasById = new Map<number, PgWorkOrderExtras>();
  let requestAttachmentsById = new Map<number, AttachmentOut[]>();

  if (source === "postgres") {
    // One round trip each, no cursor walk, no upstream timeout to bound --
    // so the AbortControllers above are simply not used on this path.
    const [pgWorkOrders, pgRequests] = await Promise.all([
      // No row cap passed on purpose. MAX_WORK_ORDERS_SINGLE / _MULTI exist
      // because of MaintainX's paging, and inheriting them here re-imposed a
      // 200-row limit on single-location operators for no reason. The Postgres
      // reader pages to exhaustion against its own safety ceiling.
      fetchWorkOrdersFromPg({
        env,
        maintainxLocationIds: mappedMxIds
      }),
      fetchWorkRequestsFromPg({
        env,
        maintainxLocationIds: mappedMxIds
      })
    ]);
    result = pgWorkOrders;
    requestsResult = pgRequests;
    // Comments and costs ride along from the same query. Read off the
    // concrete return rather than widening `result`, which is deliberately
    // only the shape both sources share.
    extrasById = pgWorkOrders.extrasById;
    requestAttachmentsById = pgRequests.attachmentsById;
    clearTimeout(woTimeout);
    clearTimeout(requestsTimeout);
  } else {
    // The early return above already rejected an unbound key on this path.
    // Re-checking rather than asserting keeps the guarantee local: if that
    // guard is ever narrowed, this fails loudly here instead of sending
    // `undefined` as a bearer token and reading the 401 as an outage.
    const apiKey = env.MAINTAINX_API_KEY;
    if (!apiKey) return jsonError(503, "MaintainX integration not configured");

    try {
      [result, requestsResult] = await Promise.all([
        fetchMaintainXWorkOrders({
          apiKey,
          baseUrl: env.MAINTAINX_BASE_URL,
          maintainxLocationIds: mappedMxIds,
          paginate: shouldPaginate,
          maxWorkOrders,
          signal: woController.signal
        }),
        fetchMaintainXWorkRequests({
          apiKey,
          baseUrl: env.MAINTAINX_BASE_URL,
          maintainxLocationIds: mappedMxIds,
          // Docs confirm `statuses=` on /workrequests — pre-filter to the
          // two we surface so the cursor walk skips APPROVED/DONE entirely.
          statuses: Array.from(REQUEST_VISIBLE_STATUSES),
          maxWorkRequests: MAX_WORK_REQUESTS,
          signal: requestsController.signal
        })
      ]);
    } finally {
      clearTimeout(woTimeout);
      clearTimeout(requestsTimeout);
    }
  }

  if (!result.ok) {
    const upstream = source === "postgres" ? "Postgres" : "MaintainX";
    if (result.status === 0) return jsonError(504, `${upstream} timeout`);
    return jsonError(502, `${upstream} upstream returned ${result.status}`);
  }

  // Brief 80 — filter work requests to the visible statuses (PENDING /
  // REJECTED) AND the user's mapped locations. The fetch already sends
  // `locations=` and `statuses=` server-side (both confirmed), but we
  // re-apply the same gate here as defense-in-depth — the location gate
  // in particular must never depend solely on an upstream param.
  // A failed request fetch (`requestsResult.ok === false`) degrades to an
  // empty Requests tab rather than failing the whole page.
  const mappedMxIdSet = new Set<number>(mappedMxIds);
  const visibleRequests: RawWorkRequest[] = requestsResult.ok
    ? requestsResult.workRequests.filter((wr) => {
        const status =
          typeof wr.requestStatus === "string"
            ? wr.requestStatus.toUpperCase()
            : "";
        if (!REQUEST_VISIBLE_STATUSES.has(status)) return false;
        const locId = extractRequestLocationId(wr);
        return locId != null && mappedMxIdSet.has(locId);
      })
    : [];

  // Phase 3 — resolve assignee + team names from the Supabase cache.
  // Brief 80: request creator IDs share the `maintainx_users` cache, so
  // fold them into the single users lookup.
  const userIds = collectAssigneeIdsByType(result.workOrders, "USER");
  for (const id of collectRequestCreatorIds(visibleRequests)) {
    if (!userIds.includes(id)) userIds.push(id);
  }
  // Comment authors share the same cache. Without this every comment renders
  // unattributed, which is the kind of thing that looks like a data problem
  // rather than a missing lookup.
  for (const extras of extrasById.values()) {
    for (const c of extras.comments) {
      if (c.authorId != null && !userIds.includes(c.authorId)) userIds.push(c.authorId);
    }
  }
  const teamIds = collectAssigneeIdsByType(result.workOrders, "TEAM");
  const [users, teams] = await Promise.all([
    userIds.length ? getMaintainXUsersByIds(env, userIds) : Promise.resolve(new Map<number, MaintainXUserRow>()),
    teamIds.length ? getMaintainXTeamsByIds(env, teamIds) : Promise.resolve(new Map<number, MaintainXTeamRow>())
  ]);

  // Phase 4 — bucket Reactive vs Preventive, then group each bucket.
  const buckets = bucketByType(result.workOrders);
  // Keyed by canonical id AND by every alias, so a work order filed against a
  // MaintainX sub-location still resolves to the site that owns it. Aliases go
  // in first and never overwrite, so a canonical id always wins the key.
  const accessibleByMxId = new Map<number, UserAccessibleLocation>();
  for (const loc of accessible) {
    for (const alias of loc.maintainx_alias_ids) {
      if (!accessibleByMxId.has(alias)) accessibleByMxId.set(alias, loc);
    }
  }
  for (const loc of accessible) {
    if (loc.maintainx_id != null) accessibleByMxId.set(loc.maintainx_id, loc);
  }
  const reactive = groupByLocation(buckets.reactive, users, teams, accessibleByMxId, extrasById);
  const preventive = groupByLocation(
    buckets.preventive,
    users,
    teams,
    accessibleByMxId,
    extrasById
  );

  // Brief 74 — harvest MX-side location names so the New Request tab's
  // Location dropdown (and Brief 80's request group headers) can label
  // entries with the human-readable name MX uses internally. Requests
  // contribute names too (via `expand=location` when honored), covering
  // a location that has requests but no open work orders.
  const mxNamesByLocId = new Map<number, string>();
  for (const wo of result.workOrders) {
    const id = extractRawLocationId(wo);
    if (id == null || mxNamesByLocId.has(id)) continue;
    const name = extractRawLocationName(wo);
    if (name) mxNamesByLocId.set(id, name);
  }
  for (const wr of visibleRequests) {
    const id = extractRequestLocationId(wr);
    if (id == null || mxNamesByLocId.has(id)) continue;
    const name = extractRequestLocationName(wr);
    if (name) mxNamesByLocId.set(id, name);
  }

  // Brief 80 — group the visible requests by location, same header
  // resolution (MX name → Splash address → placeholder) as the WO
  // buckets.
  const requestGroups = groupRequestsByLocation(
    visibleRequests,
    users,
    accessibleByMxId,
    requestAttachmentsById
  );

  // Only the mirror can answer this: it needs COMPLETED work orders, which the
  // MaintainX list path does not fetch. Fail-soft -- a null here costs a
  // percentage, an exception would cost the whole list.
  const pmOnTime =
    source === "postgres"
      ? await fetchPmOnTime({ env, mxLocationIds: mappedMxIds })
      : null;

  console.log(
    `workorders-worker list: source=${source} email=${email} mappedMxIds=${mappedMxIds.length} paginate=${shouldPaginate} pageCount=${result.pageCount} workOrders=${result.workOrders.length} truncated=${result.truncated} droppedOverduePreventive=${buckets.droppedOverduePreventive} requestsOk=${requestsResult.ok} requestsPageCount=${requestsResult.pageCount} requestsFetched=${requestsResult.workRequests.length} requestsVisible=${visibleRequests.length} requestsTruncated=${requestsResult.truncated} pmOnTime=${pmOnTime ? `${pmOnTime.overall.onTime}/${pmOnTime.overall.due}` : "null"}`
  );

  return json({
    reactive: { groups: reactive },
    preventive: { groups: preventive },
    requests: { groups: requestGroups },
    fetchedAt,
    truncated: result.truncated,
    requestsTruncated: requestsResult.ok ? requestsResult.truncated : false,
    pageCount: result.pageCount,
    accessibleLocationCount: accessible.length,
    mappedLocationCount: mappedMxIds.length,
    email,
    accessibleLocations: buildAccessibleLocations(accessible, mxNamesByLocId),
    currentUser,
    source,
    pmOnTime
  } satisfies ListResponse);
}

/**
 * Every MaintainX location id a user can see: each site's canonical
 * `maintainx_id` plus any `maintainx_alias_ids`. A site can answer to more
 * than one id -- MaintainX models Long Pond as a parent node with two tunnel
 * children while we model it as a single site -- and filtering on the
 * canonical id alone silently dropped the other tunnel's work orders from
 * the list without ever reporting an error.
 */
function accessibleMxIdsOf(accessible: UserAccessibleLocation[]): number[] {
  const seen = new Set<number>();
  for (const loc of accessible) {
    if (typeof loc.maintainx_id === "number" && Number.isFinite(loc.maintainx_id)) {
      seen.add(loc.maintainx_id);
    }
    for (const alias of loc.maintainx_alias_ids) {
      if (typeof alias === "number" && Number.isFinite(alias)) seen.add(alias);
    }
  }
  return [...seen];
}

function buildAccessibleLocations(
  accessible: UserAccessibleLocation[],
  mxNamesByLocId: Map<number, string>
): AccessibleLocationOut[] {
  return accessible.map((loc) => ({
    maintainx_id: loc.maintainx_id,
    location_address: loc.location_address,
    location_name:
      loc.maintainx_id != null
        ? mxNamesByLocId.get(loc.maintainx_id) ?? null
        : null
  }));
}

/* ============================================================
 * Bucketing + grouping helpers
 * ============================================================ */

/**
 * Canonical filter is `wo.type === "PREVENTIVE"`. Everything else
 * (REACTIVE, CYCLE_COUNT, null, unknowns) lands in the Reactive bucket
 * — operators day-to-day work the reactive queue. If MaintainX adds new
 * preventive-flavored types (e.g. "PREVENTIVE_DAILY"), widen this rule
 * to `type?.startsWith("PREVENT")` after operator confirmation.
 *
 * Brief 79: Preventive WOs whose `dueDate` is more than
 * `PREVENTATIVE_MAX_OVERDUE_DAYS` past today (UTC day-floor) are
 * dropped — they don't land in either bucket. NULL / malformed
 * dueDate Preventive WOs are kept. `droppedOverduePreventive` returns
 * the count for observability logging at the call site.
 */
function bucketByType(workOrders: RawWorkOrder[]): {
  reactive: RawWorkOrder[];
  preventive: RawWorkOrder[];
  droppedOverduePreventive: number;
} {
  const reactive: RawWorkOrder[] = [];
  const preventive: RawWorkOrder[] = [];
  let droppedOverduePreventive = 0;
  const nowMs = Date.now();
  const todayUtc = Math.floor(nowMs / 86_400_000);
  for (const wo of workOrders) {
    if (typeof wo.type === "string" && wo.type === "PREVENTIVE") {
      // Brief 79 — drop preventives more than 90 days overdue.
      if (typeof wo.dueDate === "string" && wo.dueDate.length > 0) {
        const dueMs = Date.parse(wo.dueDate);
        if (Number.isFinite(dueMs)) {
          const dueUtc = Math.floor(dueMs / 86_400_000);
          if (todayUtc - dueUtc > PREVENTATIVE_MAX_OVERDUE_DAYS) {
            droppedOverduePreventive += 1;
            continue;
          }
        }
      }
      preventive.push(wo);
    } else {
      reactive.push(wo);
    }
  }
  return { reactive, preventive, droppedOverduePreventive };
}

function collectAssigneeIdsByType(workOrders: RawWorkOrder[], type: "USER" | "TEAM"): number[] {
  const out = new Set<number>();
  for (const wo of workOrders) {
    if (!Array.isArray(wo.assignees)) continue;
    for (const a of wo.assignees) {
      if (!a || typeof a !== "object") continue;
      const t = typeof a.type === "string" ? a.type : null;
      if (t !== type) continue;
      const id = typeof a.id === "number" && Number.isFinite(a.id) ? a.id : null;
      if (id != null) out.add(id);
    }
  }
  return [...out];
}

/**
 * Brief 79 — Preventive WOs whose `dueDate` is more than this many
 * days in the past are dropped from the response. The Preventative
 * tab on /workorders accumulates a long tail of stale auto-spawned
 * MaintainX preventive cycles; this trim keeps the tab focused on
 * what an operator can act on. NULL dueDate / unparseable dueDate
 * Preventive WOs are KEPT — only dated rows past the threshold
 * drop. Reactive WOs are never filtered (their dueDate is
 * MaintainX-auto-set to creation-day and not operationally
 * meaningful).
 */
const PREVENTATIVE_MAX_OVERDUE_DAYS = 90;

const PRIORITY_NONE_RANK = 3;
const PRIORITY_ORDER: Record<string, number> = {
  HIGH: 0,
  MEDIUM: 1,
  LOW: 2,
  NONE: PRIORITY_NONE_RANK
};

function priorityRank(p: string | null | undefined): number {
  if (typeof p !== "string") return PRIORITY_NONE_RANK;
  return PRIORITY_ORDER[p] ?? PRIORITY_NONE_RANK;
}

function compareWorkOrders(a: WorkOrderOut, b: WorkOrderOut): number {
  const pa = priorityRank(a.priority);
  const pb = priorityRank(b.priority);
  if (pa !== pb) return pa - pb;
  const ua = a.updatedAt ?? "";
  const ub = b.updatedAt ?? "";
  if (ua === ub) return 0;
  return ua < ub ? 1 : -1;
}

function compareGroups(a: GroupOut, b: GroupOut): number {
  return a.location_pretty.localeCompare(b.location_pretty);
}

function groupByLocation(
  workOrders: RawWorkOrder[],
  users: Map<number, MaintainXUserRow>,
  teams: Map<number, MaintainXTeamRow>,
  accessibleByMxId: Map<number, UserAccessibleLocation>,
  /** Comments + costs by work order id. Empty on the MaintainX path, which is
   *  why every consumer treats absence as "none" rather than an error. */
  extrasById: Map<number, PgWorkOrderExtras> = new Map()
): GroupOut[] {
  const buckets = new Map<number, { header: string; items: WorkOrderOut[] }>();
  for (const wo of workOrders) {
    const extras = typeof wo.id === "number" ? extrasById.get(wo.id) : undefined;
    const projected = projectWorkOrder(wo, users, teams, extras);
    if (!projected) continue;
    const mxIdRaw = projected.locationId;
    if (mxIdRaw == null) continue;
    // One site can answer to several MaintainX location ids (see
    // `locations.maintainx_alias_ids`). `accessibleByMxId` is keyed by the
    // canonical id and by every alias, so this folds an alias back onto the
    // site that owns it and Long Pond's two tunnels render as one group
    // rather than two. An id we do not recognise falls through unchanged and
    // groups on its own, exactly as before.
    const mxId = accessibleByMxId.get(mxIdRaw)?.maintainx_id ?? mxIdRaw;
    // Only a work order filed against the canonical id may name the group.
    // Otherwise Long Pond's header would read "Longpond Tunnel B" whenever a
    // sub-location work order happened to sort first.
    const mayNameGroup = mxIdRaw === mxId;

    let bucket = buckets.get(mxId);
    if (!bucket) {
      const headerFromMx = mayNameGroup ? extractRawLocationName(wo) : null;
      const fallbackAddress = accessibleByMxId.get(mxId)?.location_address ?? null;
      bucket = {
        header: headerFromMx ?? fallbackAddress ?? "(unknown location)",
        items: []
      };
      buckets.set(mxId, bucket);
    } else if (
      bucket.header === "(unknown location)" ||
      bucket.header === (accessibleByMxId.get(mxId)?.location_address ?? "")
    ) {
      // Upgrade the header if a later WO in this bucket carries the
      // MaintainX-side name (Brief 71 prefers MX's name when available).
      const headerFromMx = mayNameGroup ? extractRawLocationName(wo) : null;
      if (headerFromMx) bucket.header = headerFromMx;
    }
    bucket.items.push(projected);
  }

  const groups: GroupOut[] = [];
  for (const [mxId, b] of buckets.entries()) {
    b.items.sort(compareWorkOrders);
    groups.push({
      maintainx_id: mxId,
      location_pretty: b.header,
      work_orders: b.items
    });
  }
  groups.sort(compareGroups);
  return groups;
}

/* ============================================================
 * Projection — RawWorkOrder → WorkOrderOut with name decoration.
 * ============================================================ */

function extractRawLocationId(wo: RawWorkOrder): number | null {
  if (typeof wo.locationId === "number" && Number.isFinite(wo.locationId)) {
    return wo.locationId;
  }
  if (wo.location && typeof wo.location.id === "number" && Number.isFinite(wo.location.id)) {
    return wo.location.id;
  }
  return null;
}

function extractRawLocationName(wo: RawWorkOrder): string | null {
  if (wo.location && typeof wo.location.name === "string" && wo.location.name) {
    return wo.location.name;
  }
  return null;
}

function projectAssignees(
  raw: RawWorkOrder["assignees"],
  users: Map<number, MaintainXUserRow>,
  teams: Map<number, MaintainXTeamRow>
): AssigneeOut[] {
  if (!Array.isArray(raw)) return [];
  const out: AssigneeOut[] = [];
  for (const a of raw) {
    if (!a || typeof a !== "object") continue;
    const id = typeof a.id === "number" && Number.isFinite(a.id) ? a.id : null;
    const rawType = typeof a.type === "string" ? a.type : null;
    let type: AssigneeOut["type"] = "OTHER";
    let name = "";
    let email: string | null = null;
    if (rawType === "USER") {
      type = "USER";
      const cached = id != null ? users.get(id) : undefined;
      name = cached?.full_name?.trim() || (id != null ? `User #${id}` : "Unknown user");
      email = cached?.email ?? null;
    } else if (rawType === "TEAM") {
      type = "TEAM";
      const cached = id != null ? teams.get(id) : undefined;
      name = cached?.name?.trim() || (id != null ? `Team #${id}` : "Unknown team");
    } else {
      name = id != null ? `Assignee #${id}` : "Unknown";
    }
    out.push({ id, type, name, email });
  }
  return out;
}

function projectCategories(raw: RawWorkOrder["categories"]): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const c of raw) {
    if (typeof c === "string") {
      if (c) out.push(c);
    } else if (c && typeof c === "object" && typeof c.name === "string" && c.name) {
      out.push(c.name);
    }
  }
  return out;
}

function projectWorkOrder(
  wo: RawWorkOrder,
  users: Map<number, MaintainXUserRow>,
  teams: Map<number, MaintainXTeamRow>,
  extras?: PgWorkOrderExtras
): WorkOrderOut | null {
  if (typeof wo.id !== "number" || !Number.isFinite(wo.id)) return null;
  return {
    id: wo.id,
    sequentialId: typeof wo.sequentialId === "number" ? wo.sequentialId : null,
    title: typeof wo.title === "string" ? wo.title : "",
    status: typeof wo.status === "string" ? wo.status : "",
    priority: typeof wo.priority === "string" ? wo.priority : "NONE",
    type: typeof wo.type === "string" ? wo.type : null,
    createdAt: typeof wo.createdAt === "string" ? wo.createdAt : null,
    updatedAt: typeof wo.updatedAt === "string" ? wo.updatedAt : null,
    dueDate: typeof wo.dueDate === "string" ? wo.dueDate : null,
    description: typeof wo.description === "string" && wo.description.trim()
      ? wo.description.trim()
      : null,
    assignees: projectAssignees(wo.assignees, users, teams),
    categories: projectCategories(wo.categories),
    locationId: extractRawLocationId(wo),
    comments: projectComments(extras, users),
    commentsTruncated: extras?.commentsTruncated ?? false,
    cost: projectCost(extras),
    attachments: extras?.attachments ?? []
  };
}

function projectComments(
  extras: PgWorkOrderExtras | undefined,
  users: Map<number, MaintainXUserRow>
): CommentOut[] {
  if (!extras) return [];
  return extras.comments.map((c) => ({
    id: String(c.id),
    author: c.authorId != null ? (users.get(c.authorId)?.full_name ?? null) : null,
    content: c.content,
    createdAt: c.createdAt
  }));
}

/**
 * Cost, or null when there is nothing to show.
 *
 * "Nothing to show" is every total being zero AND no line items -- not merely
 * a zero total. A work order can carry parts whose unit costs are all zero,
 * and hiding those would lose the fact that parts were used at all.
 */
function projectCost(extras: PgWorkOrderExtras | undefined): CostOut | null {
  if (!extras) return null;
  const partCents = extras.partCostCents ?? 0;
  const expenditureCents = extras.expenditureCents ?? 0;
  const totalCents = extras.totalCostCents ?? 0;
  const hasLines = extras.parts.length > 0 || extras.expenditures.length > 0;
  if (partCents === 0 && expenditureCents === 0 && totalCents === 0 && !hasLines) {
    return null;
  }
  return {
    partCents,
    expenditureCents,
    totalCents,
    laborSeconds: extras.laborSeconds,
    parts: extras.parts,
    expenditures: extras.expenditures
  };
}

/* ============================================================
 * Brief 80 — Work Request grouping + projection.
 * ============================================================ */

function extractRequestLocationId(wr: RawWorkRequest): number | null {
  if (typeof wr.locationId === "number" && Number.isFinite(wr.locationId)) {
    return wr.locationId;
  }
  if (wr.location && typeof wr.location.id === "number" && Number.isFinite(wr.location.id)) {
    return wr.location.id;
  }
  return null;
}

function extractRequestLocationName(wr: RawWorkRequest): string | null {
  if (wr.location && typeof wr.location.name === "string" && wr.location.name) {
    return wr.location.name;
  }
  return null;
}

function collectRequestCreatorIds(requests: RawWorkRequest[]): number[] {
  const out = new Set<number>();
  for (const wr of requests) {
    if (typeof wr.creatorId === "number" && Number.isFinite(wr.creatorId)) {
      out.add(wr.creatorId);
    }
  }
  return [...out];
}

function projectWorkRequestWithAttachments(
  wr: RawWorkRequest,
  users: Map<number, MaintainXUserRow>,
  attachmentsById: Map<number, AttachmentOut[]>
): WorkRequestOut | null {
  const projected = projectWorkRequest(wr, users);
  if (!projected) return null;
  const id = typeof wr.id === "number" ? wr.id : null;
  return {
    ...projected,
    attachments: (id !== null ? attachmentsById.get(id) : undefined) ?? []
  };
}

/** Everything except photos, which only the Postgres path can supply -- the
 *  wrapper above adds them. */
function projectWorkRequest(
  wr: RawWorkRequest,
  users: Map<number, MaintainXUserRow>
): Omit<WorkRequestOut, "attachments"> | null {
  if (typeof wr.id !== "number" || !Number.isFinite(wr.id)) return null;
  const creatorId =
    typeof wr.creatorId === "number" && Number.isFinite(wr.creatorId)
      ? wr.creatorId
      : null;
  let creator: RequestCreatorOut | null = null;
  if (creatorId != null) {
    const cached = users.get(creatorId);
    creator = {
      id: creatorId,
      name: cached?.full_name?.trim() || `User #${creatorId}`,
      email: cached?.email ?? null
    };
  }
  return {
    id: wr.id,
    title: typeof wr.title === "string" ? wr.title : "",
    status: typeof wr.requestStatus === "string" ? wr.requestStatus.toUpperCase() : "",
    priority: typeof wr.priority === "string" ? wr.priority : "NONE",
    createdAt: typeof wr.createdAt === "string" ? wr.createdAt : null,
    updatedAt: typeof wr.updatedAt === "string" ? wr.updatedAt : null,
    description:
      typeof wr.description === "string" && wr.description.trim()
        ? wr.description.trim()
        : null,
    locationId: extractRequestLocationId(wr),
    workOrderId:
      typeof wr.workOrderId === "number" && Number.isFinite(wr.workOrderId)
        ? wr.workOrderId
        : null,
    creator
  };
}

function compareWorkRequests(a: WorkRequestOut, b: WorkRequestOut): number {
  const pa = priorityRank(a.priority);
  const pb = priorityRank(b.priority);
  if (pa !== pb) return pa - pb;
  const ua = a.updatedAt ?? "";
  const ub = b.updatedAt ?? "";
  if (ua === ub) return 0;
  return ua < ub ? 1 : -1;
}

function groupRequestsByLocation(
  requests: RawWorkRequest[],
  users: Map<number, MaintainXUserRow>,
  accessibleByMxId: Map<number, UserAccessibleLocation>,
  /** Mirrored photos by request id. Empty on the MaintainX path, which is why
   *  every consumer treats absence as "none" rather than an error. */
  attachmentsById: Map<number, AttachmentOut[]> = new Map()
): RequestGroupOut[] {
  const buckets = new Map<number, { header: string; items: WorkRequestOut[] }>();
  for (const wr of requests) {
    const projected = projectWorkRequestWithAttachments(wr, users, attachmentsById);
    if (!projected) continue;
    const mxIdRaw = projected.locationId;
    if (mxIdRaw == null) continue;
    // Same alias fold as groupByLocation -- see the comment there.
    const mxId = accessibleByMxId.get(mxIdRaw)?.maintainx_id ?? mxIdRaw;
    const mayNameGroup = mxIdRaw === mxId;

    let bucket = buckets.get(mxId);
    if (!bucket) {
      const headerFromMx = mayNameGroup ? extractRequestLocationName(wr) : null;
      const fallbackAddress = accessibleByMxId.get(mxId)?.location_address ?? null;
      bucket = {
        header: headerFromMx ?? fallbackAddress ?? "(unknown location)",
        items: []
      };
      buckets.set(mxId, bucket);
    } else if (
      bucket.header === "(unknown location)" ||
      bucket.header === (accessibleByMxId.get(mxId)?.location_address ?? "")
    ) {
      const headerFromMx = mayNameGroup ? extractRequestLocationName(wr) : null;
      if (headerFromMx) bucket.header = headerFromMx;
    }
    bucket.items.push(projected);
  }

  const groups: RequestGroupOut[] = [];
  for (const [mxId, b] of buckets.entries()) {
    b.items.sort(compareWorkRequests);
    groups.push({
      maintainx_id: mxId,
      location_pretty: b.header,
      work_requests: b.items
    });
  }
  groups.sort((a, b) => a.location_pretty.localeCompare(b.location_pretty));
  return groups;
}

/* ============================================================
 * Brief 74 / Brief 75 / Brief 76 — POST /workorders/api/request:
 * create MaintainX work request + up to 5 photos (1 thumbnail + 4
 * attachments).
 *
 * Posture (mirrors Brief 37/38's damage-document upload path):
 *   - Plain HTML form posts here as multipart/form-data — bypasses
 *     Next 15 server actions (the OpenNext-on-CF-Workers runtime
 *     has flaky multipart-server-action behavior; the legacy plain-
 *     form path is reliable on iPhone Safari and Chrome alike).
 *   - Email-on-locations gate: same `getLocationsByContactEmail`
 *     membership check as the read path. No location → 403-shaped
 *     redirect.
 *   - On success: 303 redirect to apps/web's /workorders?tab=new
 *     &request_ok=<id> (with optional &request_warn=N-of-M-photos-failed
 *     when some uploads failed post-create). Failure: same redirect
 *     with request_error query.
 *   - Per-upload AbortController timeout: 15s. The handler can run
 *     for up to ~90s (1 create × 15s + 5 uploads × 15s) — acceptable
 *     for a user-driven submit.
 *
 * Brief 75 (2026-05-08): retired Brief 74's multi-photo path on the
 * (wrong) assumption that work requests only support a thumbnail.
 *
 * Brief 76 (2026-05-08): the actual MaintainX URL is
 * /v1/workrequests/{id}/attachments/{filename} — plural. Brief 74
 * built it singular based on the doc heading text. Multi-photo
 * restored: photo[0] → thumbnail, photo[1..4] → attachments.
 * Phone-required from Brief 75 is preserved.
 * ============================================================ */

const REQUEST_REDIRECT_PATH = "/workorders";
const REQUEST_REDIRECT_TAB = "new";
const REQUEST_ERROR_MAX_LEN = 240;
const REQUEST_TITLE_MAX_LEN = 120;
const REQUEST_DESCRIPTION_MAX_LEN = 4000;
const REQUEST_REQUESTER_NAME_MAX_LEN = 80;
const REQUEST_REQUESTER_PHONE_MAX_LEN = 30;
const REQUEST_FILENAME_MAX_LEN = 80;
const REQUEST_PHOTO_MAX_BYTES = 15 * 1024 * 1024; // 15 MB
const REQUEST_MAX_PHOTOS = 5;
const REQUEST_PER_UPLOAD_TIMEOUT_MS = 15_000;
const REQUEST_CREATE_TIMEOUT_MS = 15_000;
const REQUEST_ALLOWED_PRIORITIES = new Set<"HIGH" | "MEDIUM" | "LOW">([
  "HIGH",
  "MEDIUM",
  "LOW"
]);

function buildRequestRedirect(
  request: Request,
  errorMessage: string | null,
  successId: number | null = null,
  warning: string | null = null
): Response {
  const originHeader = request.headers.get("Origin");
  const origin =
    originHeader && /^https?:\/\//.test(originHeader)
      ? originHeader
      : new URL(request.url).origin;

  const params = new URLSearchParams();
  params.set("tab", REQUEST_REDIRECT_TAB);
  if (successId != null) {
    params.set("request_ok", String(successId));
    if (warning) {
      // Brief 76: `photo_warn=N-of-M-photos-failed` stacks under the
      // success banner client-side. Brief 75 used `request_warn` for the
      // same purpose; rename matches the brief's spec and avoids
      // overloading "request_*" with both error- and photo-fail
      // semantics.
      params.set(
        "photo_warn",
        warning.slice(0, REQUEST_ERROR_MAX_LEN)
      );
    }
  } else if (errorMessage) {
    params.set(
      "request_error",
      errorMessage.slice(0, REQUEST_ERROR_MAX_LEN)
    );
  }
  return Response.redirect(
    `${origin}${REQUEST_REDIRECT_PATH}?${params.toString()}`,
    303
  );
}

function sanitizeFilename(rawName: string): string {
  // Strip leading dots so a hidden file ("..bashrc") doesn't slip through;
  // anything outside [a-zA-Z0-9._-] becomes "_". Lowercase the extension
  // so "IMG.JPEG" and "img.jpeg" sort equivalently. Cap at 80 chars while
  // preserving the extension.
  let name = rawName.replace(/^\.+/, "");
  if (!name) name = "photo";
  // Split off extension (last dot only).
  const lastDot = name.lastIndexOf(".");
  let stem = lastDot > 0 ? name.slice(0, lastDot) : name;
  let ext = lastDot > 0 ? name.slice(lastDot + 1).toLowerCase() : "";
  stem = stem.replace(/[^a-zA-Z0-9._-]/g, "_");
  // Brief 76: collapse runs of consecutive underscores so "download (2).jpg"
  // → "download_2_.jpg" → "download_2_.jpg" instead of the awkward
  // "download__2_.jpg".
  stem = stem.replace(/_+/g, "_");
  ext = ext.replace(/[^a-zA-Z0-9]/g, "");
  let combined = ext ? `${stem}.${ext}` : stem;
  // Brief 76: trim a trailing "_" right before the extension —
  // "download_2_.jpg" → "download_2.jpg".
  if (ext) combined = combined.replace(/_+(\.[^.]+)$/, "$1");
  if (combined.length > REQUEST_FILENAME_MAX_LEN) {
    const cutTo = REQUEST_FILENAME_MAX_LEN - (ext ? ext.length + 1 : 0);
    const stemTrim = stem.slice(0, Math.max(1, cutTo));
    combined = ext ? `${stemTrim}.${ext}` : stemTrim;
    if (ext) combined = combined.replace(/_+(\.[^.]+)$/, "$1");
  }
  return combined || "photo";
}

async function handleCreateRequest(
  request: Request,
  env: Env,
  session: Session
): Promise<Response> {
  if (!isOriginAllowed(request)) {
    return buildRequestRedirect(request, "Bad origin.");
  }

  const email = session.email?.trim().toLowerCase() ?? "";
  if (!email) {
    return buildRequestRedirect(request, "Sign in to file a work request.");
  }

  if (!env.MAINTAINX_API_KEY) {
    return buildRequestRedirect(
      request,
      "MaintainX integration not configured."
    );
  }

  const ctype = request.headers.get("content-type") ?? "";
  if (!ctype.includes("multipart/form-data")) {
    return buildRequestRedirect(
      request,
      "Work request must be multipart/form-data."
    );
  }

  // Email-on-locations gate (defense-in-depth alongside apps/web's
  // dropdown filter). Filing a request requires at least one mapped
  // location; super_admin / admin without their email on a locations
  // row are rejected here, matching the read path.
  const accessible = await getLocationsByContactEmail(env, email);
  const accessibleMxIds = new Set<number>(accessibleMxIdsOf(accessible));
  if (accessibleMxIds.size === 0) {
    return buildRequestRedirect(
      request,
      "No MaintainX-mapped locations on your account — ask a super_admin to add your email."
    );
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return buildRequestRedirect(request, "Could not parse form data.");
  }

  const title = String(form.get("title") ?? "").trim();
  const descriptionRaw = String(form.get("description") ?? "").trim();
  const priorityRaw = String(form.get("priority") ?? "").trim().toUpperCase();
  const requesterName = String(form.get("requester_name") ?? "").trim();
  const requesterPhone = String(form.get("requester_phone") ?? "").trim();
  const locationIdRaw = String(form.get("location_id") ?? "").trim();

  if (!title) return buildRequestRedirect(request, "Title is required.");
  if (title.length > REQUEST_TITLE_MAX_LEN) {
    return buildRequestRedirect(
      request,
      `Title is too long (max ${REQUEST_TITLE_MAX_LEN} characters).`
    );
  }
  if (!descriptionRaw) {
    return buildRequestRedirect(request, "Description is required.");
  }
  if (descriptionRaw.length > REQUEST_DESCRIPTION_MAX_LEN) {
    return buildRequestRedirect(
      request,
      `Description is too long (max ${REQUEST_DESCRIPTION_MAX_LEN} characters).`
    );
  }
  if (
    priorityRaw !== "HIGH" &&
    priorityRaw !== "MEDIUM" &&
    priorityRaw !== "LOW"
  ) {
    return buildRequestRedirect(request, "Priority must be HIGH, MEDIUM, or LOW.");
  }
  const priority = priorityRaw as "HIGH" | "MEDIUM" | "LOW";
  if (!REQUEST_ALLOWED_PRIORITIES.has(priority)) {
    return buildRequestRedirect(request, "Priority must be HIGH, MEDIUM, or LOW.");
  }
  if (!requesterName) {
    return buildRequestRedirect(request, "Requester name is required.");
  }
  if (requesterName.length > REQUEST_REQUESTER_NAME_MAX_LEN) {
    return buildRequestRedirect(
      request,
      `Requester name is too long (max ${REQUEST_REQUESTER_NAME_MAX_LEN} characters).`
    );
  }
  // Brief 75: phone is required. No format validation (operators may
  // legitimately enter international formats, extensions, etc.); just
  // non-empty.
  if (!requesterPhone) {
    return buildRequestRedirect(request, "requester_phone_required");
  }
  if (requesterPhone.length > REQUEST_REQUESTER_PHONE_MAX_LEN) {
    return buildRequestRedirect(
      request,
      `Requester phone is too long (max ${REQUEST_REQUESTER_PHONE_MAX_LEN} characters).`
    );
  }
  const locationId = Number.parseInt(locationIdRaw, 10);
  if (!Number.isFinite(locationId) || locationId <= 0) {
    return buildRequestRedirect(request, "Pick a location.");
  }
  if (!accessibleMxIds.has(locationId)) {
    return buildRequestRedirect(
      request,
      "Location not in your accessible set."
    );
  }

  // Brief 76: up to 5 photos — photo[0] → thumbnail endpoint,
  // photo[1..4] → attachments (plural) endpoint. Worker-side cap is
  // defense-in-depth alongside the form's client-side check.
  const allPhotoEntries = form.getAll("photo");
  const photoFiles: File[] = [];
  for (const entry of allPhotoEntries) {
    if (typeof entry === "string") continue; // empty multipart fields land as ""
    if (!(entry instanceof File)) continue;
    if (entry.size === 0) continue; // empty input
    if (entry.size > REQUEST_PHOTO_MAX_BYTES) {
      return buildRequestRedirect(
        request,
        `Photo "${entry.name}" is too large (max ${REQUEST_PHOTO_MAX_BYTES / (1024 * 1024)} MB).`
      );
    }
    photoFiles.push(entry);
  }
  if (photoFiles.length > REQUEST_MAX_PHOTOS) {
    return buildRequestRedirect(request, "too_many_photos");
  }

  // Compose description footer with requester attribution. Phone is now
  // required (Brief 75) so the placeholder fallback ("—") is gone.
  const description = `${descriptionRaw}\n\n---\nRequested by: ${requesterName}\nPhone: ${requesterPhone}\nSubmitted via: Splash /workorders`;

  // Phase 1 — create the work request.
  const createCtl = new AbortController();
  const createTimeout = setTimeout(
    () => createCtl.abort(),
    REQUEST_CREATE_TIMEOUT_MS
  );
  let createResult;
  try {
    createResult = await createMaintainXWorkRequest({
      title,
      description,
      priority,
      locationId,
      creatorContactInfo: email,
      apiKey: env.MAINTAINX_API_KEY,
      baseUrl: env.MAINTAINX_BASE_URL,
      signal: createCtl.signal
    });
  } finally {
    clearTimeout(createTimeout);
  }

  if (!createResult.ok || createResult.requestId == null) {
    console.error(
      `workorders-worker request create failed: status=${createResult.status} error=${createResult.error}`
    );
    return buildRequestRedirect(
      request,
      `Could not create the request: ${createResult.error ?? "upstream error"}`
    );
  }
  const requestId = createResult.requestId;

  // Phase 2 — upload up to 5 photos. photo[0] → thumbnail endpoint;
  // photo[1..4] → attachments (plural) endpoint. Failures are
  // non-fatal: the request exists in MaintainX either way. Per-photo
  // failures collect into a count surfaced via `request_warn=
  // {N}-of-{M}-photos-failed` on the success redirect.
  let photosFailed = 0;
  for (let i = 0; i < photoFiles.length; i += 1) {
    const file = photoFiles[i];
    if (!file) continue; // narrows tsconfig's noUncheckedIndexedAccess
    const endpoint: "thumbnail" | "attachment" = i === 0 ? "thumbnail" : "attachment";
    const filename = sanitizeFilename(file.name);
    let body: ArrayBuffer | null = null;
    try {
      body = await file.arrayBuffer();
    } catch (err) {
      console.error(
        `workorders-worker request ${requestId} photo ${i} (${endpoint}) read failed:`,
        err
      );
      photosFailed += 1;
      continue;
    }
    const uploadCtl = new AbortController();
    const uploadTimeout = setTimeout(
      () => uploadCtl.abort(),
      REQUEST_PER_UPLOAD_TIMEOUT_MS
    );
    let uploadResult;
    try {
      uploadResult = await uploadMaintainXWorkRequestFile({
        requestId,
        filename,
        body,
        apiKey: env.MAINTAINX_API_KEY,
        baseUrl: env.MAINTAINX_BASE_URL,
        endpoint,
        signal: uploadCtl.signal
      });
    } finally {
      clearTimeout(uploadTimeout);
    }
    if (!uploadResult.ok) {
      console.error(
        `workorders-worker request ${requestId} photo ${i} (${endpoint}) failed: status=${uploadResult.status} error=${uploadResult.error}`
      );
      photosFailed += 1;
    }
  }

  console.log(
    `workorders-worker request ${requestId} created by ${email} (photos=${photoFiles.length}, photos_failed=${photosFailed})`
  );

  const warn =
    photosFailed > 0
      ? `${photosFailed}-of-${photoFiles.length}-photos-failed`
      : null;
  return buildRequestRedirect(request, null, requestId, warn);
}
