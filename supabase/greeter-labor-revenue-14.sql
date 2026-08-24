-- ===========================================================================
-- greeter-labor-revenue-14.sql
-- Labor budget and revenue goal, with the trending figures read off them.
-- ===========================================================================
--
-- RUN AFTER greeter-capture-13.sql. This file drops and recreates
-- location_daily_live, and it expects the capture_pct that 13 installed to
-- already be on the table — recreating the view against the old column would
-- freeze the wrong shape back into the reading surface.
--
-- ---------------------------------------------------------------------------
-- WHAT THIS ADDS
-- ---------------------------------------------------------------------------
-- A site is given a labor BUDGET and a revenue GOAL for a calendar month, in
-- dollars. Somebody at the site periodically reads a TRENDING figure off the
-- internal reports — the projected month-end number — and types it onto the
-- site-wide day log. The percentage between them is what gets read aloud on
-- the Morning call:
--
--     labor trend %   = labor trend   / labor budget  * 100
--     revenue trend % = revenue trend / revenue goal  * 100
--
-- Same arithmetic both times, opposite meanings, and this is the single most
-- important thing to know about these two numbers:
--
--     LABOR OVER 100% IS BAD.  The site is projected to spend more on labor
--                              than it was budgeted.
--     REVENUE OVER 100% IS GOOD. The site is projected to beat its goal.
--
-- Nothing in this file grades them — the database stores the percentage and
-- the application colours it. But anything that ever does grade them has to
-- carry that asymmetry, and the obvious "over goal is green" rule is exactly
-- backwards for half of this feature.
--
-- ---------------------------------------------------------------------------
-- WHY A MONTH-KEYED TABLE AND NOT A GOAL WINDOW
-- ---------------------------------------------------------------------------
-- greeter_goals already resolves per-site targets over arbitrary date ranges,
-- and reusing it was the obvious move. It is the wrong home for these two.
--
-- Goal windows are allowed to OVERLAP, and greeter_goal_for() resolves the
-- collision by picking the SHORTEST window covering the day — a promo week
-- laid over a monthly baseline. That rule is right for a capture target and
-- actively destructive for a budget: a three-day flash-sale window with no
-- labor budget on it would resolve as the winner for those days and blank the
-- month's budget out from under them. The site would silently lose its
-- denominator mid-month.
--
-- A budget is stated per calendar month and there is exactly one of them, so
-- the key is (site, month) and there is no resolution rule to get wrong.
--
-- ---------------------------------------------------------------------------
-- WHY THE FIGURES ARE SNAPSHOTTED ONTO THE DAY ROW
-- ---------------------------------------------------------------------------
-- labor_budget and revenue_goal are copied onto location_daily at submit time,
-- the same way capture_goal_pct and dob_goal already are, so the trend
-- percentages can be GENERATED columns that cannot drift from their inputs and
-- so history keeps reading the way it read at the time. Editing a month's
-- budget after the fact therefore does NOT move the days already logged
-- against it — call site_restamp_monthly_targets() for that, exactly as
-- greeter_restamp_goals() exists for the goal columns.
--
-- ---------------------------------------------------------------------------
-- THESE ARE LEVELS. NEVER SUM THEM.
-- ---------------------------------------------------------------------------
-- Every other dollar column on location_daily is a DAY's worth of something
-- and adding seven of them gives you a week. These four are not: each one is a
-- MONTH-TO-DATE projection that happens to have been recorded on a day. Seven
-- days of a $24,000 budget is $24,000, not $168,000.
--
-- They behave like total_members, which has the same hazard and the same rule:
-- read the value at the LATEST business_date in the window, never a SUM and
-- never an average. location_period_rows() returns them per day and does not
-- aggregate, which keeps that decision in one place — the report's aggregator.
--
-- ---------------------------------------------------------------------------
-- ALL FOUR TYPED FIELDS ARE OPTIONAL
-- ---------------------------------------------------------------------------
-- A site with no budget set, or a day where nobody had a fresh trending
-- number, is a normal state and not an error. Both percentages are NULL unless
-- both of their inputs are present and the denominator is positive. NULL means
-- "no answer", which is the truth; a zero would mean "trending at nothing",
-- which is a claim.
-- ===========================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. site_monthly_targets — one row per site per calendar month.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS site_monthly_targets (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Both carried, matching greeter_goals: site_number is the join key and
  -- location_code is what the screens filter and display on. Resolved
  -- server-side from one typed site number, never from two typed fields.
  site_number       integer NOT NULL,
  location_code     text    NOT NULL,

  -- THE FIRST OF THE MONTH, always. Stored as a date rather than a
  -- (year, month) pair so every comparison in this file is plain date
  -- arithmetic against business_date, with no casting at the call site.
  month             date NOT NULL,
  CONSTRAINT site_monthly_targets_month_is_first
    CHECK (month = date_trunc('month', month)::date),

  -- Dollars for the whole month. Either may be NULL: a site that budgets
  -- labor but sets no revenue goal is a real and supported state.
  labor_budget      numeric(12,2),
  revenue_goal      numeric(12,2),
  CONSTRAINT site_monthly_targets_labor_budget_nonneg
    CHECK (labor_budget IS NULL OR labor_budget >= 0),
  CONSTRAINT site_monthly_targets_revenue_goal_nonneg
    CHECK (revenue_goal IS NULL OR revenue_goal >= 0),

  -- A row exists only to carry these two numbers, so a row carrying neither is
  -- a row that does nothing except make the month look configured. Clearing
  -- both is a DELETE, and the screens send one.
  CONSTRAINT site_monthly_targets_not_empty
    CHECK (labor_budget IS NOT NULL OR revenue_goal IS NOT NULL),

  note              text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid NOT NULL,
  created_by_email  text NOT NULL,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  updated_by        uuid,
  updated_by_email  text
);

