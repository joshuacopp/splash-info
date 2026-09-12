# MaintainX → Supabase ingest, Phase 1

**Scope:** land MaintainX work orders, work requests and comments in Postgres on a
cron. Nothing about serving changes. `/workorders/api/list` keeps reading the live
API for the whole of this phase, so the ingest can be wrong without breaking the
site, and we get a parity window to diff Postgres against the live response before
Phase 4 flips the read path.

**Status:** ready to implement, revised 2026-09-12 after the parameter probe.
Written against measured results in `apps/workorders-worker/scripts/mx-probe*.py`.
All gating unknowns are closed — the three API questions by probe, the Workers plan
tier by dashboard check (see "Verified API behavior"). No open blockers.

---

## What the measurements force

Four numbers drive every decision below.

**3,920 work orders are live right now** (OPEN 3,496 / IN_PROGRESS 308 / ON_HOLD
116), but the six-month walk only found 1,270 of them. So roughly 2,650 currently
open work orders were created more than six months ago — the open queue reaches
back about three years. A backfill bounded on `createdAt >= 6 months` would land a
live queue with two thirds of its rows missing. The backfill therefore has to be
two passes with different bounds, which is the single biggest shape decision in
this phase.

**91% of the live queue is preventive** (3,567 PREVENTIVE / 327 REACTIVE / 26
OTHER), and across six months of history it was 87%. Preventive work orders are
nearly empty of everything expensive: 1 requester, 40 with comments, 0
expenditures. So any per-work-order detail fetch must be gated on
`type = REACTIVE`, which turns ~20,000 comment requests into ~1,851.

**Total volume is ~19,900 work orders per six months**, ~3,300/month, plus 10,243
work requests all-time. At the verified 200 rows per page that is ~94 pages for the
history walk, ~52 for work requests and ~20 for the live walk. Still does not fit
in one Worker invocation, so every pass has to checkpoint and resume.

**No rate limiting was observed** across 393 + 153 + 93 + 43 requests at 0.25s
spacing, zero 429s. That is permission to be reasonably aggressive, not permission
to skip backoff — the client currently has none at all.

---

## Verified API behavior

Measured 2026-09-12 14:42 by `scripts/mx-probe-params.py`, 43 requests, all read-only.
Every filter test validated the returned *values*, not just the status code, because
MaintainX could accept a param and silently ignore it. Results in
`mx-probe-params-report.json`.

**`limit=200` is real and is the hard ceiling.** 50/100/150/200 all honored exactly;
250, 500 and 1000 return `400 {"error":"must be <= 200","fieldPath":"limit"}`. So
`PAGE_LIMIT = 200` at `packages/maintainx/src/work-orders.ts:16` is truthful, and
every page count in this document is the 200-row figure.

**`updatedAt[gte]` / `updatedAt[lte]` work, and so do the `createdAt` pair.** All
four are declared in the OpenAPI spec and all four hold under value inspection: the
`lte` test bounded at `now − 730d` with `sort=-updatedAt` returned a max of
`2024-09-12T14:37:57Z`, which is impossible if the filter were being ignored. Zero
violations on every variant, and a two-sided window works. **The incremental sweep in
part D is therefore real and the webhook in Phase 2 stays a backstop rather than
becoming load-bearing.**

**Cursor pagination survives filtering.** Page 2 of a filtered walk kept the filter
applied and had zero id overlap with page 1. So a bounded walk can be chunked across
invocations the same way an unbounded one can — this was the quiet assumption
underneath part C and it holds.

**The `expand` enum is fixed and snake_case in places.** Authoritative list:
`thumbnail, assignees, categories, parts, asset, location, procedure, team_ids,
vendor_ids, times, time_items, expenditures, extra_fields, part_extra_fields,
asset_extra_fields, location_extra_fields, estimated_time`. A token outside it is a
400 that kills the whole page. Notably **there is no expand for `attachments`,
`recurrenceInfo`, `requester`, `workRequest`, `teams` or `vendors`** — camelCase
`timeItems` is rejected; the token is `time_items`.

**The `sort` enum is fixed too:** `updatedAt, createdAt, dueDate, startedAt,
completedAt` and their `-` variants. There is no sort by `id` — `sort=id` 400s. All
six tested sorts returned correctly ordered values.

