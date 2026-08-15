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
-- METRIC VOCABULARY (confirmed with Josh 2026-08-15) — read this before
-- touching any of the arithmetic:
--
--   total_cars       Every car through the tunnel, unlimited members included.
--   wash_sales       "ALC" / a-la-carte on the source report: NON-unlimited,
--                    saleable cars. This is the denominator for BOTH derived
--                    metrics. Named `wash_sales` (not `alc`) because that is
--                    how the column reads on the report the numbers come from.
--   package_dollars  Wash package revenue.
--   extras_dollars   Wash extras revenue.
--   sign_ups         Unlimited memberships sold.
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
CREATE TABLE IF NOT EXISTS greeter_goals (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_number       integer NOT NULL,
  location_code     text NOT NULL,
  effective_from    date NOT NULL,
  effective_to      date,                                   -- NULL = open-ended (current goal)
  sign_up_goal      integer     NOT NULL CHECK (sign_up_goal >= 0),
  extras_goal       numeric(12,2) NOT NULL CHECK (extras_goal >= 0),
  note              text,                                   -- e.g. "summer promo push"
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid NOT NULL,                          -- auth.users.id
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT greeter_goals_window_valid
    CHECK (effective_to IS NULL OR effective_to >= effective_from)
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

  -- Typed-in metrics.
  total_cars          integer,
  wash_sales          integer       CHECK (wash_sales IS NULL OR wash_sales >= 0),
  package_dollars     numeric(12,2),
  extras_dollars      numeric(12,2),
  sign_ups            integer       CHECK (sign_ups IS NULL OR sign_ups >= 0),

  -- Goal snapshot, copied from greeter_goals at submit time. NULL when no
  -- goal window covered business_date.
  sign_up_goal        integer,
  extras_goal         numeric(12,2),

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

  comments            text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid NOT NULL,                        -- auth.users.id
  created_by_email    text NOT NULL,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          uuid,                                 -- auth.users.id; set on upsert-overwrite
  updated_by_email    text,

  CONSTRAINT greeter_daily_unique_day
    UNIQUE (location_id, beekeeper_user_id, business_date)
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
-- Deliberately the same metric set as greeter_daily so summed greeter rows can
-- be compared against the site's actual totals and the gap (numbers nobody
-- logged) is visible. Kept in a separate table rather than a nullable
-- beekeeper_user_id on greeter_daily so the per-greeter unique key stays
-- honest and so a site total can never be mistaken for a person's row in a
-- GROUP BY.
CREATE TABLE IF NOT EXISTS location_daily (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_date       date NOT NULL,

  location_id         integer NOT NULL,
  site_number         integer NOT NULL,
  location_code       text    NOT NULL,

  total_cars          integer,
  wash_sales          integer       CHECK (wash_sales IS NULL OR wash_sales >= 0),
  package_dollars     numeric(12,2),
  extras_dollars      numeric(12,2),
  sign_ups            integer       CHECK (sign_ups IS NULL OR sign_ups >= 0),

  sign_up_goal        integer,
  extras_goal         numeric(12,2),

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
-- WEIGHTING: capture_pct and dob are recomputed from the SUMmed numerator and
-- denominator, never averaged from the per-day columns. AVG(capture_pct) would
-- weight a 3-car day the same as a 300-car day and flatter slow days. If you
-- add another derived metric here, derive it the same way.
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
  beekeeper_user_id text,
  greeter_name      text,
  site_number       integer,
  location_code     text,
  first_date        date,
  last_date         date,
  days_logged       bigint,
  total_cars        bigint,
  wash_sales        bigint,
  package_dollars   numeric,
  extras_dollars    numeric,
  sign_ups          bigint,
  sign_up_goal      bigint,
  extras_goal       numeric,
  capture_pct       numeric,
  dob               numeric
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    g.beekeeper_user_id,
    MAX(g.greeter_name)        AS greeter_name,
    g.site_number,
    g.location_code,
    MIN(g.business_date)       AS first_date,
    MAX(g.business_date)       AS last_date,
    COUNT(*)                   AS days_logged,
    SUM(g.total_cars)          AS total_cars,
    SUM(g.wash_sales)          AS wash_sales,
    SUM(g.package_dollars)     AS package_dollars,
    SUM(g.extras_dollars)      AS extras_dollars,
    SUM(g.sign_ups)            AS sign_ups,
    SUM(g.sign_up_goal)        AS sign_up_goal,
    SUM(g.extras_goal)         AS extras_goal,
    CASE WHEN SUM(g.wash_sales) > 0
      THEN ROUND(SUM(COALESCE(g.sign_ups, 0))::numeric * 100 / SUM(g.wash_sales), 2)
    END                        AS capture_pct,
    CASE WHEN SUM(g.wash_sales) > 0
      THEN ROUND((SUM(COALESCE(g.package_dollars, 0)) + SUM(COALESCE(g.extras_dollars, 0)))
                 / SUM(g.wash_sales), 2)
    END                        AS dob
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
