-- maintainx-ingest-02-comments.sql
--
-- Follow-on to maintainx-ingest-01-tables.sql. Two unrelated additions ship
-- together here because both are DDL on mx_work_order and the table is still
-- small enough that a rewrite is free:
--
--   1. `comments_synced_at` -- the per-work-order watermark the comment pass
--      needs (Phase 1 plan, section E). Without it the comment pass cannot
--      run at all.
--   2. The urgency indexes the Phase 4 read path will want. Added now rather
--      than later because building them against a fully-populated table costs
--      a lock, and because the predicates they encode are conclusions from
--      the probe that are easy to forget once the plan doc is stale.
--
-- Applied out-of-band (Supabase SQL editor / MCP apply_migration), matching
-- the convention of the other scripts in this directory.

begin;

-- ---------------------------------------------------------------------------
-- 1. Comment sync watermark
-- ---------------------------------------------------------------------------
--
-- mx_work_order.synced_at covers the work order row and says nothing about
-- its comments. It cannot: MaintainX deliberately excludes comment activity
-- from `updatedAt`, so a thread can move without the work order row changing
-- at all. `last_message_sent_at` is the only signal that happened.
--
-- This column has to exist separately from the comment rows themselves.
-- `max(mx_work_order_comment.synced_at)` cannot distinguish "never checked
-- this work order" from "checked it, the thread turned out to be empty" --
-- both produce no row -- and those two states need opposite treatment: the
-- first must be retried on the next pass, the second must never be.
--
-- Nullable on purpose. NULL means never checked, which is where every work
-- order written by the ingest-01 backfill starts.
--
-- IMPORTANT for the writer: this column must stay out of the mx_work_order
-- upsert column list, exactly like first_seen_at. PostgREST builds its
-- ON CONFLICT UPDATE set from the keys present in the payload, so omitting
-- the key leaves the stored value alone -- but adding it "for completeness"
-- would reset every work order's comment watermark on the next sync and send
-- the comment pass back to the beginning.

alter table mx_work_order
  add column if not exists comments_synced_at timestamptz;

comment on column mx_work_order.comments_synced_at is
  'High-water mark for the comment pass: the last_message_sent_at value that was current when this work order''s comments were last fetched. NULL = never fetched. NOT derivable from mx_work_order_comment, because an empty thread leaves no row behind to read. Must never appear in an upsert payload.';

-- The comment pass's work set, verbatim:
--
--   select id from mx_work_order
--    where type = 'REACTIVE'
--      and last_message_sent_at is not null
--      and (comments_synced_at is null or last_message_sent_at > comments_synced_at)
--    order by last_message_sent_at desc
--    limit 100
--
-- The REACTIVE gate is the whole reason this pass is affordable: measured over
-- six months, 1,851 of ~20,000 work orders qualify. Preventive work orders
-- carry comments 0.2% of the time and are not worth a request.
--
-- This index drains itself. A work order enters it when its thread moves and
-- leaves it the moment the pass records the watermark, so in steady state it
-- holds only the backlog -- which is the size the pass is trying to measure.

create index if not exists mx_work_order_comment_pending_idx
  on mx_work_order (last_message_sent_at desc)
  where type = 'REACTIVE'
    and last_message_sent_at is not null
    and (comments_synced_at is null or last_message_sent_at > comments_synced_at);

-- ---------------------------------------------------------------------------
-- 2. Urgency indexes for the Phase 4 read path
-- ---------------------------------------------------------------------------
--
-- Both are partial on the live set. `deleted_at is null` plus the three open
-- statuses is the same live definition mx_work_order_live_idx already uses;
-- DONE / CANCELED / SKIPPED work orders are history and are served by the
-- completed_at index instead.
--
-- Preventive urgency comes from due-date RECENCY, never from overdue-ness.
-- The probe found 3,469 of 3,567 open preventive work orders (97%) past due,
-- so "overdue" selects almost the entire set and carries no signal. Sorting
-- by due_date descending puts the most recently-due work first, which is what
-- the operator page actually wants.
--
-- Note the 90-day display threshold discussed in the plan is NOT encoded here.
-- It belongs in the page's WHERE clause so that an escape hatch showing older
-- rows stays a query change, not an ingest or index change -- the rows are in
-- Postgres either way.

create index if not exists mx_work_order_pm_due_idx
  on mx_work_order (due_date desc nulls last)
  where type = 'PREVENTIVE'
    and deleted_at is null
    and status in ('OPEN', 'IN_PROGRESS', 'ON_HOLD');

-- Reactive urgency has to come from age, because reactive work orders largely
-- have no due date: 281 of 327 live reactive work orders carried none, and
-- zero were DUE_SOON or UPCOMING. (The comment at
-- apps/workorders-worker/src/index.ts asserting MaintainX auto-sets reactive
-- dueDate to the creation day is contradicted by that measurement.) Priority
-- leads the index so a priority-filtered board still gets an ordered scan.

create index if not exists mx_work_order_reactive_age_idx
  on mx_work_order (priority, mx_created_at desc)
  where type = 'REACTIVE'
    and deleted_at is null
    and status in ('OPEN', 'IN_PROGRESS', 'ON_HOLD');

commit;
