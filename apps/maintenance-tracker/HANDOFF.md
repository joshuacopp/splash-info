# Maintenance Tracker — Handoff for Claude Code

**Date:** 2026-09-16
**Read first:** `apps/maintenance-tracker/PLAN.md` (rev 8) — the source of truth. This file is only a map to it and to the surrounding code.

## Start here

`apps/maintenance-tracker/PLAN.md` — full plan, 11 sections plus appendix. Revision banners at the top carry the history; rev 8 corrects rev 7 and is current. The sections that matter most for implementation:

- §5 — architecture, plus four known defects in the existing MaintainX ingest
- §7 — matching logic as three independent layers (A punch fidelity, B GPS dwell, C work attribution)
- §8 — cost allocation and efficiency; the per-punch decomposition Josh asked for by name
- §10 — phasing; Phase 0 is what ships first
- §11 — open questions, several struck as answered

## Code that already exists

The MaintainX mirror is live and webhook-driven. **Do not rebuild it.** It lives in `apps/workorders-worker`:

- `src/mx-webhook.ts` — webhook receiver. Stores the raw body verbatim (`payload: bag`, lines 142–173; insert at 215–227). 128KB body cap at line 65.
- `src/mx-webhook-verify.ts` — signature verification
- `src/mx-webhook-drain.ts`, `src/mx-webhook-process.ts` — delivery processing
- `src/mx-ingest.ts`, `src/sync.ts` — work order fetch and persistence
- `src/mx-reconcile.ts` — existing reconciliation logic
- `src/mx-map.ts` — field mapping
- `wrangler.toml` — deployment config

**Added 2026-09-16 (Phase 0, not yet pushed — see the ordering note at the bottom):**

- `src/mx-event-log.ts` — folds each verified webhook delivery into
  `mx_work_order_event`. The deliberate exception to the "no payload field is
  ever written" rule; the header explains why it is safe here and must not
  travel.
- `src/mx-timesweep.ts` — the Phase 0 time-item sweep. It ended up as its own
  module rather than alongside `mx-reconcile.ts`: reconcile re-arms a walk and
  writes one field, this rotates a candidate set and refetches, and they share
  no machinery. It reuses `processWorkOrder` (now exported from
  `mx-webhook-process.ts`) rather than reimplementing fetch-map-upsert.
- `supabase/maintainx-event-log-01.sql` — schema + backfill + PGRST102 re-arm.

## Supabase tables (the data lives here, not in the repo)

- `public.mx_webhook_event` — webhook deliveries. Columns include `entity_id` (work order id), `event_type`, `payload` jsonb, `occurred_at`, `received_at`, `process_error`.
- `public.mx_work_order` — work order aggregates: `labor_seconds`, `status`, `mx_updated_at`, `synced_at`
- `public.mx_work_order_time_item` — time entries: `work_order_id`, `ordinal`, `duration_total_seconds`, `quantity_hours`, `first_seen`
- `public.mx_work_order_expenditure` — costs, stored in **cents** (`cost_per_unit_cents`, `row_total_cents`)
- `public.mx_webhook_subscription` — 7 rows, no property-filter column
- `public.mx_work_order_event` — ~~exists but is empty~~ **written as of 2026-09-16.** The webhook path folds every verified delivery into it, and `supabase/maintainx-event-log-01.sql` backfills the 1,408 deliveries already stored as `source = 'BACKFILL'`. Two columns were added that the original DDL lacked: `webhook_event_id` (dedup key) and `actor_user_id` (who made the change — half of the Layer C question, and the DDL had nowhere to put it).
  - **Correction to the plan.** PLAN.md §5, §6 and Phase 0 all state that this history accrues only from the day the writer ships and cannot be bought back later. That is true going forward and was false going backward: `mx_webhook_event` had held every verified delivery since 2026-09-14, `oldStatus`/`newStatus`/`occurredAt`/`userId` intact. Two days were recoverable by a SELECT.
  - **For whoever computes intervals:** 100 of the first 741 status changes were made by user 520201, "MX Friendly Integration Bot - Splash Car Wash". A bot transition is not a mechanic flipping a toggle, and §7's IN_PROGRESS rate is currently measured against a denominator that includes them.
- `public.locations` — needs a migration adding `latitude`, `longitude`, `geofence_radius_m`, `geo_source`, `geo_verified_at`. No PostGIS.

Tables the plan calls for creating: `mt_punch`, `mt_gps_dwell`, `mt_device_person`, `mt_compliance_day`, `mt_punch_allocation`.

