-- maintainx-ingest-03-comment-backlog.sql
--
-- One view. It exists because PostgREST cannot express the comment pass's work
-- set (Phase 1 plan, section E), and for no other reason.
--
-- The predicate compares two COLUMNS:
--
--   comments_synced_at is null or last_message_sent_at > comments_synced_at
--
-- PostgREST filters are always column-vs-literal. `last_message_sent_at=gt.
-- comments_synced_at` sends the string "comments_synced_at" to Postgres as a
-- timestamptz literal and comes back 400. There is no horizontal-filter syntax
-- for column-vs-column in PostgREST 12, so the comparison has to live in the
-- database. A view is the smallest thing that does that and still lets the
-- caller pass `order` and `limit` as query parameters -- an RPC would have to
-- take both as arguments and hard-code the shape.
--
-- Applied out-of-band (Supabase SQL editor / MCP apply_migration), matching
-- the convention of the other scripts in this directory.

begin;

-- The predicate below is a VERBATIM copy of the one in
-- mx_work_order_comment_pending_idx (maintainx-ingest-02-comments.sql). That is
-- not stylistic: Postgres will only use a partial index when it can prove the
-- query's WHERE clause implies the index predicate, and the cheapest proof is
-- textual equality. If the two ever drift, the view still returns correct rows
-- and quietly starts seq-scanning mx_work_order every five minutes.
--
-- Note what is deliberately NOT here: `deleted_at is null`. A soft-deleted work
-- order stays in the backlog, the pass fetches its thread, MaintainX answers
-- 404, and the pass stamps the watermark anyway so the row drains out. Adding
-- the clause would be a second place for the index predicate to drift from, in
-- exchange for saving a handful of requests once.
--
-- security_invoker makes the view run as the caller rather than as its owner,
-- so mx_work_order's RLS applies to reads through it exactly as it applies to
-- reads of the table. Without it the view would be a hole in RLS: the ingest
-- worker uses the service key and would not notice, but anon would inherit the
-- owner's access. Requires PG15+; this project is on 17.6.

create or replace view mx_comment_backlog
with (security_invoker = true) as
select
  id,
  last_message_sent_at,
  comments_synced_at
from mx_work_order
where type = 'REACTIVE'
  and last_message_sent_at is not null
  and (comments_synced_at is null or last_message_sent_at > comments_synced_at);

comment on view mx_comment_backlog is
  'Work orders whose comment thread has moved since the last comment fetch. Exists because the defining predicate compares comments_synced_at against last_message_sent_at -- a column-vs-column comparison PostgREST cannot express. Predicate must stay textually identical to mx_work_order_comment_pending_idx or the partial index stops being used. Read by the comment pass with order=last_message_sent_at.desc and a limit.';

-- Supabase grants select on new public objects to anon and authenticated by
-- default. With security_invoker they would still get nothing (mx_work_order
-- has RLS on and no policies), but an explicit revoke says so without anyone
-- having to reason about it, and keeps the "exposed view" advisor quiet. The
-- ingest worker reads with the service key, which bypasses RLS and these grants
-- alike.

revoke all on mx_comment_backlog from anon, authenticated;

commit;
