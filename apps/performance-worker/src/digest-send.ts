// Weekly greeter digest — the send half.
//
// One entry point, runWeeklyGreeterDigest(), used by BOTH the Monday cron and
// the preview route. That is deliberate: a preview that walked a different code
// path would verify a different email than the one that ships. The only thing
// `dryRun` changes is whether enqueueOutboundEmail() is called; every read,
// every slice and every render happens either way.
//
// IT ENQUEUES, IT DOES NOT SEND. Delivery is Power Automate draining the
// outbound_emails table. Everything this file owns finishes the moment the rows
// are in the queue.
//
// ONE ESTATE-WIDE FETCH, SLICED PER PERSON. buildDigestBlocks() runs once over
// the union of enrolled codes; each recipient's email is a view onto that same
// map. Twelve recipients over ten sites would otherwise re-read most sites eight
// or nine times.
//
// THE LOOP IS SEQUENTIAL AND EACH ITERATION HAS ITS OWN try/catch, matching
// apps/inventory/worker/db.ts. Promise.all would be faster and wrong twice over:
// a single rejection abandons the rest of the batch, and a dozen simultaneous
// PostgREST inserts is a burst with nothing to gain from it. A bad address must
// cost exactly one email, not the run.

import {
  createServiceClient,
  enqueueOutboundEmail,
  listGreeterDigestLocations,
  listGreeterDigestRecipients,
  type SupabaseEnv
} from "@splash/db-supabase";

import {
  buildDigestBlocks,
  digestWeekFor,
  sliceForRecipient,
  type DigestSiteBlock,
  type DigestWeek
} from "./digest.js";
import { renderGreeterDigest } from "./digest-render.js";

/**
 * SupabaseEnv plus an optional report-link override.
 *
 * Optional so a plain SupabaseEnv still satisfies it — the worker's own
 * `type Env = SupabaseEnv` is passed straight through. Staging sets the var to
 * its own host; production leaves it unset and takes the default.
 */
export interface DigestSendEnv extends SupabaseEnv {
  GREETER_DIGEST_REPORT_URL?: string;
}

const DEFAULT_REPORT_URL =
  "https://splashcarwashes.info/admin/greeters/report";

/** Stable across re-runs of the same week — see `source_id` below. */
const SOURCE_WORKER = "performance";
const SOURCE_KIND = "greeter-weekly-digest";

export interface DigestRunRecipientResult {
  email: string;
  /** How many enrolled sites this person's email actually covered. */
  sites: number;
  subject: string;
  /** Null on a dry run, or when the enqueue threw. */
  queued_id: string | null;
  /** True when the dedup index matched — this week was already queued for them. */
  duplicate: boolean;
  error: string | null;
  /**
   * The rendered email, present only on a dry run with `includeHtml`. Omitted
   * on real sends: the body is already in outbound_emails and echoing a dozen
   * of them back would make the cron's log line enormous for no reader.
   */
  body_html?: string;
}

export interface DigestRunResult {
  week: DigestWeek;
  dry_run: boolean;
  /** Enrolled sites read for the whole estate, before any slicing. */
  sites_enrolled: number;
  recipients: number;
  enqueued: number;
  duplicates: number;
  failed: number;
  results: DigestRunRecipientResult[];
}

export interface DigestRunOptions {
  /** Render everything, queue nothing. The preview route's default. */
  dryRun?: boolean;
  /** Restrict the run to one address, for a targeted test send. */
  onlyTo?: string | null;
  /** Overrides both the env var and the default. */
  reportUrl?: string | null;
  /**
   * Attach the rendered HTML to each dry-run result. Ignored when not a dry
   * run — see the field's note on DigestRunRecipientResult.
   */
  includeHtml?: boolean;
}

/**
 * Build and queue Monday's digest for every eligible recipient.
 *
 * `now` is a parameter rather than a `new Date()` inside, so the preview route
 * and any future backfill can ask for a specific week without the function
 * needing to know why.
 *
 * NEVER THROWS FOR ONE RECIPIENT. It throws only when the shared reads fail —
 * at that point there is no digest for anybody and a loud failure is the honest
 * outcome. Per-recipient failures land in `results[].error` and in the `failed`
 * count, which is what the cron logs and the preview route both surface.
 */
