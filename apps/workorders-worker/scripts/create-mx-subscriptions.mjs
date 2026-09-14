#!/usr/bin/env node
// Create the MaintainX webhook subscriptions and record them in Postgres.
//
// Run once, by the operator, with the MaintainX API key. It is NOT part of the
// worker: creating subscriptions is a deliberate act with a side effect nobody
// can undo by redeploying, and MaintainX cannot list what exists, so an
// accidental second run is how you end up with duplicate deliveries you cannot
// see.
//
//   node scripts/create-mx-subscriptions.mjs --dry-run
//   node scripts/create-mx-subscriptions.mjs
//
// Environment (all required unless noted):
//   MAINTAINX_API_KEY       same value bound on splash-workorders / splash-damage
//   SUPABASE_URL            project URL
//   SUPABASE_SERVICE_KEY    service role -- mx_webhook_subscription is RLS-on
//                           with no policies, so nothing else can write it
//   MAINTAINX_BASE_URL      optional, defaults to the v1 root
//   MX_WEBHOOK_URL          optional, defaults to the apex route
//
// WHY THIS IS IDEMPOTENT-ISH AND NOT IDEMPOTENT
//
//   There is no GET /subscriptions. The only way to know what already exists is
//   our own mx_webhook_subscription table, so that is what this consults: an
//   event already recorded against the same URL is skipped. If the table is
//   wiped but the subscriptions still exist upstream, a re-run creates
//   duplicates and MaintainX will happily deliver each event twice. The
//   receiver is idempotent (every webhook is a re-fetch), so duplicates cost
//   requests rather than correctness -- but clean them up via
//   DELETE /subscriptions/{id} using the ids this prints.
//
// THE SECRET
//
//   POST /subscriptions returns {id, status, secret}. The secret is printed
//   ONCE here and never stored in Postgres -- it belongs in the worker as a
//   Cloudflare secret, not in a table that a read of the database would expose.
//   It is also re-readable later from GET /subscriptions/{id}/secret using an
//   id from mx_webhook_subscription, so losing the terminal output is
//   recoverable.
//
//   Whether MaintainX issues ONE secret per URL or one per subscription is not
//   documented. This script checks: if the seven come back with differing
//   secrets it says so loudly, because the receiver verifies against a single
//   MAINTAINX_WEBHOOK_SECRET and would silently reject six of seven events.

const BASE_URL = process.env.MAINTAINX_BASE_URL ?? "https://api.getmaintainx.com/v1";
const WEBHOOK_URL =
  process.env.MX_WEBHOOK_URL ??
  "https://splashcarwashes.info/workorders/api/mx-webhook";

/**
 * The events we subscribe to, and why each earns its place. Exact enum values
 * from the live OpenAPI spec's POST /subscriptions oneOf -- one variant per
 * event, each a single-value enum, so one subscription is one event plus one
 * URL.
 *
 * Deliberately NOT subscribed: WORK_ORDER_OVERDUE (a clock, not a change --
 * the data is already local and a query answers it), NEW_CATEGORY_ON_WORK_ORDER
 * (categories are the one column the webhook path cannot write; see
 * mx-webhook-process.ts), WORK_ORDER_PART_STATUS_CHANGE (parts ride along on
 * the WORK_ORDER_CHANGE re-fetch), and the 40 events about users, tokens,
 * roles, vendors, POs and SSO that this ingest does not model.
 */
const EVENTS = [
  ["NEW_WORK_ORDER", "a work order is created"],
  ["WORK_ORDER_CHANGE", "any tracked property changes -- unfiltered on purpose"],
  ["WORK_ORDER_STATUS_CHANGE", "status moves, including completion"],
  [
    "WORK_ORDER_DELETE",
    "the one gap polling cannot cover: an incremental sweep keyed on " +
      "updatedAt never sees a row that no longer exists"
  ],
  ["NEW_WORK_REQUEST", "a request is filed -- the five-minute wait this exists to remove"],
  ["WORK_REQUEST_STATUS_CHANGE", "approved / rejected / done"],
  ["NEW_COMMENT_ON_WORK_ORDER", "updatedAt does NOT move on comments, so polling misses these"]
];

const dryRun = process.argv.includes("--dry-run");

