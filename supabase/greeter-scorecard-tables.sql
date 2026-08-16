-- Greeter scorecard schema — daily per-greeter and per-location sales numbers.
--
-- Replaces the per-person monthly spreadsheet tab whose columns were:
--   Date | Sign Up Goal | Extras Goal | Total Cars | ALC | Package $ |
--   Extras $ | D.O.B. | Sign Ups | Capture %
--
-- Operator runs this in the Supabase SQL editor before the performance-worker
-- and apps/web briefs that touch `greeter_daily`, `location_daily`, or
-- `greeter_goals`.
--
-- IF THIS SCHEMA IS ALREADY LIVE, DO NOT RUN THIS FILE. greeter-scorecard-
-- alter-01.sql migrates an existing database to the same shape this file now
-- creates. Exactly one of the two, never both.
--
-- METRIC VOCABULARY (confirmed with Josh 2026-08-15) — read this before
-- touching any of the arithmetic:
--
--   total_cars       Every car through the tunnel, unlimited members included.
--                    SITE-LEVEL ONLY (location_daily). Deliberately absent from
--                    greeter_daily: every greeter on a shift would type the same
--                    number and summing across greeters would multiply the
--                    site's day by the size of the crew.
--   wash_sales       "ALC" / a-la-carte on the source report: NON-unlimited,
--                    saleable cars. This is the denominator for BOTH derived
--                    metrics. Named `wash_sales` (not `alc`) because that is
--                    how the column reads on the report the numbers come from.
--   rewashes         Re-runs, on both tables. Authoritative figure is the
--                    site's; the greeter copy is optional and informational.
--   cancellations    Memberships cancelled that day. Site-level only.
--   total_members    Active members as of that day. A LEVEL, not a delta — it
--                    is never summed across days, only read at the latest date
--                    in a window. Site-level only.
--   net_members      Generated: sign_ups - cancellations. The day's delta.
--   package_dollars  Wash package revenue.
--   extras_dollars   Wash extras revenue.
--   sign_ups         Unlimited memberships sold.
--   shift_start /    The greeter's shift window as a bare `time`. Both or
--   shift_end        neither; end < start means an overnight shift.
--   hours_worked     Generated from the shift window.
--   wash_sales_per_hour  Generated: wash_sales over the shift duration.
--   dob              "Dollars over base" = (package $ + extras $) / wash_sales.
--   capture_pct      sign_ups / wash_sales, as a PERCENTAGE (0-100).
--
--   Capture is divided by wash_sales, NOT total_cars: a customer already on an
--   unlimited plan cannot sign up again, so they were never an opportunity and
--   must not count against the greeter.
--
-- `dob` and `capture_pct` are GENERATED ALWAYS ... STORED rather than
-- application-computed. Two reasons: the arithmetic cannot drift between the
-- submit path, the CSV export, and any future rollup; and stored generated
-- columns are indexable and filterable, which read-time computation is not.
-- Both are NULL when wash_sales is 0 or NULL — a zero denominator is "no
-- opportunities that day", which is genuinely unknown, not 0%.
--
-- capture_pct is stored as a raw percentage (62.40 = 62.4%) to match the
-- existing `performance_tracking.capture_rate` convention. Do not switch one
-- without the other.
--
-- Conventions follow forms-tables.sql / promo-tables.sql:
--   - uuid PK, `gen_random_uuid()` default.
--   - `uuid NOT NULL` actor columns, no FK into auth.users.
--   - timestamptz NOT NULL DEFAULT now() for created_at.
--   - Indexes co-located with their table.
--
-- LOCATION KEYING — deliberate, do not "simplify":
--   Each row carries all three of location_id / site_number / location_code
--   and has NO foreign key to `locations`.
--     * `locations` has no location_code column at all; its business key is
--       site_number (see packages/db-supabase/src/locations.ts).
--     * `location_code` is denormalized purely so the caller-scoping filter
--       (`applyLocationScope`, forms-worker/src/db/admin-submissions.ts:35)
--       can restrict location admins to their own sites. session.locations is
--       an array of location_codes aggregated from user_permissions.
--     * `site_number` is the stable cross-app join key. location_code has been
--       observed to diverge between tables for the same site (site #196 is
--       `rensselear` in pricing_simple and `rensselaer` in the damage schema),
--       so anything that needs to JOIN should use site_number and leave
--       location_code to the scope filter.
--     * No FK to locations(id) because that column's integer width isn't
--       pinned by any checked-in DDL (the table predates this repo) and a
--       width mismatch would fail the migration. promo_locations sets the same
--       precedent for skipping the FK.
--   The worker resolves all three server-side at submit from the picked
--   location and HARD-REJECTS when location_code can't be resolved, so a row
--   can never land with a null/garbage scope value and leak across sites.