export async function runWeeklyGreeterDigest(
  env: DigestSendEnv,
  now: Date,
  opts: DigestRunOptions = {}
): Promise<DigestRunResult> {
  const dryRun = opts.dryRun === true;
  const onlyTo = opts.onlyTo ? opts.onlyTo.trim().toLowerCase() : null;
  const reportUrl =
    opts.reportUrl ?? env.GREETER_DIGEST_REPORT_URL ?? DEFAULT_REPORT_URL;

  const client = createServiceClient(env);
  const week = digestWeekFor(now);

  const [allRecipients, enrolled] = await Promise.all([
    listGreeterDigestRecipients(client),
    listGreeterDigestLocations(client)
  ]);

  const recipients = onlyTo
    ? allRecipients.filter((r) => r.email === onlyTo)
    : allRecipients;

  const result: DigestRunResult = {
    week,
    dry_run: dryRun,
    sites_enrolled: enrolled.length,
    recipients: recipients.length,
    enqueued: 0,
    duplicates: 0,
    failed: 0,
    results: []
  };

  // Nobody to mail is a legitimate outcome (everything suppressed, or nothing
  // enrolled yet). Returning early skips the estate-wide read, which is the
  // expensive part and would be thrown away.
  if (recipients.length === 0) return result;

  // The union of every enrolled code, not the union of the recipients' codes:
  // the two are the same today, and building from the enrollment list keeps
  // them the same if a site is ever enrolled before anyone is granted it.
  const blocks = await buildDigestBlocks(
    client,
    enrolled.map((r) => r.location_code),
    week
  );

  for (const recipient of recipients) {
    const slice: DigestSiteBlock[] = sliceForRecipient(blocks, recipient);
    // Only reachable if every one of their sites was un-enrolled between the
    // recipient read above and now. An email with no sites in it says
    // "everything reported nothing", which is a false alarm, so skip.
    if (slice.length === 0) {
      result.results.push({
        email: recipient.email,
        sites: 0,
        subject: "",
        queued_id: null,
        duplicate: false,
        error: "no enrolled sites at render time"
      });
      result.failed += 1;
      continue;
    }

    const rendered = renderGreeterDigest(slice, week, reportUrl);

    if (dryRun) {
      result.results.push({
        email: recipient.email,
        sites: slice.length,
        subject: rendered.subject,
        queued_id: null,
        duplicate: false,
        error: null,
        ...(opts.includeHtml ? { body_html: rendered.bodyHtml } : {})
      });
      continue;
    }

    try {
      const queued = await enqueueOutboundEmail(env, {
        source_worker: SOURCE_WORKER,
        source_kind: SOURCE_KIND,
        // The week's Monday, so a second run of the same week is a no-op at the
        // dedup index rather than a second copy in somebody's inbox. This is
        // the whole reason a retry of a half-failed cron is safe.
        source_id: week.from,
        recipient: recipient.email,
        subject: rendered.subject,
        body_html: rendered.bodyHtml,
        body_text: rendered.bodyText
      });
      if (queued.was_duplicate) result.duplicates += 1;
      else result.enqueued += 1;
      result.results.push({
        email: recipient.email,
        sites: slice.length,
        subject: rendered.subject,
        queued_id: queued.id,
        duplicate: queued.was_duplicate,
        error: null
      });
    } catch (err) {
      result.failed += 1;
      result.results.push({
        email: recipient.email,
        sites: slice.length,
        subject: rendered.subject,
        queued_id: null,
        duplicate: false,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  return result;
}

/**
 * Cron wrapper: run it, log one line, swallow nothing that matters.
 *
 * The catch exists so a failed run logs a recognizable message instead of an
 * unhandled rejection in the tail. There is no retry — the next fire is a week
 * away, and `source_id` makes a manual re-run safe, so the recovery path is a
 * person hitting the preview route's send mode, not a timer.
 */
export async function runWeeklyGreeterDigestCron(
  env: DigestSendEnv
): Promise<void> {
  try {
    const result = await runWeeklyGreeterDigest(env, new Date(), {});
    console.log(
      `[greeter-digest] week=${result.week.from}..${result.week.to} ` +
        `recipients=${result.recipients} enqueued=${result.enqueued} ` +
        `duplicates=${result.duplicates} failed=${result.failed}`
    );
    for (const r of result.results) {
      if (r.error) console.error(`[greeter-digest] ${r.email}: ${r.error}`);
    }
  } catch (err) {
    console.error(
      `[greeter-digest] run failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
