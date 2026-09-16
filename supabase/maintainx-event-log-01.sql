-- maintainx-event-log-01.sql
--
-- Turn mx_work_order_event from a declared-but-empty table into the interval
-- history the maintenance tracker needs, and fold the deliveries already on
-- disk into it.
--
-- WHY THIS EXISTS
--
--   MaintainX exposes no retroactive event history. A status transition that
--   is not recorded when it is observed is gone: there is no endpoint that
--   will hand it back later, at any price. mx_work_order_event was created in
--   maintainx-ingest-01-tables.sql section 9 for exactly this and was never
--   written to, so every transition since the mirror went live exists only as
--   a raw webhook payload in mx_webhook_event, where nothing can query it as
--   an interval.
--
--   apps/maintenance-tracker/PLAN.md calls the writer the highest-value task
--   in the plan per hour spent, on the grounds that retention starts the day
--   it ships and not a day earlier. That is true going FORWARD. It is not
--   true backward, and the plan assumed it was: mx_webhook_event has held
--   every verified delivery since 2026-09-14, payload and all, and the
--   work-order events among them carry oldStatus, newStatus, occurredAt and
--   the acting userId. Two days of history that the plan wrote off as
--   forward-only is recoverable by a SELECT, and section 3 recovers it.
--
-- WHAT IT DOES
--
--   1. Adds `webhook_event_id` -- the dedup key that lets the worker write
--      this table idempotently -- and `actor_user_id`, which the original
--      DDL has no column for and which is half the question the tracker
--      asks ("when was it in progress, AND BY WHOM").
--   2. Adds a supporting index for the interval pairing.
--   3. Backfills every stored work-order delivery, source = 'BACKFILL'.
--   4. Re-arms the 32 deliveries that failed with PGRST102 (fixed in 696c00a)
--      so the drain re-applies them.
--
-- SAFE TO RE-RUN. Every statement is idempotent: the adds are IF NOT EXISTS,
-- the backfill is ON CONFLICT DO NOTHING against the unique dedup key, and the
-- re-arm only touches rows still carrying the PGRST102 error.
--
-- APPLIED 2026-09-16 via MCP apply_migration against rewokyofschtvqgxrxwl
-- (migration name `maintainx_event_log_01`). Verified immediately after:
-- 1,216 rows in mx_work_order_event, all source = 'BACKFILL'; PGRST102 count
-- 0; 32 deliveries back in the pending queue.
--
-- UNLIKE maintainx-cost-backfill-01.sql, this one IS safe to re-run -- the
-- adds are IF NOT EXISTS, the backfill is ON CONFLICT DO NOTHING on the dedup
-- key, and the re-arm is scoped to rows still carrying the error. Re-running
-- it picks up any deliveries that landed since, which is occasionally useful.
--
-- Applied out-of-band (Supabase SQL editor / MCP apply_migration), matching
-- the convention of the other scripts in this directory.

begin;

-- ---------------------------------------------------------------------------
-- 1. Columns
-- ---------------------------------------------------------------------------

-- The dedup key. Webhook delivery is at-least-once and the drain retries, so
-- without this an event-log write is either lossy (skip on retry) or
-- duplicating (insert on retry). With it the writer can upsert on conflict and
-- retry as often as it likes.
--
-- NULLABLE on purpose: rows written by a future sweep or by a backfill from
-- some source other than the delivery log have no delivery to point at, and
-- forcing one would mean inventing it. The unique index below stays plain
-- rather than partial and still permits all of them -- see the note on it.
alter table mx_work_order_event
  add column if not exists webhook_event_id uuid
    references mx_webhook_event (id) on delete set null;

-- Who did it. The original DDL carries occurred_at and the old/new values but
-- no actor, and every work-order webhook payload has carried `userId`. The
-- tracker's Layer C question is "who flipped this work order into progress",
-- which this column is the whole of the answer to.
--
-- NOT an FK to maintainx_users: that table is a daily-synced cache (see
-- CLAUDE.md -- read-only except for the sync handler), so a user created in
-- MaintainX an hour ago would fail the constraint and take the event row down
-- with it. The event log must never lose a row because a cache is behind.
alter table mx_work_order_event
  add column if not exists actor_user_id bigint;

-- ---------------------------------------------------------------------------
-- 2. Indexes
-- ---------------------------------------------------------------------------