## Hard-won facts that constrain the design

Verified empirically on work order 118834534, 2026-09-16. Full detail in §5 and the rev 8 banner.

1. **Time entries fire no webhook of any kind** — timer-recorded and hand-added alike. TIME rows trip no trigger.
2. **Timer start does fire one, indirectly** — it auto-transitions OPEN → IN_PROGRESS, which emits an ordinary `WORK_ORDER_STATUS_CHANGE` indistinguishable from a manual tap. Timer stop emits nothing.
3. **Every webhook payload is a bare envelope** *as far as labor and cost go.* MaintainX documents a `newWorkOrder.costs.rows[]` block; zero of 1,338 stored events contain `newWorkOrder`, `costs`, or `durationTotal`. Ingestion and subscription config were both tested and ruled out. Treat every event as "something changed, go refetch."
   - **Narrowed 2026-09-16.** "Bare envelope" is right about labor and cost and wrong as a general statement, which matters now that the payloads are being folded into an event log. Measured across all 1,408: `WORK_ORDER_STATUS_CHANGE` carries `oldStatus`/`newStatus` and sometimes `oldSubStatus`/`newSubStatus` (the hold reason — the only place it is recorded); 25 of 56 `WORK_ORDER_CHANGE` deliveries carry `addedAssigneeIds`/`removedAssigneeIds`, occasionally team ids; nearly all carry `userId`. `oldStatus` in particular exists **nowhere else** — a refetch returns the status a work order is in now, never the one it left.
4. **Labor is latent, not lost.** Unsynced time sits in MaintainX and flushes in full on the next refetch of any kind (observed: `labor_seconds` 4145 → 11372 in one operation).
5. **`mx_updated_at` never advances for time or cost edits.** This is the governing constraint: **any sweep keyed on `updated_at` is structurally blind to exactly the rows it exists to capture.** Select candidates another way — recently-touched reactive work orders, or anything left in IN_PROGRESS past an age threshold — and refetch unconditionally.
6. **Use `duration_total_seconds`, never `quantity_hours`.** The latter is a lossy four-decimal rounding that compounds when summed.
7. Only ~25% of reactive work orders pass through IN_PROGRESS at all (18% on the cleanest cohort), so interval-derived signal is thin until the event writer has accumulated history.

## Open questions pending outside input

- Whether a time entry would fire `WORK_ORDER_CHANGE` if users had an hourly rate configured, so the entry produced a dollar amount rather than duration alone. Josh has asked the MaintainX account rep; unanswered as of 2026-09-16.
- Whether the nine non-logging mechanics will be required to log time. A management decision, needed before Phase 3b.
- Whether MaintainX can be made to require a close-out reason. Called the cheapest high-value change in §11.

## Known defect — FIXED 2026-09-16, do not chase it

The PGRST102 `"All object keys must match"` failures on `process_error` were a real bug and are **closed**. Cause: `mx-map.ts` emitted `is_thumbnail` on thumbnail attachment rows and omitted the key entirely on the others, so PostgREST rejected the whole mixed-key batch. Fixed in `696c00a`, deployed 2026-09-15.

Verified by day, `mx_webhook_event`:

| Day | Events | PGRST102 |
|---|---|---|
| 2026-09-14 | 467 | 5 |
| 2026-09-15 | 556 | 27 |
| 2026-09-16 | 332 | **0** |

Last occurrence 2026-09-15 15:36 UTC.

**Residual work, smaller than stated.** Measured 2026-09-16 before acting: the 32 rows span 12 work orders, **all 12 have been re-synced since their last failure**, and 10 of the 12 now carry mirrored attachment rows — later deliveries healed them, because the child writes are full replaces. The actual residue is two work orders whose attachments are still unmirrored: **118398492** (raw shows 1, mirror holds 0) and **119041977** (raw 2, mirror 0). Section 4 of `supabase/maintainx-event-log-01.sql` re-arms all 32 anyway — it also resets `attempts`, without which the drain passes 6 against a ceiling of 5 and re-stamps them terminal on the first hiccup.

Their EVENTS were never at risk: the event-log backfill reads `mx_webhook_event.payload` directly and is independent of whether processing succeeded.

Worth carrying forward as a pattern rather than a bug: it failed **silently**. No exception, no alert — a child write 400'd and the row simply never appeared. That is the same failure shape as items 1, 3 and 5 above, and it is the dominant risk in this codebase.

---

## Deploy ordering — 2026-09-16 Phase 0 work