**`deletedAt` never appears on a list payload.** Zero occurrences across 100 rows.
Deletes are observable only as disappearance, which means reconciliation (part D) is
the only delete-detection mechanism we have.

**Two params we did not know about**, both worth a look in Phase 4 rather than now:
`show_upcoming` (boolean) and `parentSubWorkOrderTypes`
(`PARENT | SUB_WORK_ORDER | STANDALONE`). The latter says work orders can have a
parent/sub relationship the schema does not currently model.

**One caveat on the probe's `baseline_row_keys`.** That 21-key list is a union over a
small recent sample, not an authoritative field list — it lacks `dueDate`, which the
open-queue probe demonstrably read off list payloads. Null fields are omitted from
responses, so absence from a sample proves nothing. Treat `mx_work_order.raw` as the
safety net rather than trusting any enumerated field list.

**The account is on Workers Paid** (confirmed 2026-09-12 in the Cloudflare billing
dashboard; R2 Paid is active too, which Phase 3's attachment mirror needs). So the
subrequest ceiling is 1,000 per invocation, not 50. At roughly 4 subrequests per page
(one fetch plus one to three upserts) even a 100-page run sits at ~400 — subrequests
are no longer the binding constraint on the chunk budget. CPU time is — and the
October billing period shows 820.89k CPU-ms used against 30M included (2.7%), so the
backfill's parsing cost disappears into the free allotment.

R2 is the same story: 3.37 GB-months in use against 10 GB included, and the measured
attachment projection for Phase 3 is 3.5 GB for the six-month backfill plus ~0.6
GB/month ongoing. Combined that lands near 7 GB — still inside the included tier.

---

## A. Client changes (`packages/maintainx`)

The existing client is built for *serving*: bounded, fail-soft, deliberately
truncating. `fetchMaintainXWorkOrders` accumulates into an array, stops at
`maxWorkOrders`, and force-breaks at `MAX_PAGE_ITERATIONS = 10`
(`src/http.ts:18`). Those are the right semantics for a page render and the wrong
ones for a backfill.

**Do not change `fetchMaintainXWorkOrders`.** Three other workers call into this
package (`damage-worker`, `inventory/worker`, and the live list handler) and its
fail-soft posture is load-bearing per the comment block at `src/http.ts:3-8`.
Adding ingest semantics to it means every existing caller inherits a behavior
change for no benefit.

Instead add a page-level primitive alongside it. `fetchOnePage()` already exists
at `src/work-orders.ts:259-306` and is private; the work is to export a
parameterised version rather than write a new fetcher.

**A1. New `src/sync.ts`** exporting:

- `fetchWorkOrderPage(input)` — one page, one HTTP call, no accumulation, no
  iteration ceiling. Explicit params rather than the hardcoded set in `buildUrl()`:
  `statuses[]`, `expand[]`, `limit`, `cursor`, `sort`, `locations[]`, and
  `updatedAtGte` / `updatedAtLte` / `createdAtGte` / `createdAtLte`, all verified
  working. Returns `{ ok, workOrders, nextCursor, error, status }`.
- `fetchWorkOrderComments(workOrderId, cursor, limit)` — measured to accept only
  `cursor` and `limit`; `expand` returns 400 on this endpoint, so do not add it.
- `fetchWorkRequestPage(input)` — same treatment for `/workrequests`.

Send the date filters as literal bracketed keys — `updatedAt[gte]` — which means
`URLSearchParams.set()` with the brackets in the name, not a nested object.

**A2. Widen the expand set for ingest.** `buildUrl()` hardcodes
`assignees, location, categories` (`src/work-orders.ts:189-190`) because that is
what the page renders. For ingest send exactly:

```
assignees, location, categories, parts, expenditures, times, time_items, asset
```

Those are enum members backing `mx_work_order_part`, `mx_work_order_expenditure`
and `mx_work_order_time_item`. Six of the eight were individually round-tripped and
accepted; `time_items` and `estimated_time` were confirmed only from the enum, so
assert on the first real page fetch that a bad token has not slipped in — one 400
fails an entire page.

Consequences worth stating plainly, because they redirect work:

- **`attachments` has no expand token.** Mirroring attachments requires a per-work-order
  `GET /workorders/{id}`. That is Phase 3's problem, and at a measured mean of 0.2
  attachments per work order it stays cheap, but it is a fan-out, not a free field.
- **`recurrenceInfo` has no expand token either.** If it does not arrive on the default
  list payload it cannot be backfilled without per-work-order fetches across all
  17,348 preventive work orders. Check the first real page before designing around it.
- `procedure` is accepted but added no keys on the sample, and `parts` / `expenditures`
  / `asset` were accepted but empty — consistent with expenditures being used on 0.1%
  of work orders. Accepted-but-empty is the expected shape here, not a bug.

**A3. Widen `RawWorkOrder`.** The interface at `src/work-orders.ts:21-54` covers
14 fields, all of them things the page renders. Ingest needs at minimum
`recurrenceInfo`, `timeItems`, `requesterId`, `lastMessageSentAt`, `completedAt`,
`startDate`, `partStatus`, `estimatedTimeSeconds`, `organizationId`,
`dueDateIsFullDay`, and the expanded `parts` / `expenditures` arrays. All optional,
all forward-compatible per the existing comment. Drop `deletedAt` from the list —
it never appears. The full payload also goes into `mx_work_order.raw` regardless, so
a field missed here is recoverable without a re-walk.

**A4. Add retry and backoff.** There is none today — every call is fire-once, no
429 handling anywhere in the package. Ingest needs exponential backoff on
429/500/502/503/504. The probe scripts already have a working version of this
(4 attempts, delay doubling from 1s); port that shape. Keep the fail-soft return
posture: a page that exhausts retries returns `ok: false` and the pass checkpoints
where it is rather than throwing.

**A5. Request spacing.** The probes used 0.25s and saw no throttling. Keep that as
the default inter-page delay — it costs ~5s across a 20-page pass, which is
cheap insurance against getting the org rate-limited mid-backfill.

---

## B. Backfill: two passes, different bounds

Both driven by `mx_sync_state` (`maintainx-ingest-01-tables.sql:366-376`), one row
per pass, checkpointing `cursor` after every page. All counts below assume the
verified `limit=200`.

**Pass A — LIVE, no date bound.** `statuses = OPEN, IN_PROGRESS, ON_HOLD`, walk to
cursor exhaustion. ~3,920 rows, ~20 pages. This is the pass that matters: it is
what the site will serve from, and it is the one the six-month bound would have
broken. Run it first and to completion before starting B.

**Pass B — HISTORY, six-month bound.** `statuses = DONE, CANCELED, SKIPPED` with
`createdAt[gte]` set to the window start — server-side, verified working, so no
client-side stop condition and no sort gymnastics. ~18,700 rows, ~94 pages. Lower
priority; it exists for reporting, not for the live queue.

Splitting on status rather than running one `ALL_WORK_ORDER_STATUSES` walk is what
makes the different bounds possible, and it means an interrupted history pass
never blocks the live queue from being complete.

**Pass C — WORK REQUESTS, full walk.** 10,243 rows, ~52 pages. `/workrequests`
has no date filter at all (measured), so this is all-or-nothing every time. Run it
once in backfill and then on a slow cadence — hourly is fine, every few minutes is
not.

---

## C. Chunking across cron invocations

Each invocation runs a budget, not a pass:

```
loop:
  fetch one page (1 subrequest)
  upsert the batch (1-3 subrequests)
  write cursor + stats to mx_sync_state
  if pages_this_run >= PAGE_BUDGET: return
  if elapsed_ms >= TIME_BUDGET: return
  if nextCursor is null: mark pass complete, return
```

Checkpointing *after every page* rather than at the end is the whole point — a
timeout, a CPU kill or a deploy mid-backfill costs one page, not the run. Cursor
pagination was verified to keep filters applied across pages, so a resumed bounded
walk picks up correctly rather than silently widening.

Starting values on Paid: `PAGE_BUDGET = 50`, `TIME_BUDGET = 20_000ms`. With 1,000
subrequests available, `PAGE_BUDGET` is a safety rail rather than the real governor —
what binds is CPU time (30s by default on a scheduled handler, raisable via
`limits.cpu_ms`), and the CPU cost here is parsing 200 fat rows per page and
serialising them back out for the upsert. Awaiting a fetch costs no CPU, so the 0.25s
inter-page spacing is free in that budget. Tune `PAGE_BUDGET` down if CPU shows up in
the invocation logs, not up.

At 50 pages that is all of Pass A in one run, Pass C in two and Pass B in two — the
whole backfill inside half an hour on a 5-minute trigger.

**Cron.** Today the worker has one trigger, `30 11 * * *`
(`apps/workorders-worker/wrangler.toml`), running only
`runMaintainXUserTeamSync`. Add a second, fast trigger for the backfill window and
branch on `controller.cron` inside `scheduled()` — the existing handler at
`src/index.ts:272-283` currently ignores the controller entirely. Something like
`*/5 * * * *` finishes the whole backfill quickly, then gets relaxed to the steady
incremental cadence once `mx_sync_state` shows all passes complete.

Have the pass dispatcher read `mx_sync_state` and pick work in priority order —
Pass A until complete, then C, then B — so the schedule needs no editing as the
backfill progresses.

**Upserts.** Follow the proven pattern at
`packages/db-supabase/src/maintainx-users.ts:174-213`: PostgREST POST with
`Prefer: resolution=merge-duplicates,return=minimal` and `on_conflict=id`. Every
`mx_*` table has a bare `id` primary key, so `ON CONFLICT (id)` is the target
everywhere and upserts are naturally idempotent.

That helper batches 500. Halve it to 200 for work orders: `mx_work_order` carries
the full API payload in `raw` jsonb, so rows run several KB each and 500 of them
is a multi-megabyte request body. Comments are small and can keep 500.

---

## D. Incremental sweep

Once backfill completes, steady state is:

- **Live statuses, every cycle.** Re-walk `OPEN/IN_PROGRESS/ON_HOLD` unbounded,
  ~20 pages. Cheap enough to do outright and self-correcting: a work order that
  closes drops out of the result set, and one that reopens comes back.
- **Recent history, via `updatedAt[gte] = last watermark`.** Verified working, so
  this is a handful of pages per cycle rather than a 94-page re-walk. Set the bound
  a few minutes behind the true watermark to absorb clock skew and in-flight writes;
  upserts are idempotent so overlap is free.
- **Status transitions and deletes, by reconciliation.** A work order that moves
  OPEN → DONE vanishes from the live walk, so the row in Postgres goes stale at
  whatever it last was. `deletedAt` never appears on list payloads, so a hard delete
  is indistinguishable from a status change — both are just disappearance. Catch both
  the same way: any `mx_work_order` row with a live status whose `id` did not appear
  in the current walk gets re-fetched individually via `fetchMaintainXWorkOrder`, and
  a 404 there is the delete signal. Volume is small — roughly the daily close rate.

One caveat on `updatedAt`: it does not move when a comment is added (known from the
earlier probe). So the comment pass in part E must be driven by `lastMessageSentAt`,
not by the watermark.

`mx_sync_state.watermark` holds the high-water `mx_updated_at` per pass;
`last_run_at` / `last_success_at` / `last_status` / `last_error` give the
observability surface, and `stats` jsonb takes per-run page and row counts.

---

## E. Comments

The expensive part of the phase, and the one to get right.

Gate hard: `type = REACTIVE AND lastMessageSentAt IS NOT NULL`. Measured, that is
1,851 work orders over six months against ~20,000 — a 91% reduction. Preventive
work orders have comments 0.2% of the time and are not worth checking.

Drive this pass from Postgres rather than an API cursor, because the work set is
"work orders we know have comments we have not fetched yet":

```sql
select id
from mx_work_order
where type = 'REACTIVE'
  and last_message_sent_at is not null
  and (comments_synced_at is null or last_message_sent_at > comments_synced_at)
order by last_message_sent_at desc
limit 100
```

**This needs a new column.** `mx_work_order` has `synced_at` but no
`comments_synced_at` (schema lines 30-97). Without it there is no way to
distinguish "never checked for comments" from "checked, found none" — the first
must be retried, the second must not. Add it in `maintainx-ingest-02` alongside
the urgency index that Phase 4 will want. Deriving it from
`max(mx_work_order_comment.synced_at)` per work order does not work for exactly
that reason.

Comment rows upsert on `id`, and the objects carry no `updatedAt`, so re-fetching
a thread is naturally idempotent — an edited comment will not be detected, which
is an accepted limitation.

Two serving-layer gotchas to handle at ingest rather than at render: `content` can
be an empty string (photo-only comment), and mentions arrive encoded as
`@[Display Name](u|833871)` and need parsing or stripping.

**Comment photos are not retrievable.** Confirmed four ways in
`mx-probe-comments-report.json`: the endpoint takes only `cursor` and `limit`,
`expand` 400s, the OpenAPI spec has no comment schema and every attachment path is
PUT/DELETE only, and timestamp correlation across 40 work orders matched nothing.
Work-order attachments are a separate object and *are* mirrorable (Phase 3, via a
per-work-order detail fetch since there is no expand token for them); the ~11.5% of
comments that are photo-only render as a MaintainX deep link.

---

## F. Things this work exposes, for Phase 4 rather than now

**The live list truncates below the real queue size.** `MAX_PAGE_ITERATIONS = 10`
(`src/http.ts:18`) times `PAGE_LIMIT = 200` caps any paginated walk at 2,000 rows,
and the multi-location caller caps itself at `MAX_WORK_ORDERS_MULTI = 1000`
(`src/index.ts:74`). Against a 3,920-row live queue, any user with access to the
heavy sites is served a truncated list. Per-location load is brutally skewed —
median 10.5 live work orders, but the top sites are 432, 419, 355 and 316 — so a
single-site user is fine and a regional covering the top four is not. The
truncation banner fires, so it is visible rather than silent, but the Postgres
read path in Phase 4 should simply not have this ceiling.

**The 90-day preventive drop is correct and stays — as a DISPLAY filter only.**
`PREVENTATIVE_MAX_OVERDUE_DAYS = 90` at `src/index.ts:567` drops preventive work
orders more than 90 days past due. Measured median overdue on open PM is 331.5 days
(mean 386, max 1,116), so this does hide well over half the open preventive queue —
by design. That tail is stale auto-spawned cycles left uncleaned on the MaintainX
side, not work an operator needs to see.

**This is a render-time filter, never an ingest-time one.** Pass A walks all
`OPEN/IN_PROGRESS/ON_HOLD` work orders with no type or age predicate, so all ~3,567
open preventive rows land in `mx_work_order` regardless of how far past due they are.
Reporting wants them, the data-hygiene cleanup on the MaintainX side will want them,
and re-acquiring a row we chose not to store means a fresh walk. The 90-day threshold
lives exactly one place: the `WHERE` clause that builds the operator page. If the PM
view ever needs an escape hatch it is a deliberate "show stale" affordance reading
rows that are already in Postgres, not a change to the threshold or to ingest.

**"Overdue" is useless as a PM signal generally.** 3,469 of 3,567 open preventive
work orders (97%) are past due. Never sort or badge PM by overdue — it selects
nearly the whole set. PM urgency has to come from due-date recency.

**Reactive work orders carry no due dates.** The comment at `src/index.ts:563-565`
asserts reactive `dueDate` is "MaintainX-auto-set to creation-day"; the probe found
281 of 327 live reactive work orders have **no** due date at all, and zero are
DUE_SOON or UPCOMING. Either the behavior changed or the comment was always wrong.
Reactive urgency has to come from age-since-created or priority.

**149 live work orders have a null `locationId`, 35 of them reactive** — 11% of all
live reactive work, unattributable to any site. Any per-site view needs an
"unassigned" bucket.

**Sub-work-orders are unmodeled.** The API exposes `parentSubWorkOrderTypes`
(`PARENT | SUB_WORK_ORDER | STANDALONE`), so parent/child relationships exist and the
`mx_*` schema does not represent them. Measure the distribution before deciding
whether it matters.

---

## Definition of done for Phase 1

- `mx_work_order` holds all ~3,920 live work orders and ~18,700 six-month history
  rows; `mx_work_request` holds all 10,243.
- `mx_work_order_comment` holds threads for every reactive work order with
  `last_message_sent_at` set.
- `mx_sync_state` shows every pass complete, with `last_status` clean.
- The incremental sweep runs on cron and a manually closed work order shows the
  new status in Postgres within one cycle.
- A parity script diffs the Postgres projection against the live
  `/workorders/api/list` response for a sample of users and reports zero material
  differences — this is the gate for starting Phase 4.
- `/workorders/api/list` is byte-for-byte unchanged throughout.