function required(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var ${name}`);
    process.exit(2);
  }
  return v;
}

// A dry run creates nothing and writes nothing, so it asks for nothing: it
// exists to let someone read back the event list and the target URL before
// committing to seven irreversible POSTs. Without Supabase it simply cannot
// report what is already recorded, and says so.
const SUPABASE_URL = dryRun ? process.env.SUPABASE_URL : required("SUPABASE_URL");
const SUPABASE_SERVICE_KEY = dryRun
  ? process.env.SUPABASE_SERVICE_KEY
  : required("SUPABASE_SERVICE_KEY");
const API_KEY = dryRun ? process.env.MAINTAINX_API_KEY : required("MAINTAINX_API_KEY");

const sbHeaders = {
  apikey: SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
  "Content-Type": "application/json"
};

/** What we already believe exists, since MaintainX cannot tell us. */
async function readExisting() {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/mx_webhook_subscription?select=id,event_type,target_url&archived_at=is.null`,
    { headers: sbHeaders }
  );
  if (!res.ok) {
    throw new Error(`read mx_webhook_subscription: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

async function createSubscription(eventType) {
  const res = await fetch(`${BASE_URL}/subscriptions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    // The oneOf variant: {type, url}. `filters` is omitted deliberately --
    // filtering server-side means a change we did not subscribe to silently
    // never arrives, and the re-fetch is cheap enough that receiving more than
    // we need costs one GET.
    body: JSON.stringify({ type: eventType, url: WEBHOOK_URL })
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`create ${eventType}: ${res.status} ${text.slice(0, 400)}`);
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`create ${eventType}: response was not JSON: ${text.slice(0, 200)}`);
  }
  if (!body?.id) throw new Error(`create ${eventType}: response had no id: ${text.slice(0, 200)}`);
  return body; // {id, status, secret}
}

async function recordSubscription(row) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/mx_webhook_subscription`, {
    method: "POST",
    headers: { ...sbHeaders, Prefer: "return=minimal" },
    body: JSON.stringify([row])
  });
  if (!res.ok) {
    // The subscription EXISTS upstream at this point. Failing to record it is
    // the invisible-infrastructure case this table was created to prevent, so
    // it is loud and the id is printed for manual insertion.
    throw new Error(
      `RECORDED NOTHING for ${row.event_type} (${row.id}) -- ` +
        `subscription exists upstream but is not in Postgres: ${res.status} ${await res.text()}`
    );
  }
}

async function main() {
  console.log(`target URL : ${WEBHOOK_URL}`);
  console.log(`MaintainX  : ${BASE_URL}`);
  console.log(`mode       : ${dryRun ? "DRY RUN -- nothing will be created" : "LIVE"}`);
  console.log("");

  let already = new Set();
  if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
    const existing = await readExisting();
    already = new Set(
      existing.filter((r) => r.target_url === WEBHOOK_URL).map((r) => r.event_type)
    );
  } else {
    console.warn("no Supabase credentials -- cannot check what is already recorded.");
    console.warn("Fine for a dry run; a live run requires them.");
  }
  if (already.size > 0) {
    console.log(`already recorded for this URL: ${[...already].join(", ")}\n`);
  }

  const secrets = new Map();
  const created = [];

  for (const [eventType, why] of EVENTS) {
    if (already.has(eventType)) {
      console.log(`skip   ${eventType}  (already recorded)`);
      continue;
    }
    if (dryRun) {
      console.log(`would  ${eventType}  -- ${why}`);
      continue;
    }

    const body = await createSubscription(eventType);
    await recordSubscription({
      id: String(body.id),
      event_type: eventType,
      target_url: WEBHOOK_URL,
      status: body.status ?? null,
      note: why
    });
    secrets.set(eventType, body.secret ?? null);
    created.push({ eventType, id: body.id, status: body.status });
    console.log(`create ${eventType}  id=${body.id} status=${body.status ?? "?"}`);
  }

  if (dryRun || created.length === 0) {
    console.log("\nnothing created.");
    return;
  }

  // Does one URL share one secret, or does every subscription get its own?
  // Undocumented, and it decides whether a single MAINTAINX_WEBHOOK_SECRET can
  // work at all.
  const distinct = new Set([...secrets.values()].filter(Boolean));
  console.log("\n----------------------------------------------------------");
  if (distinct.size === 1) {
    console.log("All subscriptions share ONE signing secret, as hoped.\n");
    console.log("Set it on the worker:\n");
    console.log("  cd apps/workorders-worker");
    console.log("  pnpm exec wrangler secret put MAINTAINX_WEBHOOK_SECRET\n");
    console.log("Secret (shown once here; also at GET /subscriptions/{id}/secret):\n");
    console.log(`  ${[...distinct][0]}\n`);
  } else {
    console.error(
      `PROBLEM: ${distinct.size} DIFFERENT secrets across ${created.length} subscriptions.\n` +
        "The receiver verifies against a single MAINTAINX_WEBHOOK_SECRET, so it would\n" +
        "accept one event type and silently 401 the rest. Options: keep one\n" +
        "subscription per secret and bind several, or delete all but one and\n" +
        "re-create. Per-event secrets:\n"
    );
    for (const [eventType, secret] of secrets) {
      console.error(`  ${eventType}: ${secret}`);
    }
  }
  console.log("----------------------------------------------------------");
  console.log("\nRecorded in mx_webhook_subscription:");
  for (const c of created) console.log(`  ${c.id}  ${c.eventType}`);
  console.log(
    "\nTo remove one:  DELETE " + BASE_URL + "/subscriptions/{id}" +
      "\n(then set archived_at on its row -- nothing else can list it)"
  );
}

main().catch((err) => {
  console.error(`\nFAILED: ${err.message}`);
  process.exit(1);
});