-- The worker's on_conflict target.
--
-- NOT PARTIAL, and that is load-bearing rather than incidental. `where
-- webhook_event_id is not null` is the natural way to write this and it would
-- break the writer: Postgres only infers a partial unique index when the
-- statement repeats the predicate (`on conflict (col) where ...`), and
-- PostgREST's `on_conflict=` parameter emits the column list alone. The insert
-- would fail with "no unique or exclusion constraint matching the ON CONFLICT
-- specification" on every delivery.
--
-- Plain is also sufficient. Postgres treats NULLs as distinct in a unique
-- index, so rows written by a future sweep -- which have no delivery to point
-- at -- are unlimited and unconstrained, which is the whole reason the partial
-- form looked necessary.
create unique index if not exists mx_work_order_event_webhook_uidx
  on mx_work_order_event (webhook_event_id);

-- Interval pairing reads one work order's status changes in time order and
-- walks them in pairs. mx_work_order_event_wo_idx (work_order_id, observed_at
-- desc) already covers the per-work-order read; this one keeps the
-- status-only scan off the other five event types, which outnumber it.
create index if not exists mx_work_order_event_status_idx
  on mx_work_order_event (work_order_id, occurred_at)
  where event_type = 'STATUS_CHANGE';

create index if not exists mx_work_order_event_actor_idx
  on mx_work_order_event (actor_user_id, occurred_at desc)
  where actor_user_id is not null;

-- ---------------------------------------------------------------------------
-- 3. Backfill from the deliveries already stored
-- ---------------------------------------------------------------------------
--
-- Scoped by EVENT TYPE, not by entity_kind, and the difference is not
-- cosmetic. NEW_COMMENT_ON_WORK_ORDER is stored with entity_kind = 'COMMENT'
-- -- correctly, since the comment is the new thing -- while its entity_id is
-- the WORK ORDER the comment is on. Filtering on `entity_kind = 'WORK_ORDER'`
-- reads as obviously right and silently drops all 105 comment deliveries.
-- The five event types listed below are exactly the work-order-scoped set, so
-- work requests are excluded by construction.
--
-- DELIBERATELY INDEPENDENT OF PROCESSING OUTCOME. A delivery that failed to
-- process still observed a real transition -- the payload is the observation,
-- and the refetch it triggered is a separate concern. This is why the 32
-- PGRST102 rows contribute their events here regardless of section 4.
--
-- event_type taxonomy follows the column comment in
-- maintainx-ingest-01-tables.sql section 9, with one addition: a bare
-- WORK_ORDER_CHANGE that carries no diff keys is recorded as 'CHANGE' rather
-- than guessed at. MaintainX sends "something changed, go refetch" with no
-- indication of what, and COST_CHANGE would be an invention.

insert into mx_work_order_event
  (work_order_id, event_type, source, occurred_at, observed_at,
   old_value, new_value, actor_user_id, webhook_event_id)
select
  e.entity_id,
  case e.event_type
    when 'NEW_WORK_ORDER'            then 'CREATED'
    when 'WORK_ORDER_STATUS_CHANGE'  then 'STATUS_CHANGE'
    when 'WORK_ORDER_DELETE'         then 'DELETED'
    when 'NEW_COMMENT_ON_WORK_ORDER' then 'COMMENT'
    when 'WORK_ORDER_CHANGE'         then
      case
        when e.payload ? 'addedAssigneeIds' or e.payload ? 'removedAssigneeIds'
          or e.payload ? 'addedTeamIds'     or e.payload ? 'removedTeamIds'
        then 'ASSIGNEE_CHANGE'
        else 'CHANGE'
      end
  end                                                   as event_type,
  'BACKFILL'                                            as source,
  e.occurred_at,
  -- When we saw it. received_at is the honest value: these rows are being
  -- written now, but the observation happened when the delivery landed, and
  -- an interval computed from now() would be nonsense.
  e.received_at                                         as observed_at,
  case e.event_type
    when 'WORK_ORDER_STATUS_CHANGE' then nullif(jsonb_strip_nulls(jsonb_build_object(
      'status',    e.payload -> 'oldStatus',
      'subStatus', e.payload -> 'oldSubStatus'
    )), '{}'::jsonb)
    when 'WORK_ORDER_CHANGE' then nullif(jsonb_strip_nulls(jsonb_build_object(
      'removedAssigneeIds', e.payload -> 'removedAssigneeIds',
      'removedTeamIds',     e.payload -> 'removedTeamIds'
    )), '{}'::jsonb)
  end                                                   as old_value,
  case e.event_type
    when 'WORK_ORDER_STATUS_CHANGE' then nullif(jsonb_strip_nulls(jsonb_build_object(
      'status',    e.payload -> 'newStatus',
      'subStatus', e.payload -> 'newSubStatus'
    )), '{}'::jsonb)
    when 'WORK_ORDER_CHANGE' then nullif(jsonb_strip_nulls(jsonb_build_object(
      'addedAssigneeIds', e.payload -> 'addedAssigneeIds',
      'addedTeamIds',     e.payload -> 'addedTeamIds'
    )), '{}'::jsonb)
    -- Comment BODIES are not copied. mx_work_order_comment already holds
    -- them; duplicating employee-authored text into an append-only log that
    -- nothing prunes buys nothing and spreads the content further.
    when 'NEW_COMMENT_ON_WORK_ORDER' then nullif(jsonb_strip_nulls(jsonb_build_object(
      'commentType', e.payload -> 'type'
    )), '{}'::jsonb)
  end                                                   as new_value,
  case
    when jsonb_typeof(e.payload -> 'userId') = 'number'
    then (e.payload ->> 'userId')::bigint
  end                                                   as actor_user_id,
  e.id                                                  as webhook_event_id