**SQL applied 2026-09-16. Worker code written, validated, and NOT pushed.**

The ordering was: SQL first, push second, because the writer inserts with
`on_conflict=webhook_event_id` and until that column existed every delivery
would have failed retryable for ~25 minutes before stamping terminal.

Verified straight after applying: 1,216 rows in `mx_work_order_event`, all
`source = 'BACKFILL'`; PGRST102 count 0; the 32 deliveries back in the drain's
pending queue. Interval pairing returns 25 closed reactive `IN_PROGRESS` spans
averaging 80.9 minutes, which is the table doing the job it exists for rather
than merely holding rows.

**What is still not happening:** the deployed worker is the pre-change build,
so no NEW events are being recorded. Everything through 2026-09-16 is safe in
the backfill; accumulation restarts on push. The time sweep is likewise not
running yet, so latent labor is still latent.

The SQL is safe to re-run — every statement is `IF NOT EXISTS`, `ON CONFLICT DO
NOTHING`, or scoped to rows still carrying the PGRST102 error — and re-running
it picks up deliveries that landed since, which is a reasonable thing to do if
the push is delayed.

## Still open in Phase 0

The `locations` migration (G1), the coordinate population and reconcile, the
13-row `mt_device_person` seed (G2), and the G3 email-join check are all
untouched. They are the bulk of the manual effort and none of them was blocked
by the two items above — those were sequenced first only because the event log
loses history for every day it does not exist, and the sweep leaves labor
invisible for every hour it does not run.

---

## Phase 0 gaps — closed 2026-09-16

**Redshift is reachable through the existing `splashdb` pg_service entry** that
`apps/damage-worker/daily/export_car_counts.ps1` uses. `razayya_agent_collector`
is a SCHEMA inside splashdb, not a separate database. No new connection needed:

    PGCLIENTENCODING=UTF8 psql "service=splashdb" --csv -P pager=off -c "..."

**G1 — site coordinates. 58 of 86 rows populated, no geocoder used.**
`supabase/locations-coordinates-01.sql` (columns) +
`locations-coordinates-02-backfill.sql` (values). Derived from Connecteam punch
coordinates matched to sites on ZIP **and** street number together, then
cross-checked against 886,870 Geotab pings — 56 of 57 candidates had vehicles
sitting still at them. Site 241 (Exton, PA) had one punch and zero pings and was
excluded rather than written.

**Second pass, same day — `locations-coordinates-03-geocoded.sql` takes it to
85 of 86.** The remaining 26 were geocoded with the **US Census Bureau**
geocoder (free, no key, authoritative for US addresses), cross-checked against
**OpenStreetMap Nominatim** as an independent second opinion. 18 of 26 agreed
within 250 m; Geotab dwell arbitrated the two that did not (137, 149) and chose
Census both times.

**The acceptance rule differs by provenance and that is deliberate.** Zero
Geotab dwell FALSIFIES a punch-derived coordinate — it came from a punch
claiming somebody stood there. It says nothing about a geocoded one, which
comes from the address alone; the team simply never visits Delaware. Applying
the punch-pass rule here would have thrown away good coordinates for every site
outside the team's territory.

Uncertainty lives in `geofence_radius_m`: 150 m where both geocoders agreed
closely, up to 300 m for the two single-source sites with nothing corroborating
them (241 Exton, 252 Wilmington).

**One row is still null: Geneva III (158) has no address in the table at all.**
It needs an address before it can have a coordinate.

**G2 — device→person. `mt_device_person`, 13 rows**,
`supabase/mt-device-person-01.sql`. Verified against live data, not transcribed.

**Correction to PLAN.md §G2:** the table lists `b36D` Dylan Keith as an exact
match. It is not — Connecteam stores "Dylan  Keith" with a DOUBLE SPACE. The
trailing spaces the plan documented are real and were handled by trimming; this
one is invisible whitespace mid-string and would not have been caught by any
normalisation rule written in advance.

**G3 — answered: the email join gets 8 of 13, and it is a join AND a seed file.**
The 5 misses are exactly the 5 whose Connecteam address is personal rather than
`@splashcarwashes.com` — the two systems hold genuinely different addresses, so
normalisation cannot help. All 5 resolve unambiguously on full name. Resolved
once and stored as `mt_device_person.maintainx_user_id`.

Email comparison was done on md5 hashes so addresses never crossed between the
two databases.

**Phase 1 (Layer A, punch fidelity) is unblocked** for the 58 sites that have a
centre.