-- ===========================================================================
-- 1. greeter_goals — targets, versioned by effective date.
-- ===========================================================================
-- Goals live here rather than on each submission so an admin sets them once
-- per location per period. They are ALSO snapshotted onto every greeter_daily
-- / location_daily row at submit time (see the goal columns below): without
-- the snapshot, editing a goal would silently rewrite history and change
-- whether a past month looks like it hit target.
--
-- Lookup is "the row for this location whose [effective_from, effective_to]
-- window contains the business_date", with effective_to NULL meaning open-
-- ended. The exclusion constraint below makes overlapping windows for one
-- location impossible, so the lookup can never be ambiguous.
--
-- Both rate goals are expressed in the SAME UNITS as the actuals they grade:
-- capture_goal_pct against capture_pct, dob_goal against dob. A raw sign-up
-- count goal (what this used to be) wasn't comparable between a 40-car Tuesday
-- and a 400-car Saturday; capture % already normalizes for opportunity.
CREATE TABLE IF NOT EXISTS greeter_goals (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_number       integer NOT NULL,
  location_code     text NOT NULL,
  effective_from    date NOT NULL,
  effective_to      date,                                   -- NULL = open-ended (current goal)
  capture_goal_pct  numeric(6,2)  NOT NULL,
  dob_goal          numeric(12,2) NOT NULL,
  -- Total ACTIVE members the site should have reached by month end. A level,
  -- not net adds and not gross sign-ups, so it is graded against the most
  -- recent location_daily.total_members in the window, never against a sum.
  -- Nullable: not every site sets a membership target.
  member_goal_month_end integer,
  note              text,                                   -- e.g. "summer promo push"
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid NOT NULL,                          -- auth.users.id
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT greeter_goals_window_valid
    CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT greeter_goals_capture_goal_pct_range
    CHECK (capture_goal_pct >= 0 AND capture_goal_pct <= 100),
  CONSTRAINT greeter_goals_dob_goal_nonneg
    CHECK (dob_goal >= 0),
  CONSTRAINT greeter_goals_member_goal_nonneg
    CHECK (member_goal_month_end IS NULL OR member_goal_month_end >= 0)
);
CREATE INDEX IF NOT EXISTS idx_greeter_goals_site        ON greeter_goals (site_number, effective_from DESC);
CREATE INDEX IF NOT EXISTS idx_greeter_goals_code        ON greeter_goals (location_code);
CREATE INDEX IF NOT EXISTS idx_greeter_goals_current     ON greeter_goals (site_number) WHERE effective_to IS NULL;

-- Overlap guard. daterange with '[]' bounds treats effective_to as inclusive;
-- COALESCE to 'infinity' models the open-ended row. Requires btree_gist for
-- the `site_number WITH =` operand alongside the range operand.
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE greeter_goals DROP CONSTRAINT IF EXISTS greeter_goals_no_overlap;
ALTER TABLE greeter_goals ADD CONSTRAINT greeter_goals_no_overlap
  EXCLUDE USING gist (
    site_number WITH =,
    daterange(effective_from, COALESCE(effective_to, 'infinity'::date), '[]') WITH &&
  );