from mx_webhook_event e
where e.signature_verified
  and e.entity_id is not null
  and e.event_type in (
    'NEW_WORK_ORDER', 'WORK_ORDER_STATUS_CHANGE', 'WORK_ORDER_DELETE',
    'NEW_COMMENT_ON_WORK_ORDER', 'WORK_ORDER_CHANGE'
  )
on conflict (webhook_event_id) do nothing;

-- ---------------------------------------------------------------------------
-- 4. Re-arm the PGRST102 deliveries
-- ---------------------------------------------------------------------------
--
-- 32 deliveries across 12 work orders were stamped terminal by the mixed-key
-- attachment bug fixed in 696c00a. They were a CHILD-write failure: the work
-- order itself was upserted, only the attachment rows were rejected.
--
-- Measured 2026-09-16, before this ran: all 12 work orders have been re-synced
-- since their last failure, and 10 of the 12 now carry mirrored attachment
-- rows. Two do not -- 118398492 (raw shows 1, mirror holds 0) and 119041977
-- (raw 2, mirror 0) -- so the residue is real but small.
--
-- attempts is reset to 0 as well as processed_at being cleared. Without that
-- the drain passes attempts + 1 = 6, which is already past
-- MAX_PROCESS_ATTEMPTS, and the first retryable hiccup would re-stamp the row
-- terminal without it ever having had a real attempt.

update mx_webhook_event
   set processed_at  = null,
       process_error = null,
       attempts      = 0
 where process_error like '%PGRST102%'
   and processed_at is not null;

commit;

-- ---------------------------------------------------------------------------
-- Verification -- run after committing.
-- ---------------------------------------------------------------------------
--
--   select source, event_type, count(*), min(occurred_at), max(occurred_at)
--     from mx_work_order_event group by 1, 2 order by 1, 3 desc;
--
-- Shape measured 2026-09-16 over the then-1,216 eligible deliveries. The
-- counts move with every delivery that lands before this is applied, so they
-- are a proportion to sanity-check, not a total to match:
--   STATUS_CHANGE   ~61%   old_value and new_value populated on every row
--   CREATED         ~24%   no values -- creation has no "from"
--   COMMENT          ~9%   new_value = {"commentType": ...}, NO actor
--   CHANGE           ~3%   bare WORK_ORDER_CHANGE, nothing to record
--   ASSIGNEE_CHANGE  ~2%   both sides populated
--   DELETED          ~2%
--
-- Two things worth knowing rather than rediscovering:
--   * Work-request deliveries are correctly absent (~195 of them).
--   * COMMENT rows have NO actor. Comment payloads carry no `userId` at all,
--     so "who commented" is not answerable from the webhook -- go to
--     mx_work_order_comment for that.
--
-- Interval pairing, once a few days have accumulated -- this is the shape the
-- tracker's Layer C reads, kept here rather than as a view because the tracker
-- owns its own analysis and a half-designed view would be guessed at:
--
--   select work_order_id,
--          new_value ->> 'status'                                as entered,
--          occurred_at                                           as entered_at,
--          lead(occurred_at) over w                              as left_at,
--          lead(occurred_at) over w - occurred_at                as duration,
--          actor_user_id
--     from mx_work_order_event
--    where event_type = 'STATUS_CHANGE'
--   window w as (partition by work_order_id order by occurred_at);
--
-- NOTE for whoever writes that analysis: 100 of the first 741 status changes
-- were made by user 520201, "MX Friendly Integration Bot - Splash Car Wash".
-- Automated transitions are not a mechanic flipping a toggle and must not be
-- counted as one.