-- No partial-index cleverness and no overlap handling: one site, one month,
-- one row. This is the constraint the whole design rests on, and it is why
-- there is no resolver ORDER BY anywhere below.
CREATE UNIQUE INDEX IF NOT EXISTS idx_site_monthly_targets_unique
  ON site_monthly_targets (site_number, month);
CREATE INDEX IF NOT EXISTS idx_site_monthly_targets_code
  ON site_monthly_targets (location_code, month DESC);

COMMENT ON TABLE site_monthly_targets IS
  'Per-site labor budget and revenue goal for one calendar month. Deliberately '
  'NOT stored as a greeter_goals window: goal windows may overlap and resolve '
  'shortest-span-wins, which would let a short window blank a month budget.';
COMMENT ON COLUMN site_monthly_targets.month IS
  'First day of the month. Enforced by site_monthly_targets_month_is_first.';
COMMENT ON COLUMN site_monthly_targets.labor_budget IS
  'Dollars budgeted for labor across the whole month. Compared against the '
  'trending figure typed onto location_daily. OVER 100% IS BAD.';
COMMENT ON COLUMN site_monthly_targets.revenue_goal IS
  'Dollars of revenue targeted across the whole month. OVER 100% IS GOOD — '
  'the opposite of labor, which shares this table.';

DROP TRIGGER IF EXISTS trg_site_monthly_targets_updated_at ON site_monthly_targets;
CREATE TRIGGER trg_site_monthly_targets_updated_at
  BEFORE UPDATE ON site_monthly_targets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE site_monthly_targets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE site_monthly_targets FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE site_monthly_targets TO service_role;

-- ---------------------------------------------------------------------------
-- 2. The reading surface has to come down before the table changes.
-- ---------------------------------------------------------------------------
-- location_daily_live is `SELECT *`, and Postgres expands the star ONCE, at
-- CREATE time, then stores the resolved column list. CREATE OR REPLACE VIEW
-- can only APPEND to that list, and cannot see columns added to the base table
-- afterwards. So a view left standing here would keep serving the old shape
-- and the six new columns would be invisible to every function that reads it.
--
-- greeter_daily_live is untouched: greeter rows carry no labor or revenue.
--
-- Nothing else depends on these columns. The functions below are all
-- LANGUAGE sql with string bodies, which Postgres does not dependency-track,
-- so they survive the drop and re-resolve on next call. No CASCADE needed, and
-- none wanted — if a real dependent ever appears, this should fail loudly.
DROP VIEW IF EXISTS location_daily_live;

-- ---------------------------------------------------------------------------
-- 3. location_daily — the four typed columns and the two generated ones.
-- ---------------------------------------------------------------------------
-- Named CHECKs throughout, matching house_accounts and churn_pct: the
-- verification queries at the foot of this file look them up by name, and an
-- inline unnamed CHECK auto-names to `..._check` and would fail that lookup on
-- any database built from greeter-scorecard-tables.sql rather than from here.

