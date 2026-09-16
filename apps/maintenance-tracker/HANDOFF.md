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
- `src/mx-reconcile.ts` — existing reconciliation logic; **the Phase 0 time-item sweep most likely belongs here or alongside it**
- `src/mx-map.ts` — field mapping
- `wrangler.toml` — deployment config

## Supabase tables (the data lives here, not in the repo)

- `public.mx_webhook_event` — webhook deliveries. Columns include `entity_id` (work order id), `event_type`, `payload` jsonb, `occurred_at`, `received_at`, `process_error`.
- `public.mx_work_order` — work order aggregates: `labor_seconds`, `status`, `mx_updated_at`, `synced_at`
- `public.mx_work_order_time_item` — time entries: `work_order_id`, `ordinal`, `duration_total_seconds`, `quantity_hours`, `first_seen`
- `public.mx_work_order_expenditure` — costs, stored in **cents** (`cost_per_unit_cents`, `row_total_cents`)
- `public.mx_webhook_subscription` — 7 rows, no property-filter column
- `public.mx_work_order_event` — **exists but is empty.** Declared and never populated. Writing to it is a Phase 0 task. It misled an earlier revision; do not mistake it for the event log.
- `public.locations` — needs a migration adding `latitude`, `longitude`, `geofence_radius_m`, `geo_source`, `geo_verified_at`. No PostGIS.

Tables the plan calls for creating: `mt_punch`, `mt_gps_dwell`, `mt_device_person`, `mt_compliance_day`, `mt_punch_allocation`.

## Hard-won facts that constrain the design

Verified empirically on work order 118834534, 2026-09-16. Full detail in §5 and the rev 8 banner.

1. **Time entries fire no webhook of any kind** — timer-recorded and hand-added alike. TIME rows trip no trigger.
2. **Timer start does fire one, indirectly** — it auto-transitions OPEN → IN_PROGRESS, which emits an ordinary `WORK_ORDER_STATUS_CHANGE` indistinguishable from a manual tap. Timer stop emits nothing.
3. **Every webhook payload is a bare envelope.** MaintainX documents a `newWorkOrder.costs.rows[]` block; zero of 1,338 stored events contain `newWorkOrder`, `costs`, or `durationTotal`. Ingestion and subscription config were both tested and ruled out. Treat every event as "something changed, go refetch."
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

**Residual work, small:** the ~32 historical events that failed this way are still unprocessed and need a re-drain to clear. They are not lost — the drain retries pending rows, and these were stamped as terminal failures, so clearing `processed_at` on those specific rows re-arms them.

Worth carrying forward as a pattern rather than a bug: it failed **silently**. No exception, no alert — a child write 400'd and the row simply never appeared. That is the same failure shape as items 1, 3 and 5 above, and it is the dominant risk in this codebase.