-- ===========================================================================
-- 2. greeter_daily — one row per greeter per day per location.
-- ===========================================================================
-- Grain is per DAY, not per shift: the spreadsheet this replaces has one dated
-- row per person, and a split shift is still one person's day. The unique key
-- makes re-submitting the same (location, greeter, date) an UPSERT — the
-- second submission corrects the first instead of double-counting. If per-shift
-- grain is ever needed, add a `shift_label` column and widen the unique key;
-- do not drop the constraint.
CREATE TABLE IF NOT EXISTS greeter_daily (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_date       date NOT NULL,

  -- Location keying — see the header note. All three resolved server-side.
  location_id         integer NOT NULL,
  site_number         integer NOT NULL,
  location_code       text    NOT NULL,

  -- Greeter identity. beekeeper_user_id is the stable key (Beekeeper's user
  -- uuid, matching beekeeper_users.id); greeter_name is a display snapshot so
  -- historical rows still read correctly after someone is renamed or leaves
  -- and drops out of the roster cache.
  beekeeper_user_id   text NOT NULL,
  greeter_name        text NOT NULL,

  -- Typed-in metrics. No total_cars here on purpose — see the header note.
  wash_sales          integer       CHECK (wash_sales IS NULL OR wash_sales >= 0),
  rewashes            integer       CHECK (rewashes IS NULL OR rewashes >= 0),
  package_dollars     numeric(12,2),
  extras_dollars      numeric(12,2),
  sign_ups            integer       CHECK (sign_ups IS NULL OR sign_ups >= 0),

  -- Shift window, bare `time` (no date, no zone). End before start = overnight.
  shift_start         time,
  shift_end           time,

  -- Goal snapshot, copied from greeter_goals at submit time. NULL when no
  -- goal window covered business_date.
  capture_goal_pct    numeric(6,2),
  dob_goal            numeric(12,2),

  -- Derived. See the header note on why these are generated, not computed.
  capture_pct         numeric(6,2) GENERATED ALWAYS AS (
                        CASE WHEN COALESCE(wash_sales, 0) > 0
                          THEN ROUND(COALESCE(sign_ups, 0)::numeric * 100 / wash_sales, 2)
                        END
                      ) STORED,
  dob                 numeric(10,2) GENERATED ALWAYS AS (
                        CASE WHEN COALESCE(wash_sales, 0) > 0
                          THEN ROUND(
                                 (COALESCE(package_dollars, 0) + COALESCE(extras_dollars, 0))
                                 / wash_sales, 2)
                        END
                      ) STORED,

  -- 86400s is added back when the shift ends before it starts, which caps one
  -- row at a single day — correct for a per-day grain.
  hours_worked        numeric(6,2) GENERATED ALWAYS AS (
                        CASE WHEN shift_start IS NOT NULL AND shift_end IS NOT NULL THEN
                          ROUND(
                            (
                              EXTRACT(EPOCH FROM shift_end) - EXTRACT(EPOCH FROM shift_start)
                              + CASE WHEN shift_end < shift_start THEN 86400 ELSE 0 END
                            )::numeric / 3600, 2)
                        END
                      ) STORED,

  -- The duration expression is repeated rather than referencing hours_worked
  -- because Postgres forbids a generated column from referencing another
  -- generated column. Change the rule in BOTH places or they will disagree.
  -- NULL (not 0) when there is no shift: unrecorded throughput is unknown.
  wash_sales_per_hour numeric(10,2) GENERATED ALWAYS AS (
                        CASE WHEN shift_start IS NOT NULL AND shift_end IS NOT NULL
                              AND (
                                EXTRACT(EPOCH FROM shift_end) - EXTRACT(EPOCH FROM shift_start)
                                + CASE WHEN shift_end < shift_start THEN 86400 ELSE 0 END
                              ) > 0
                        THEN ROUND(
                               COALESCE(wash_sales, 0)::numeric * 3600
                               / (
                                   EXTRACT(EPOCH FROM shift_end) - EXTRACT(EPOCH FROM shift_start)
                                   + CASE WHEN shift_end < shift_start THEN 86400 ELSE 0 END
                                 )::numeric, 2)
                        END
                      ) STORED,

  comments            text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid NOT NULL,                        -- auth.users.id
  created_by_email    text NOT NULL,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          uuid,                                 -- auth.users.id; set on upsert-overwrite
  updated_by_email    text,

  CONSTRAINT greeter_daily_unique_day
    UNIQUE (location_id, beekeeper_user_id, business_date),

  -- Both-or-neither. A half-filled window yields a NULL hours_worked that is
  -- indistinguishable from "no shift recorded", and the form can't tell them
  -- apart after the fact.
  CONSTRAINT greeter_daily_shift_pair
    CHECK ((shift_start IS NULL) = (shift_end IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_greeter_daily_date        ON greeter_daily (business_date DESC);
CREATE INDEX IF NOT EXISTS idx_greeter_daily_scope       ON greeter_daily (location_code);
CREATE INDEX IF NOT EXISTS idx_greeter_daily_site_date   ON greeter_daily (site_number, business_date DESC);
CREATE INDEX IF NOT EXISTS idx_greeter_daily_person_date ON greeter_daily (beekeeper_user_id, business_date DESC);
-- Name search on the filter bar (ILIKE '%needle%'); trigram beats a btree here.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_greeter_daily_name_trgm
  ON greeter_daily USING gin (greeter_name gin_trgm_ops);

-- ===========================================================================
-- 3. location_daily — the same metrics for the whole site, whole day.
-- ===========================================================================
-- Carries the same shared metrics as greeter_daily so summed greeter rows can
-- be compared against the site's actual totals and the gap (numbers nobody
-- logged) is visible. Kept in a separate table rather than a nullable
-- beekeeper_user_id on greeter_daily so the per-greeter unique key stays
-- honest and so a site total can never be mistaken for a person's row in a
-- GROUP BY.
--
-- The metric sets are NOT identical: total_cars, cancellations and
-- total_members are site facts a greeter can't own, and the shift window is a
-- person fact a site can't have.
CREATE TABLE IF NOT EXISTS location_daily (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_date       date NOT NULL,

  location_id         integer NOT NULL,
  site_number         integer NOT NULL,
  location_code       text    NOT NULL,

  total_cars          integer,
  wash_sales          integer       CHECK (wash_sales IS NULL OR wash_sales >= 0),
  rewashes            integer       CHECK (rewashes IS NULL OR rewashes >= 0),
  package_dollars     numeric(12,2),
  extras_dollars      numeric(12,2),
  sign_ups            integer       CHECK (sign_ups IS NULL OR sign_ups >= 0),
  cancellations       integer       CHECK (cancellations IS NULL OR cancellations >= 0),
  -- A LEVEL, not a delta. Never SUM this across days; read it at the latest
  -- business_date in the window.
  total_members       integer       CHECK (total_members IS NULL OR total_members >= 0),

  capture_goal_pct      numeric(6,2),
  dob_goal              numeric(12,2),
  member_goal_month_end integer,

  -- The day's membership delta. Generated so it can't drift from its inputs.
  net_members         integer GENERATED ALWAYS AS (
                        COALESCE(sign_ups, 0) - COALESCE(cancellations, 0)
                      ) STORED,

  capture_pct         numeric(6,2) GENERATED ALWAYS AS (
                        CASE WHEN COALESCE(wash_sales, 0) > 0
                          THEN ROUND(COALESCE(sign_ups, 0)::numeric * 100 / wash_sales, 2)
                        END
                      ) STORED,
  dob                 numeric(10,2) GENERATED ALWAYS AS (
                        CASE WHEN COALESCE(wash_sales, 0) > 0
                          THEN ROUND(
                                 (COALESCE(package_dollars, 0) + COALESCE(extras_dollars, 0))
                                 / wash_sales, 2)
                        END
                      ) STORED,

  comments            text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid NOT NULL,
  created_by_email    text NOT NULL,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          uuid,
  updated_by_email    text,

  CONSTRAINT location_daily_unique_day UNIQUE (location_id, business_date)
);
CREATE INDEX IF NOT EXISTS idx_location_daily_date      ON location_daily (business_date DESC);
CREATE INDEX IF NOT EXISTS idx_location_daily_scope     ON location_daily (location_code);
CREATE INDEX IF NOT EXISTS idx_location_daily_site_date ON location_daily (site_number, business_date DESC);

-- ===========================================================================
-- 4. updated_at triggers
-- ===========================================================================
-- Plain trigger rather than a DEFAULT because updated_at must move on UPDATE,
-- which a column default does not do. Function is IF NOT EXISTS-safe via
-- CREATE OR REPLACE; it is generic and may already exist from another feature.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_greeter_daily_updated_at ON greeter_daily;
CREATE TRIGGER trg_greeter_daily_updated_at
  BEFORE UPDATE ON greeter_daily
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_location_daily_updated_at ON location_daily;
CREATE TRIGGER trg_location_daily_updated_at
  BEFORE UPDATE ON location_daily
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_greeter_goals_updated_at ON greeter_goals;
CREATE TRIGGER trg_greeter_goals_updated_at
  BEFORE UPDATE ON greeter_goals
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ===========================================================================
-- 5. greeter_rollup() — per-greeter aggregation over a filtered range.
-- ===========================================================================
-- A FUNCTION, not a view, and the distinction matters. A view would have to
-- GROUP BY before the caller's date filter could be applied, so
-- `WHERE business_date BETWEEN ...` would have nothing to bind to (the grouped
-- result has first_date/last_date, not business_date) and the caller would
-- silently get an all-time rollup. Filters here are applied to the base rows,
-- then aggregated.
--
-- WEIGHTING: capture_pct, dob and wash_sales_per_hour are recomputed from the
-- SUMmed numerator and denominator, never averaged from the per-day columns.
-- AVG(capture_pct) would weight a 3-car day the same as a 300-car day and
-- flatter slow days; AVG(wash_sales_per_hour) would weight a 2-hour shift the
-- same as a 10-hour one. If you add another derived metric, derive it the same
-- way.
--
-- The two goal columns are the exception and ARE averaged: they are a
-- percentage and a dollars-per-car rate, so summing either across days
-- produces a number that grows with the length of the range and means nothing.
--
-- Every parameter is NULL-defaulted and NULL means "no filter", so callers
-- pass only what they're narrowing on. p_location_codes carries the
-- caller-scoping set (NULL = sees all sites).
CREATE OR REPLACE FUNCTION greeter_rollup(
  p_date_from         date    DEFAULT NULL,
  p_date_to           date    DEFAULT NULL,
  p_location_id       integer DEFAULT NULL,
  p_site_number       integer DEFAULT NULL,
  p_beekeeper_user_id text    DEFAULT NULL,
  p_greeter           text    DEFAULT NULL,
  p_location_codes    text[]  DEFAULT NULL
)
RETURNS TABLE (
  beekeeper_user_id   text,
  greeter_name        text,
  site_number         integer,
  location_code       text,
  first_date          date,
  last_date           date,
  days_logged         bigint,
  wash_sales          bigint,
  rewashes            bigint,
  package_dollars     numeric,
  extras_dollars      numeric,
  sign_ups            bigint,
  hours_worked        numeric,
  wash_sales_per_hour numeric,
  capture_goal_pct    numeric,
  dob_goal            numeric,
  capture_pct         numeric,
  dob                 numeric
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    g.beekeeper_user_id,
    MAX(g.greeter_name)          AS greeter_name,
    g.site_number,
    g.location_code,
    MIN(g.business_date)         AS first_date,
    MAX(g.business_date)         AS last_date,
    COUNT(*)                     AS days_logged,
    SUM(g.wash_sales)            AS wash_sales,
    SUM(g.rewashes)              AS rewashes,
    SUM(g.package_dollars)       AS package_dollars,
    SUM(g.extras_dollars)        AS extras_dollars,
    SUM(g.sign_ups)              AS sign_ups,
    SUM(g.hours_worked)          AS hours_worked,
    CASE WHEN SUM(g.hours_worked) > 0
      THEN ROUND(SUM(COALESCE(g.wash_sales, 0))::numeric / SUM(g.hours_worked), 2)
    END                          AS wash_sales_per_hour,
    ROUND(AVG(g.capture_goal_pct), 2) AS capture_goal_pct,
    ROUND(AVG(g.dob_goal), 2)         AS dob_goal,
    CASE WHEN SUM(g.wash_sales) > 0
      THEN ROUND(SUM(COALESCE(g.sign_ups, 0))::numeric * 100 / SUM(g.wash_sales), 2)
    END                          AS capture_pct,
    CASE WHEN SUM(g.wash_sales) > 0
      THEN ROUND((SUM(COALESCE(g.package_dollars, 0)) + SUM(COALESCE(g.extras_dollars, 0)))
                 / SUM(g.wash_sales), 2)
    END                          AS dob
  FROM greeter_daily g
  WHERE (p_date_from         IS NULL OR g.business_date     >= p_date_from)
    AND (p_date_to           IS NULL OR g.business_date     <= p_date_to)
    AND (p_location_id       IS NULL OR g.location_id        = p_location_id)
    AND (p_site_number       IS NULL OR g.site_number        = p_site_number)
    AND (p_beekeeper_user_id IS NULL OR g.beekeeper_user_id  = p_beekeeper_user_id)
    AND (p_greeter           IS NULL OR g.greeter_name ILIKE '%' || p_greeter || '%')
    AND (p_location_codes    IS NULL OR g.location_code = ANY (p_location_codes))
  GROUP BY g.beekeeper_user_id, g.site_number, g.location_code
  ORDER BY capture_pct DESC NULLS LAST;
$$;

-- Only the service role calls this (the worker). Locking it down keeps the
-- function off the anon/authenticated PostgREST surface, where it would run as
-- a SECURITY INVOKER read that RLS on greeter_daily would have to catch.
REVOKE ALL ON FUNCTION greeter_rollup(date, date, integer, integer, text, text, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION greeter_rollup(date, date, integer, integer, text, text, text[]) TO service_role;

-- ===========================================================================
-- 6. greeter_scan_rates() — how much of each site day got attributed
-- ===========================================================================
--
-- The two wash_sales columns count the same cars from two directions:
-- location_daily.wash_sales is every a-la-carte car the site sold (the truth),
-- greeter_daily.wash_sales is the subset a greeter scanned their card for
-- (attribution). Their ratio is a DATA-QUALITY metric — a site at 60% didn't
-- sell less, it failed to scan 40% of what it sold, and every per-greeter
-- number derived from that day is understated by the gap.
--
-- Not a generated column on location_daily: the numerator lives in another
-- table and moves every time a greeter submits or corrects a day, so a stored
-- value would be stale as soon as a late row landed.
--
-- Kept in lockstep with supabase/greeter-scan-rates-02.sql. Change both.
CREATE OR REPLACE FUNCTION greeter_scan_rates(
  p_date_from      date    DEFAULT NULL,
  p_date_to        date    DEFAULT NULL,
  p_location_id    integer DEFAULT NULL,
  p_site_number    integer DEFAULT NULL,
  p_location_codes text[]  DEFAULT NULL
)
RETURNS TABLE (
  business_date      date,
  location_id        integer,
  site_number        integer,
  location_code      text,
  site_wash_sales    integer,
  scanned_wash_sales bigint,
  greeters_logged    bigint,
  scanned_pct        numeric,
  ever_submitted     boolean
)
LANGUAGE sql
STABLE
AS $$
  WITH site AS (
    -- Driving from location_daily (not a join of both tables) is what makes a
    -- site day with ZERO greeter rows still appear — that row is the point.
    SELECT
      l.business_date,
      l.location_id,
      l.site_number,
      l.location_code,
      l.wash_sales
    FROM location_daily l
    WHERE (p_date_from      IS NULL OR l.business_date >= p_date_from)
      AND (p_date_to        IS NULL OR l.business_date <= p_date_to)
      AND (p_location_id    IS NULL OR l.location_id   =  p_location_id)
      AND (p_site_number    IS NULL OR l.site_number   =  p_site_number)
      AND (p_location_codes IS NULL OR l.location_code = ANY(p_location_codes))
  ),
  scanned AS (
    -- No greeter-name filter here, unlike greeter_rollup(). The denominator is
    -- the whole site's day, so the numerator must be every greeter at that
    -- site; filtering it by name would make sites look underreported whenever
    -- someone typed in the filter bar.
    SELECT
      g.business_date,
      g.location_id,
      SUM(COALESCE(g.wash_sales, 0))::bigint AS scanned,
      COUNT(*)::bigint                       AS greeters
    FROM greeter_daily g
    JOIN site s
      ON s.business_date = g.business_date
     AND s.location_id   = g.location_id
    GROUP BY g.business_date, g.location_id
  ),
  ever AS (
    -- Lets the UI tell "onboarded and slipping" (0%, flag it) apart from
    -- "never started" (blank, don't nag).
    SELECT DISTINCT g.location_id FROM greeter_daily g
  )
  SELECT
    s.business_date,
    s.location_id,
    s.site_number,
    s.location_code,
    s.wash_sales,
    COALESCE(sc.scanned, 0)::bigint,
    COALESCE(sc.greeters, 0)::bigint,
    -- NULL, not 0, when the site sold no ALC cars: no denominator, no rate.
    CASE
      WHEN COALESCE(s.wash_sales, 0) > 0
      THEN ROUND(COALESCE(sc.scanned, 0)::numeric * 100 / s.wash_sales, 1)
    END,
    (e.location_id IS NOT NULL)
  FROM site s
  LEFT JOIN scanned sc
    ON sc.business_date = s.business_date
   AND sc.location_id   = s.location_id
  LEFT JOIN ever e
    ON e.location_id = s.location_id
  ORDER BY s.business_date DESC, s.location_code;
$$;

REVOKE ALL ON FUNCTION greeter_scan_rates(date, date, integer, integer, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION greeter_scan_rates(date, date, integer, integer, text[]) TO service_role;

-- `scanned` groups greeter_daily by (business_date, location_id), which is not
-- the leading pair of greeter_daily_unique_day (that leads with location_id).
CREATE INDEX IF NOT EXISTS greeter_daily_date_location_idx
  ON greeter_daily (business_date, location_id);

-- ===========================================================================
-- 7. greeter_missing_days() — days a location reported nothing
-- ===========================================================================
--
-- The counterpart to section 6, and separate from it on purpose.
--
-- greeter_scan_rates() is driven from location_daily, so a day a site skipped
-- entirely produces NO ROW there — it is invisible, not 0%. That is correct for
-- a scan rate (there is nothing to take a percentage of) but it means the most
-- common failure, "nobody entered anything", never surfaces. This function is
-- what makes those days visible.
--
-- Keeping them apart also keeps the two numbers honest: folding no-shows into
-- the scan rate as zeroes would drag down sites that are scanning fine and
-- would attribute a reporting failure to the greeters' scanning habits.
--
-- A full day is TWO submissions — the site's own numbers and at least one
-- greeter's day — and either can be absent independently, so both flags are
-- returned rather than one "missing" boolean.
--
-- The universe is locations that have EVER submitted either kind of row, not
-- every row in `locations`: a site never onboarded to the scorecard would
-- otherwise fill this permanently with rows nobody can act on. A location is
-- also only reported from its FIRST submission onward, so a site onboarded
-- midweek isn't accused of missing the days before it existed here. Known
-- limit — a closed or seasonal site still shows every day as missing; there is
-- no "expected to report" flag to filter on yet.
--
-- Both dates are REQUIRED (no defaults): the query is an
-- (onboarded locations x days) grid, so an unbounded call would materialise
-- every day since the first submission.
--
-- Kept in lockstep with supabase/greeter-missing-days-03.sql. Change both.
CREATE OR REPLACE FUNCTION greeter_missing_days(
  p_date_from      date,
  p_date_to        date,
  p_location_id    integer DEFAULT NULL,
  p_site_number    integer DEFAULT NULL,
  p_location_codes text[]  DEFAULT NULL
)
RETURNS TABLE (
  business_date   date,
  location_id     integer,
  site_number     integer,
  location_code   text,
  has_site_row    boolean,
  greeters_logged bigint
)
LANGUAGE sql
STABLE
AS $$
  WITH submitted AS (
    -- Both tables, so a location that only ever logged one kind of row still
    -- counts as onboarded.
    --
    -- SCOPED HERE, BEFORE THE COLLAPSE. location_code has been observed to
    -- diverge between tables for the same site; collapsing first and filtering
    -- on whichever spelling won would intermittently drop a location admin's
    -- own site out of their panel.
    SELECT l.location_id, l.site_number, l.location_code, l.business_date
      FROM location_daily l
     WHERE (p_location_id    IS NULL OR l.location_id   =  p_location_id)
       AND (p_site_number    IS NULL OR l.site_number   =  p_site_number)
       AND (p_location_codes IS NULL OR l.location_code = ANY(p_location_codes))
    UNION ALL
    SELECT g.location_id, g.site_number, g.location_code, g.business_date
      FROM greeter_daily g
     WHERE (p_location_id    IS NULL OR g.location_id   =  p_location_id)
       AND (p_site_number    IS NULL OR g.site_number   =  p_site_number)
       AND (p_location_codes IS NULL OR g.location_code = ANY(p_location_codes))
  ),
  scoped AS (
    -- One identity row per location, plus the day it first appeared. Identity
    -- is the most recent submission's spelling; location_code breaks the tie so
    -- the pick is deterministic rather than planner-dependent.
    SELECT DISTINCT ON (s.location_id)
           s.location_id,
           s.site_number,
           s.location_code,
           MIN(s.business_date) OVER (PARTITION BY s.location_id) AS first_seen
      FROM submitted s
     ORDER BY s.location_id, s.business_date DESC, s.location_code
  ),
  days AS (
    SELECT d::date AS business_date
      FROM generate_series(p_date_from, p_date_to, interval '1 day') AS d
  ),
  greeter_counts AS (
    SELECT g.location_id, g.business_date, COUNT(*)::bigint AS greeters
      FROM greeter_daily g
     WHERE g.business_date BETWEEN p_date_from AND p_date_to
     GROUP BY g.location_id, g.business_date
  )
  SELECT
    d.business_date,
    s.location_id,
    s.site_number,
    s.location_code,
    (l.id IS NOT NULL),
    COALESCE(gc.greeters, 0)::bigint
  FROM scoped s
  CROSS JOIN days d
  LEFT JOIN location_daily l
    ON l.location_id   = s.location_id
   AND l.business_date = d.business_date
  LEFT JOIN greeter_counts gc
    ON gc.location_id   = s.location_id
   AND gc.business_date = d.business_date
  -- Only the gaps. A complete day is section 6's business, not this one's.
  WHERE (l.id IS NULL OR COALESCE(gc.greeters, 0) = 0)
    -- Never report a day before the location's first submission: a site
    -- onboarded on Wednesday didn't miss Monday.
    AND d.business_date >= s.first_seen
  ORDER BY d.business_date DESC, s.location_code;
$$;

REVOKE ALL ON FUNCTION greeter_missing_days(date, date, integer, integer, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION greeter_missing_days(date, date, integer, integer, text[]) TO service_role;

-- ===========================================================================
-- 8. greeter_period_report() — per greeter per site, over a window
-- ===========================================================================
--
-- Powers the three greeter views on /admin/greeters/report (previous 7 days,
-- underperformers, top performers). They differ only in window length and in a
-- threshold on columns this already returns, so they are UI filters over one
-- query rather than three near-identical functions.
--
-- WHY NOT JUST EXTEND greeter_rollup(): the point of this function is
-- days_over_goal / days_under_goal, which are counted at the DAY grain before
-- aggregation. "18 of her 24 days beat goal" is not derivable from a 24-day
-- average, so it cannot be bolted onto a function that has already grouped.
--
-- WHAT "OVER GOAL" MEANS:
--   over    capture_pct >= capture_goal_pct  (hitting it exactly is hitting it)
--   under   capture_pct <  capture_goal_pct
--   neither capture_pct IS NULL (no wash sales, so no opportunity and no rate)
--           OR capture_goal_pct IS NULL (no goal window covered the day)
-- The "neither" bucket is returned as ungraded_days rather than dropped, so the
-- page can say "5 of 12 days couldn't be graded" instead of quietly reporting
-- percentages off a denominator the reader can't see. The percentages are over
-- GRADEABLE days: dividing by days_logged would let a greeter improve their
-- standing by logging days with no wash sales.
--
-- low_sample (fewer than 5 gradeable days) exists because two days, both under
-- goal, is "100% under goal" and would otherwise open the underperformer list.
-- The page sorts these to the BOTTOM of both lists with a note rather than
-- hiding them. Computed here, not in the page, so one definition of "few
-- reported numbers" serves every view.
--
-- Weighting follows section 5: summed numerator over summed denominator for
-- capture_pct/dob, AVG for the goal columns.
--
-- Kept in lockstep with supabase/greeter-report-04.sql. Change both.
CREATE OR REPLACE FUNCTION greeter_period_report(
  p_date_from         date,
  p_date_to           date,
  p_location_id       integer DEFAULT NULL,
  p_site_number       integer DEFAULT NULL,
  p_beekeeper_user_id text    DEFAULT NULL,
  p_greeter           text    DEFAULT NULL,
  p_location_codes    text[]  DEFAULT NULL
)
RETURNS TABLE (
  beekeeper_user_id   text,
  greeter_name        text,
  location_id         integer,
  site_number         integer,
  location_code       text,
  first_date          date,
  last_date           date,
  days_logged         bigint,
  gradeable_days      bigint,
  ungraded_days       bigint,
  days_over_goal      bigint,
  days_under_goal     bigint,
  pct_days_over       numeric,
  pct_days_under      numeric,
  low_sample          boolean,
  wash_sales          bigint,
  sign_ups            bigint,
  package_dollars     numeric,
  extras_dollars      numeric,
  hours_worked        numeric,
  wash_sales_per_hour numeric,
  capture_goal_pct    numeric,
  dob_goal            numeric,
  capture_pct         numeric,
  dob                 numeric
)
LANGUAGE sql
STABLE
AS $$
  WITH graded AS (
    -- Day grain. over + under + ungraded always equals days_logged — a property
    -- worth preserving if you add a fourth bucket.
    SELECT
      g.beekeeper_user_id,
      g.greeter_name,
      g.location_id,
      g.site_number,
      g.location_code,
      g.business_date,
      g.wash_sales,
      g.sign_ups,
      g.package_dollars,
      g.extras_dollars,
      g.hours_worked,
      g.capture_goal_pct,
      g.dob_goal,
      (g.capture_pct IS NOT NULL AND g.capture_goal_pct IS NOT NULL) AS gradeable,
      CASE WHEN g.capture_pct IS NOT NULL AND g.capture_goal_pct IS NOT NULL
                AND g.capture_pct >= g.capture_goal_pct
           THEN 1 ELSE 0 END AS is_over,
      CASE WHEN g.capture_pct IS NOT NULL AND g.capture_goal_pct IS NOT NULL
                AND g.capture_pct <  g.capture_goal_pct
           THEN 1 ELSE 0 END AS is_under
    FROM greeter_daily g
    WHERE g.business_date >= p_date_from
      AND g.business_date <= p_date_to
      AND (p_location_id       IS NULL OR g.location_id       = p_location_id)
      AND (p_site_number       IS NULL OR g.site_number       = p_site_number)
      AND (p_beekeeper_user_id IS NULL OR g.beekeeper_user_id = p_beekeeper_user_id)
      AND (p_greeter           IS NULL OR g.greeter_name ILIKE '%' || p_greeter || '%')
      AND (p_location_codes    IS NULL OR g.location_code = ANY (p_location_codes))
  )
  SELECT
    r.beekeeper_user_id,
    MAX(r.greeter_name)                                   AS greeter_name,
    r.location_id,
    r.site_number,
    r.location_code,
    MIN(r.business_date)                                  AS first_date,
    MAX(r.business_date)                                  AS last_date,
    COUNT(*)::bigint                                      AS days_logged,
    COUNT(*) FILTER (WHERE r.gradeable)::bigint           AS gradeable_days,
    COUNT(*) FILTER (WHERE NOT r.gradeable)::bigint       AS ungraded_days,
    SUM(r.is_over)::bigint                                AS days_over_goal,
    SUM(r.is_under)::bigint                               AS days_under_goal,
    -- NULL, not 0, when nothing was gradeable: "0% of days beat goal" and "we
    -- couldn't grade any of these days" are different statements.
    CASE WHEN COUNT(*) FILTER (WHERE r.gradeable) > 0
      THEN ROUND(SUM(r.is_over)::numeric  * 100 / COUNT(*) FILTER (WHERE r.gradeable), 1)
    END                                                   AS pct_days_over,
    CASE WHEN COUNT(*) FILTER (WHERE r.gradeable) > 0
      THEN ROUND(SUM(r.is_under)::numeric * 100 / COUNT(*) FILTER (WHERE r.gradeable), 1)
    END                                                   AS pct_days_under,
    (COUNT(*) FILTER (WHERE r.gradeable) < 5)             AS low_sample,
    SUM(r.wash_sales)::bigint                             AS wash_sales,
    SUM(r.sign_ups)::bigint                               AS sign_ups,
    SUM(r.package_dollars)                                AS package_dollars,
    SUM(r.extras_dollars)                                 AS extras_dollars,
    SUM(r.hours_worked)                                   AS hours_worked,
    CASE WHEN SUM(r.hours_worked) > 0
      THEN ROUND(SUM(COALESCE(r.wash_sales, 0))::numeric / SUM(r.hours_worked), 2)
    END                                                   AS wash_sales_per_hour,
    ROUND(AVG(r.capture_goal_pct), 2)                     AS capture_goal_pct,
    ROUND(AVG(r.dob_goal), 2)                             AS dob_goal,
    CASE WHEN SUM(r.wash_sales) > 0
      THEN ROUND(SUM(COALESCE(r.sign_ups, 0))::numeric * 100 / SUM(r.wash_sales), 2)
    END                                                   AS capture_pct,
    CASE WHEN SUM(r.wash_sales) > 0
      THEN ROUND((SUM(COALESCE(r.package_dollars, 0)) + SUM(COALESCE(r.extras_dollars, 0)))
                 / SUM(r.wash_sales), 2)
    END                                                   AS dob
  FROM graded r
  GROUP BY r.beekeeper_user_id, r.location_id, r.site_number, r.location_code
  -- Aggregate expressions, not the output aliases: RETURNS TABLE column names
  -- are in scope inside a SQL-language function body, so a bare alias here is
  -- at best ambiguous.
  ORDER BY SUM(r.is_over)::numeric
             / NULLIF(COUNT(*) FILTER (WHERE r.gradeable), 0) DESC NULLS LAST,
           MAX(r.greeter_name);
$$;

REVOKE ALL ON FUNCTION greeter_period_report(date, date, integer, integer, text, text, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION greeter_period_report(date, date, integer, integer, text, text, text[]) TO service_role;

-- ===========================================================================
-- 9. location_period_rows() — per site per DAY, raw, plus attribution
-- ===========================================================================
--
-- Returns days, not totals, on purpose. The morning-call table wants per-site
-- totals and the trend chart wants per-day totals — two groupings of the same
-- facts. Returning the days once and grouping twice in the page guarantees the
-- table and the chart can never disagree, which two aggregate functions could
-- not. The page's grouping sums raw numerators and denominators, so the
-- weighting rule from section 5 is preserved.
--
-- Driven from location_daily, so a day the site didn't report produces no row.
-- Correct here: this reports what WAS submitted, and the reader is told "5 of 7
-- days reported" by counting rows against the window. WHICH days are missing is
-- section 7's job and is not duplicated.
--
-- total_members is passed through UNSUMMED. It is a LEVEL — active members as
-- of that day — and summing it across a week gives roughly seven times the
-- truth. A caller wanting "members now" reads it at the latest business_date.
--
-- Kept in lockstep with supabase/greeter-report-04.sql. Change both.
CREATE OR REPLACE FUNCTION location_period_rows(
  p_date_from      date,
  p_date_to        date,
  p_location_id    integer DEFAULT NULL,
  p_site_number    integer DEFAULT NULL,
  p_location_codes text[]  DEFAULT NULL
)
RETURNS TABLE (
  business_date      date,
  location_id        integer,
  site_number        integer,
  location_code      text,
  total_cars         integer,
  wash_sales         integer,
  rewashes           integer,
  package_dollars    numeric,
  extras_dollars     numeric,
  sign_ups           integer,
  cancellations      integer,
  total_members      integer,
  net_members        integer,
  capture_pct        numeric,
  dob                numeric,
  capture_goal_pct   numeric,
  dob_goal           numeric,
  scanned_wash_sales bigint,
  greeters_logged    bigint
)
LANGUAGE sql
STABLE
AS $$
  WITH site AS (
    SELECT
      l.business_date,
      l.location_id,
      l.site_number,
      l.location_code,
      l.total_cars,
      l.wash_sales,
      l.rewashes,
      l.package_dollars,
      l.extras_dollars,
      l.sign_ups,
      l.cancellations,
      l.total_members,
      l.net_members,
      l.capture_pct,
      l.dob,
      l.capture_goal_pct,
      l.dob_goal
    FROM location_daily l
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
    FROM greeter_daily g
    JOIN site s
      ON s.business_date = g.business_date
     AND s.location_id   = g.location_id
    GROUP BY g.business_date, g.location_id
  )
  SELECT
    s.business_date,
    s.location_id,
    s.site_number,
    s.location_code,
    s.total_cars,
    s.wash_sales,
    s.rewashes,
    s.package_dollars,
    s.extras_dollars,
    s.sign_ups,
    s.cancellations,
    s.total_members,
    s.net_members,
    s.capture_pct,
    s.dob,
    s.capture_goal_pct,
    s.dob_goal,
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