-- Snapshotted from site_monthly_targets at submit time — see the header.
ALTER TABLE location_daily
  ADD COLUMN IF NOT EXISTS labor_budget numeric(12,2);
ALTER TABLE location_daily
  ADD COLUMN IF NOT EXISTS revenue_goal numeric(12,2);

-- Typed in by the site, off the internal reports.
ALTER TABLE location_daily
  ADD COLUMN IF NOT EXISTS labor_trend numeric(12,2);
ALTER TABLE location_daily
  ADD COLUMN IF NOT EXISTS revenue_trend numeric(12,2);

ALTER TABLE location_daily
  DROP CONSTRAINT IF EXISTS location_daily_labor_budget_nonneg;
ALTER TABLE location_daily
  ADD CONSTRAINT location_daily_labor_budget_nonneg
  CHECK (labor_budget IS NULL OR labor_budget >= 0);

ALTER TABLE location_daily
  DROP CONSTRAINT IF EXISTS location_daily_revenue_goal_nonneg;
ALTER TABLE location_daily
  ADD CONSTRAINT location_daily_revenue_goal_nonneg
  CHECK (revenue_goal IS NULL OR revenue_goal >= 0);

ALTER TABLE location_daily
  DROP CONSTRAINT IF EXISTS location_daily_labor_trend_nonneg;
ALTER TABLE location_daily
  ADD CONSTRAINT location_daily_labor_trend_nonneg
  CHECK (labor_trend IS NULL OR labor_trend >= 0);

ALTER TABLE location_daily
  DROP CONSTRAINT IF EXISTS location_daily_revenue_trend_nonneg;
ALTER TABLE location_daily
  ADD CONSTRAINT location_daily_revenue_trend_nonneg
  CHECK (revenue_trend IS NULL OR revenue_trend >= 0);

-- Both percentages guard on the DENOMINATOR being positive, not merely
-- non-null. A budget of exactly 0.00 is a legal row — a site told to spend
-- nothing on labor — and dividing by it would raise, taking the whole
-- submission down with it. NULL is the honest answer for "what percentage of
-- nothing is this": there isn't one.
--
-- numeric(6,2) tops out at 9999.99, which is four figures of overspend and far
-- past any number worth reading aloud. A site that manages to exceed it has a
-- data-entry problem, and an overflow error is a better outcome than a
-- plausible-looking wrong number on the Morning call.
ALTER TABLE location_daily
  ADD COLUMN IF NOT EXISTS labor_trend_pct numeric(6,2)
  GENERATED ALWAYS AS (
    CASE WHEN labor_budget > 0 AND labor_trend IS NOT NULL
      THEN ROUND(labor_trend * 100 / labor_budget, 2)
    END
  ) STORED;

ALTER TABLE location_daily
  ADD COLUMN IF NOT EXISTS revenue_trend_pct numeric(6,2)
  GENERATED ALWAYS AS (
    CASE WHEN revenue_goal > 0 AND revenue_trend IS NOT NULL
      THEN ROUND(revenue_trend * 100 / revenue_goal, 2)
    END
  ) STORED;

COMMENT ON COLUMN location_daily.labor_budget IS
  'Snapshot of site_monthly_targets.labor_budget for this row''s month, taken '
  'at submit time. A MONTH figure sitting on a day row — never SUM it. Move it '
  'with site_restamp_monthly_targets(), not by hand.';
COMMENT ON COLUMN location_daily.labor_trend IS
  'Projected month-end labor spend, read off the internal reports. A MONTH '
  'figure on a day row — never SUM it; read the latest day in the window.';
COMMENT ON COLUMN location_daily.labor_trend_pct IS
  'labor_trend / labor_budget * 100. OVER 100 IS BAD: projected to overspend.';
COMMENT ON COLUMN location_daily.revenue_goal IS
  'Snapshot of site_monthly_targets.revenue_goal for this row''s month. A '
  'MONTH figure on a day row — never SUM it.';
COMMENT ON COLUMN location_daily.revenue_trend IS
  'Projected month-end revenue, read off the internal reports. A MONTH figure '
  'on a day row — never SUM it; read the latest day in the window.';
COMMENT ON COLUMN location_daily.revenue_trend_pct IS
  'revenue_trend / revenue_goal * 100. OVER 100 IS GOOD: projected to beat '
  'goal. The opposite reading from labor_trend_pct on the same row.';

