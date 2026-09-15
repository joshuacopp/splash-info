-- Let mx_work_order_attachment carry a WORK REQUEST parent as well.
--
-- WHY WIDEN RATHER THAN ADD A SIBLING TABLE
--
--   The obvious move is mx_work_request_attachment alongside the existing
--   table, matching mx_work_order_part / _expenditure / _comment. It was
--   rejected for one reason: the serve route.
--
--   Serving an attachment is the only place in this feature where a
--   permission decision happens -- the route takes an attachment id, resolves
--   its parent, resolves that parent's MaintainX location, and requires the
--   location to be in the caller's accessible set. Two tables means two
--   lookups, two permission checks, and two chances for them to drift apart.
--   One table means one check that cannot be half-fixed. The mirror-state
--   columns and the pending index are shared for free as well.
--
--   The cost is that `work_order_id` stops being NOT NULL. The CHECK below
--   buys that back: exactly one parent, enforced by the database rather than
--   by every caller remembering.
--
-- SAFE ON EXISTING DATA. At the time of writing the table holds 190 rows, all
-- with work_order_id set and no work_request_id, so `num_nonnulls(...) = 1`
-- already holds for every one of them and the constraint validates without a
-- rewrite. Run the verification block at the bottom before trusting that.
--
-- Applied out-of-band (Supabase SQL editor / MCP apply_migration), matching
-- the convention of every other script in this directory.

begin;

-- 1. The new parent. ON DELETE CASCADE mirrors the work-order side: if the
--    request goes, its attachment rows go with it. The R2 objects are NOT
--    cascaded -- nothing in this schema can reach them -- which is a known
--    orphan source shared with the work-order path.
alter table mx_work_order_attachment
  add column if not exists work_request_id bigint
    references mx_work_request (id) on delete cascade;

-- 2. work_order_id becomes optional so a request-parented row can exist.
alter table mx_work_order_attachment
  alter column work_order_id drop not null;

-- 3. Exactly one parent. Without this the nullable FK above would allow a row
--    with neither parent (unreachable, unservable, invisible) or both (whose
--    permissions would depend on which lookup the serve route happened to do
--    first -- the kind of ambiguity that becomes a security bug later).
alter table mx_work_order_attachment
  drop constraint if exists mx_work_order_attachment_one_parent;
alter table mx_work_order_attachment
  add constraint mx_work_order_attachment_one_parent
  check (num_nonnulls(work_order_id, work_request_id) = 1);

-- 4. Same access pattern as the work-order index: "every attachment on this
--    parent", which is what both the mirror and the read path ask for.
create index if not exists mx_work_order_attachment_wr_idx
  on mx_work_order_attachment (work_request_id);

commit;

-- ---------------------------------------------------------------------------
-- Verification. Expected immediately after apply:
--   total            190 (or higher if the mirror has run since)
--   wo_parented      = total
--   wr_parented      0
--   orphaned         0   <- must be 0; a non-zero here means the CHECK is not
--                           doing its job and something wrote a parentless row
-- ---------------------------------------------------------------------------
-- select count(*)                                              as total,
--        count(*) filter (where work_order_id is not null)      as wo_parented,
--        count(*) filter (where work_request_id is not null)    as wr_parented,
--        count(*) filter (where work_order_id is null
--                           and work_request_id is null)        as orphaned
--   from mx_work_order_attachment;