-- ---------------------------------------------------------------------------
-- 4. Put the reading surface back.
-- ---------------------------------------------------------------------------
-- DROP VIEW took the grants and the comment with it, so both are restated
-- here rather than assumed. Recreated with the same `SELECT *` for the same
-- reason it was written that way: it reads as "the table, minus the struck-out
-- rows", and it now picks up the six columns added above.
CREATE VIEW location_daily_live AS
  SELECT * FROM location_daily WHERE voided_at IS NULL;

REVOKE ALL ON location_daily_live FROM PUBLIC;
GRANT SELECT ON location_daily_live TO service_role;

COMMENT ON VIEW location_daily_live IS
  'location_daily minus voided rows. Every reporting function reads this, not '
  'the table. Recreated by greeter-labor-revenue-14.sql to pick up the labor '
  'and revenue columns — SELECT * freezes its column list at CREATE time, so '
  'this view must be dropped and recreated whenever location_daily changes.';

-- ---------------------------------------------------------------------------
-- 5. site_monthly_target_for() — which targets cover a day.
-- ---------------------------------------------------------------------------
-- Deliberately shaped like greeter_goal_for() so the two read the same at the
-- call site, but with none of its ORDER BY: one site and one month is one row
-- by unique index, so there is nothing to resolve and no tie to break.
--
-- Returns a ROW rather than two scalars for the same reason greeter_goal_for
-- does — both numbers come from the same record, and two separate lookups
-- would be two chances to pair a budget with the wrong month's goal.
--
-- No row when the month was never configured, and callers stamp NULLs. That is
-- already what a NULL labor_budget on a day row means.
CREATE OR REPLACE FUNCTION site_monthly_target_for(
  p_site_number   integer,
  p_business_date date
)
RETURNS TABLE (
  labor_budget numeric,
  revenue_goal numeric
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    t.labor_budget,
    t.revenue_goal
  FROM site_monthly_targets t
  WHERE t.site_number = p_site_number
    AND t.month = date_trunc('month', p_business_date)::date
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION site_monthly_target_for(integer, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION site_monthly_target_for(integer, date) TO service_role;

-- ---------------------------------------------------------------------------
-- 6. site_restamp_monthly_targets() — push an edited target onto logged days.
-- ---------------------------------------------------------------------------
-- The counterpart to greeter_restamp_goals(), and it follows the same rules
-- for the same reasons:
--
--   * IT RE-RESOLVES rather than applying whatever it was called about, so the
--     DELETE path can call it too — with the row gone the days resolve to
--     nothing and the NULL-out falls out for free.
--   * It reads location_daily_live, so a voided day is never re-stamped, and
--     the UPDATE needs no voided_at predicate of its own: it joins on ids that
--     the SELECT could not have produced for a struck-out row.
--   * LEFT JOIN LATERAL, not an inner one. When no target covers the month the
--     resolver returns no rows, and an inner join would skip the day instead
--     of clearing the stale budget off it. Clearing is the point on delete.
--   * IS DISTINCT FROM on both columns keeps the count meaning "days that
--     changed", and stops the updated_at trigger firing on rows nothing
--     happened to.
--   * updated_by / updated_by_email are left alone. Overwriting them would
--     destroy the record of who typed the day's numbers to replace it with a
--     name that isn't a person.
--
-- Only location rows: greeter_daily carries no labor or revenue columns, so
-- there is no greeter-side count to return and no second UPDATE below.
--
-- Takes a MONTH rather than a from/to pair, because that is the grain the
-- targets are set at and a partial month cannot be re-stamped coherently.
CREATE OR REPLACE FUNCTION site_restamp_monthly_targets(
  p_site_number integer,
  p_month       date
)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_month    date := date_trunc('month', p_month)::date;
  v_location integer := 0;
BEGIN
  WITH resolved AS (
    SELECT
      l.id,
      f.labor_budget,
      f.revenue_goal
    FROM location_daily_live l
    LEFT JOIN LATERAL site_monthly_target_for(l.site_number, l.business_date) f
      ON true
    WHERE l.site_number = p_site_number
      AND l.business_date >= v_month
      AND l.business_date < (v_month + interval '1 month')::date
  ),
  changed AS (
    UPDATE location_daily l
       SET labor_budget = r.labor_budget,
           revenue_goal = r.revenue_goal
      FROM resolved r
     WHERE l.id = r.id
       AND (l.labor_budget IS DISTINCT FROM r.labor_budget
         OR l.revenue_goal IS DISTINCT FROM r.revenue_goal)
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_location FROM changed;

  RETURN v_location;
END
$$;

REVOKE ALL ON FUNCTION site_restamp_monthly_targets(integer, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION site_restamp_monthly_targets(integer, date) TO service_role;

-- ---------------------------------------------------------------------------
-- 7. location_period_rows() — pass all six through, unaggregated.
-- ---------------------------------------------------------------------------
-- DROPPED RATHER THAN REPLACED: CREATE OR REPLACE cannot change a RETURNS
-- TABLE shape and this one gains six columns. The signature is unchanged, so
-- the REVOKE/GRANT pair after the body still names the same five argument
-- types.
--
-- Reproduced verbatim from greeter-void-12.sql apart from the six columns and
-- these comments. If that file is ever revised, this body has to be brought
-- forward with it — there is no mechanism that would catch the drift.
--
-- THE SIX ARE PASSED THROUGH, NOT AGGREGATED, and that is not laziness. Every
-- one of them is a month-to-date figure recorded on a day, so there is no
-- correct SUM and no correct AVG over a multi-day window — only "the value as
-- of the latest day", which is a decision about which day to read and belongs
-- in the caller that knows the window. Same treatment as total_members.
DROP FUNCTION IF EXISTS location_period_rows(date, date, integer, integer, text[]);

CREATE OR REPLACE FUNCTION location_period_rows(
  p_date_from      date,
  p_date_to        date,
  p_location_id    integer DEFAULT NULL,
  p_site_number    integer DEFAULT NULL,
  p_location_codes text[]  DEFAULT NULL
)
RETURNS TABLE (
  -- The site day's own row id, carried purely so the report's drill-through can
  -- offer a Void button. Every other column here is a number to read; this one
  -- is a handle to act on, which is why it leads rather than hiding among them.
  -- location_daily_live has one row per (location, date) and this function does
  -- not aggregate the site side, so the id stays one-to-one with the row.
  id                 uuid,
  business_date      date,
  location_id        integer,
  site_number        integer,
  location_code      text,
  total_cars         integer,
  wash_sales         integer,
  -- Adjacent to rewashes because they are the same kind of fact and are
  -- subtracted together; a reader who finds one should trip over the other.
  house_accounts     integer,
  rewashes           integer,
  package_dollars    numeric,
  extras_dollars     numeric,
  sign_ups           integer,
  reactivations      integer,
  cancellations      integer,
  total_members      integer,
  net_members        integer,
  capture_pct        numeric,
  dob                numeric,
  capture_goal_pct   numeric,
  dob_goal           numeric,
  -- After the goal-graded block on purpose: churn has no goal, and slotting it
  -- in among columns that do invites someone to give it one to match.
  churn_pct          numeric,
  google_reviews     integer,
  -- The month block, kept together and kept LAST. Every column above is a
  -- day's worth of something; these six are a month's, and separating them
  -- from the daily columns is the only structural hint a reader gets that
  -- SUMming down this part of the result is meaningless.
  labor_budget       numeric,
  labor_trend        numeric,
  labor_trend_pct    numeric,
  revenue_goal       numeric,
  revenue_trend      numeric,
  revenue_trend_pct  numeric,
  scanned_wash_sales bigint,
  greeters_logged    bigint
)
LANGUAGE sql
STABLE
AS $$
  WITH site AS (
    SELECT
      l.id,
      l.business_date,
      l.location_id,
      l.site_number,
      l.location_code,
      l.total_cars,
      l.wash_sales,
      l.house_accounts,
      l.rewashes,
      l.package_dollars,
      l.extras_dollars,
      l.sign_ups,
      l.reactivations,
      l.cancellations,
      l.total_members,
      l.net_members,
      l.capture_pct,
      l.dob,
      l.capture_goal_pct,
      l.dob_goal,
      l.churn_pct,
      l.google_reviews,
      l.labor_budget,
      l.labor_trend,
      l.labor_trend_pct,
      l.revenue_goal,
      l.revenue_trend,
      l.revenue_trend_pct
    FROM location_daily_live l
    WHERE l.business_date >= p_date_from
      AND l.business_date <= p_date_to
      AND (p_location_id    IS NULL OR l.location_id   =  p_location_id)
      AND (p_site_number    IS NULL OR l.site_number   =  p_site_number)
      AND (p_location_codes IS NULL OR l.location_code = ANY (p_location_codes))
  ),
  scanned AS (
    -- Every greeter at the site, no name filter — same reasoning as section 6.
    SELECT
      g.business_date,
      g.location_id,
      SUM(COALESCE(g.wash_sales, 0))::bigint AS scanned,
      COUNT(*)::bigint                       AS greeters
    FROM greeter_daily_live g
    JOIN site s
      ON s.business_date = g.business_date
     AND s.location_id   = g.location_id
    GROUP BY g.business_date, g.location_id
  )
  SELECT
    s.id,
    s.business_date,
    s.location_id,
    s.site_number,
    s.location_code,
    s.total_cars,
    s.wash_sales,
    s.house_accounts,
    s.rewashes,
    s.package_dollars,
    s.extras_dollars,
    s.sign_ups,
    s.reactivations,
    s.cancellations,
    s.total_members,
    s.net_members,
    s.capture_pct,
    s.dob,
    s.capture_goal_pct,
    s.dob_goal,
    s.churn_pct,
    s.google_reviews,
    s.labor_budget,
    s.labor_trend,
    s.labor_trend_pct,
    s.revenue_goal,
    s.revenue_trend,
    s.revenue_trend_pct,
    COALESCE(sc.scanned, 0)::bigint,
    COALESCE(sc.greeters, 0)::bigint
  FROM site s
  LEFT JOIN scanned sc
    ON sc.business_date = s.business_date
   AND sc.location_id   = s.location_id
  ORDER BY s.business_date DESC, s.location_code;
$$;

REVOKE ALL ON FUNCTION location_period_rows(date, date, integer, integer, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION location_period_rows(date, date, integer, integer, text[]) TO service_role;

COMMIT;

-- ===========================================================================
-- Post-run verification. Run these separately; none of them change anything.
-- ===========================================================================
--
-- 1. All six columns landed, and the two percentages are generated.
--
-- SELECT column_name, data_type, is_generated
--   FROM information_schema.columns
--  WHERE table_name = 'location_daily'
--    AND column_name IN ('labor_budget', 'labor_trend', 'labor_trend_pct',
--                        'revenue_goal', 'revenue_trend', 'revenue_trend_pct')
--  ORDER BY column_name;
-- -- expect 6 rows; *_trend_pct show is_generated = 'ALWAYS'.
--
-- 2. The view was rebuilt and can see them. This is the check that catches a
--    stale `SELECT *` — it returns nothing if the view was left standing.
--
-- SELECT column_name
--   FROM information_schema.columns
--  WHERE table_name = 'location_daily_live'
--    AND column_name LIKE '%trend%'
--  ORDER BY column_name;
-- -- expect labor_trend, labor_trend_pct, revenue_trend, revenue_trend_pct.
--
-- 3. The named CHECKs exist under the names the fresh-install file uses.
--
-- SELECT conname FROM pg_constraint
--  WHERE conrelid = 'location_daily'::regclass
--    AND (conname LIKE '%labor%' OR conname LIKE '%revenue%')
--  ORDER BY conname;
-- -- expect the four *_nonneg CHECKs. The parentheses matter: AND binds tighter
-- -- than OR, so dropping them returns every constraint on the table.
--
-- 4. The arithmetic, end to end. Writes and rolls back.
--
-- BEGIN;
--   UPDATE location_daily
--      SET labor_budget = 24000, labor_trend = 22000,
--          revenue_goal = 80000, revenue_trend = 84000
--    WHERE id = (SELECT id FROM location_daily_live ORDER BY business_date DESC LIMIT 1);
--   SELECT labor_trend_pct, revenue_trend_pct
--     FROM location_daily
--    WHERE id = (SELECT id FROM location_daily_live ORDER BY business_date DESC LIMIT 1);
--   -- expect 91.67 and 105.00. Labor under 100 is GOOD; revenue over 100 is GOOD.
-- ROLLBACK;
--
-- 5. A zero budget divides to NULL rather than raising.
--
-- SELECT (SELECT labor_trend_pct FROM (SELECT 0::numeric(12,2) AS labor_budget,
--         500::numeric(12,2) AS labor_trend) x
--         CROSS JOIN LATERAL (SELECT CASE WHEN x.labor_budget > 0
--           THEN ROUND(x.labor_trend * 100 / x.labor_budget, 2) END AS labor_trend_pct) y)
--        IS NULL AS zero_budget_is_null;
-- -- expect true.
--
-- 6. The resolver finds a month, and finds nothing for an unconfigured one.
--
-- SELECT * FROM site_monthly_target_for(148, current_date);
-- ===========================================================================
