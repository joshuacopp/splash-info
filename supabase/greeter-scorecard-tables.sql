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
--   reactivations    Lapsed members coming back. On BOTH tables, but only the
--                    site's copy is used for anything: it feeds net_members.
--                    The greeter's copy is optional and purely informational —
--                    nothing is computed from it, and specifically NOT capture %
--                    (a reactivating customer already knew the product, so they
--                    were never a capture opportunity).
--   total_members    Active members as of that day. A LEVEL, not a delta — it
--                    is never summed across days, only read at the latest date
--                    in a window. Site-level only.
--   net_members      Generated: sign_ups + reactivations - cancellations. The
--                    day's delta.
--   churn_pct        Self-reported daily churn as a percentage. Site-level only,
--                    and INFORMATIONAL: no goal column, never graded, and never
--                    aggregated across days. It arrives already divided — the
--                    site keeps both inputs — so there is nothing to re-sum and
--                    a period figure could only be a flat average of daily
--                    percentages, which is exactly what the weighting rule in
--                    section 5 exists to prevent. Day-level display only.
--   google_reviews   Count of Google reviews collected that day, NOT a star
--                    rating. On BOTH tables. Informational: summed so a period
--                    total is visible, and nothing else. A review is not a
--                    capture and must never reach capture_pct.
--   package_dollars  Wash package revenue.
--   extras_dollars   Wash extras revenue.
--   sign_ups         Unlimited memberships sold.
--   shift_start /    The greeter's shift window as a bare `time`. Both or
--   shift_end        neither; end < start means an overnight shift.
--   hours_worked     Generated from the shift window.
--   wash_sales_per_hour  Generated: wash_sales over the shift duration.
--   dob              "Dollars over base" = (package $ + extras $) / wash_sales.
--   capture_pct      sign_ups / (wash_sales + sign_ups), as a PERCENTAGE
--                    (0-100). See greeter-capture-13.sql.
--
--   The denominator is every car that could have gone either way. A sign-up
--   and a wash sale are mutually exclusive outcomes for the same customer —
--   they either bought a single wash or joined the plan — so both belong on
--   the bottom and the result is bounded at 100. Dividing by wash sales alone
--   (which is what this did until 2026-08-22) let a greeter who converted more
--   people than they sold single washes score 400%, which is not a rate.
--
--   total_cars is still NOT the denominator: a customer already on an
--   unlimited plan cannot sign up again, so they were never an opportunity and
--   must not count against the greeter. Nor are reactivations, rewashes,
--   house accounts or google reviews on either side.
--
-- `dob` and `capture_pct` are GENERATED ALWAYS ... STORED rather than
-- application-computed. Two reasons: the arithmetic cannot drift between the
-- submit path, the CSV export, and any future rollup; and stored generated
-- columns are indexable and filterable, which read-time computation is not.
--
-- THEIR NULL RULES DIFFER, deliberately. dob is NULL when wash_sales is 0 or
-- NULL, because dollars over base is a per-wash average and there is nothing
-- to average. capture_pct is NULL only when wash_sales + sign_ups is 0 —
-- a day with no wash sales but three sign-ups is three opportunities, all
-- three converted, a real 100% rather than an unknown.
--
-- capture_pct is stored as a raw percentage (62.40 = 62.4%), not a 0-1
-- fraction, matching the `performance_tracking.capture_rate` convention. That
-- is a statement about SCALE only. performance_tracking is a separate legacy
-- table, hand-entered on /admin/performance and not derived from greeter logs;
-- its denominator is its own business.
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
-- ended. OVERLAPPING WINDOWS ARE LEGAL and the shortest one covering a day is
-- the one that grades it, so a promo week can be laid over a standing monthly
-- baseline without closing it. Section 4b resolves that; nothing else may.
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
-- NAME IS LEGACY: this indexes OPEN-ENDED goals, which stopped being the same
-- thing as "current" when greeter-goal-overlap-11.sql made windows overlap. An
-- open-ended window now has infinite span and therefore LOSES to any bounded
-- window covering the same day, so it is frequently not the current one at all.
-- Kept under the old name rather than renamed because a rename is a DROP and a
-- CREATE against a live table for no functional gain; greeter_goal_for() is
-- what answers "which goal is current", and it reads no index by name.
CREATE INDEX IF NOT EXISTS idx_greeter_goals_current     ON greeter_goals (site_number) WHERE effective_to IS NULL;

-- Duplicate guard, NOT an overlap guard. There used to be a gist EXCLUDE here
-- forbidding any overlap; greeter-goal-overlap-11.sql dropped it, because a
-- special-week goal laid over a monthly baseline is the whole point and that
-- constraint made it unrepresentable. The DROP is kept so a database built from
-- an older copy of this file converges.
--
-- What remains rejected is two goals for one site with the SAME window: that is
-- one row typed twice, and no rule could choose between them that wouldn't be a
-- coin flip. COALESCE to 'infinity' because NULLs compare distinct in a plain
-- UNIQUE, which would otherwise let a site hold two identical open-ended
-- baselines and tie in the resolver forever.
ALTER TABLE greeter_goals DROP CONSTRAINT IF EXISTS greeter_goals_no_overlap;
CREATE UNIQUE INDEX IF NOT EXISTS idx_greeter_goals_unique_window
  ON greeter_goals (
    site_number,
    effective_from,
    COALESCE(effective_to, 'infinity'::date)
  );

COMMENT ON INDEX idx_greeter_goals_unique_window IS
  'Overlapping goal windows are allowed (shortest span wins — see '
  'greeter_goal_for). Identical windows are not: there is no rule that could '
  'choose between them. Delete the existing goal instead.';

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
  -- Optional and informational. Nothing on this table is computed from it —
  -- see the header note. There is no greeter-side net_members to feed, because
  -- cancellations are site-only and the delta can't be assembled from a row.
  reactivations       integer       CHECK (reactivations IS NULL OR reactivations >= 0),
  -- Also optional and informational. A COUNT of reviews collected, not a star
  -- rating — the scale would be 1-5 and the CHECK would look very different.
  --
  -- Named explicitly rather than left to Postgres's auto-naming: the ALTER path
  -- (greeter-churn-reviews-09.sql) names it, and that file's verification query
  -- looks the constraint up BY NAME. An inline unnamed CHECK here would produce
  -- `greeter_daily_google_reviews_check` instead and quietly fail that check on
  -- any database provisioned from this file.
  google_reviews      integer,
  CONSTRAINT greeter_daily_google_reviews_nonneg
    CHECK (google_reviews IS NULL OR google_reviews >= 0),

  -- Shift window, bare `time` (no date, no zone). End before start = overnight.
  shift_start         time,
  shift_end           time,

  -- Goal snapshot, copied from greeter_goals at submit time. NULL when no
  -- goal window covered business_date.
  capture_goal_pct    numeric(6,2),
  dob_goal            numeric(12,2),

  -- Derived. See the header note on why these are generated, not computed.
  capture_pct         numeric(6,2) GENERATED ALWAYS AS (
                        CASE WHEN COALESCE(wash_sales, 0) + COALESCE(sign_ups, 0) > 0
                          THEN ROUND(
                                 COALESCE(sign_ups, 0)::numeric * 100
                                 / (COALESCE(wash_sales, 0) + COALESCE(sign_ups, 0)), 2)
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

  -- VOID, NOT DELETE. A day that was entered wrongly is struck out rather than
  -- removed: the scorecard is the record of what a site reported, and "this was
  -- submitted and then withdrawn" is a different fact from "this was never
  -- submitted". NULL means live. Nothing computed reads a voided row — see the
  -- _live views below, which every reading function goes through.
  voided_at           timestamptz,
  voided_by           uuid,                                 -- auth.users.id
  voided_by_email     text,

  -- Both-or-neither. A half-filled window yields a NULL hours_worked that is
  -- indistinguishable from "no shift recorded", and the form can't tell them
  -- apart after the fact.
  CONSTRAINT greeter_daily_shift_pair
    CHECK ((shift_start IS NULL) = (shift_end IS NULL))
);

-- ONE LIVE ROW PER (location, greeter, date) — a PARTIAL unique index, not the
-- table constraint this replaces.
--
-- The old constraint covered voided rows too, which would have made voiding a
-- day a trap: the slot stays occupied by the struck-out row, so re-entering the
-- day comes back as a duplicate-key error naming a row the user can no longer
-- see in any total. Excluding voided rows means a void genuinely frees the day,
-- and any number of withdrawn attempts can accumulate underneath the one live
-- answer.
--
-- Still an UPSERT key for live rows, so re-submitting a day that was never
-- voided corrects it exactly as before.
ALTER TABLE greeter_daily DROP CONSTRAINT IF EXISTS greeter_daily_unique_day;
CREATE UNIQUE INDEX IF NOT EXISTS idx_greeter_daily_unique_live_day
  ON greeter_daily (location_id, beekeeper_user_id, business_date)
  WHERE voided_at IS NULL;
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
  -- Site-only, and next to rewashes because the two are always subtracted
  -- together: both are real wash sales that no customer can scan a card for,
  -- so both come out of the scan-rate denominator and NEITHER comes out of
  -- capture_pct or dob (company policy — see greeter-house-accounts-10.sql).
  -- Named CHECK because that file verifies it by name.
  house_accounts      integer,
  CONSTRAINT location_daily_house_accounts_nonneg
    CHECK (house_accounts IS NULL OR house_accounts >= 0),
  package_dollars     numeric(12,2),
  extras_dollars      numeric(12,2),
  sign_ups            integer       CHECK (sign_ups IS NULL OR sign_ups >= 0),
  cancellations       integer       CHECK (cancellations IS NULL OR cancellations >= 0),
  reactivations       integer       CHECK (reactivations IS NULL OR reactivations >= 0),
  -- A LEVEL, not a delta. Never SUM this across days; read it at the latest
  -- business_date in the window.
  total_members       integer       CHECK (total_members IS NULL OR total_members >= 0),

  -- Self-reported, informational, and NEVER aggregated — see the header note.
  -- The CHECK, not the numeric(5,2) scale, is what holds this to a percentage:
  -- the scale alone would accept 999.99, and a site typing a member COUNT into a
  -- percent box is the likeliest bad input this column will ever see.
  --
  -- Both constraints are named, matching greeter-churn-reviews-09.sql. That
  -- file verifies them BY NAME, so an inline unnamed CHECK here would auto-name
  -- to `..._check` and fail the verification on any database built from this
  -- file rather than from the ALTER path.
  churn_pct           numeric(5,2),
  CONSTRAINT location_daily_churn_pct_range
    CHECK (churn_pct IS NULL OR (churn_pct >= 0 AND churn_pct <= 100)),
  google_reviews      integer,
  CONSTRAINT location_daily_google_reviews_nonneg
    CHECK (google_reviews IS NULL OR google_reviews >= 0),

  capture_goal_pct      numeric(6,2),
  dob_goal              numeric(12,2),
  member_goal_month_end integer,

  -- The day's membership delta. Generated so it can't drift from its inputs.
  net_members         integer GENERATED ALWAYS AS (
                        COALESCE(sign_ups, 0)
                        + COALESCE(reactivations, 0)
                        - COALESCE(cancellations, 0)
                      ) STORED,

  -- Identical to greeter_daily.capture_pct, and it must stay identical: a
  -- greeter row and the site row for the same day sit side by side on the
  -- report, and a denominator that differed between them would make the site
  -- look like it captured at a different rate than the sum of its greeters.
  capture_pct         numeric(6,2) GENERATED ALWAYS AS (
                        CASE WHEN COALESCE(wash_sales, 0) + COALESCE(sign_ups, 0) > 0
                          THEN ROUND(
                                 COALESCE(sign_ups, 0)::numeric * 100
                                 / (COALESCE(wash_sales, 0) + COALESCE(sign_ups, 0)), 2)
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

  -- See greeter_daily's copy of these three. Same rule, same reason.
  voided_at           timestamptz,
  voided_by           uuid,
  voided_by_email     text
);
CREATE INDEX IF NOT EXISTS idx_location_daily_date      ON location_daily (business_date DESC);
CREATE INDEX IF NOT EXISTS idx_location_daily_scope     ON location_daily (location_code);
CREATE INDEX IF NOT EXISTS idx_location_daily_site_date ON location_daily (site_number, business_date DESC);

-- One LIVE row per (location, date). See greeter_daily's partial index above.
ALTER TABLE location_daily DROP CONSTRAINT IF EXISTS location_daily_unique_day;
CREATE UNIQUE INDEX IF NOT EXISTS idx_location_daily_unique_live_day
  ON location_daily (location_id, business_date)
  WHERE voided_at IS NULL;

-- ===========================================================================
-- 3b. greeter_daily_live / location_daily_live — the reading surface
-- ===========================================================================
-- EVERY FUNCTION BELOW READS THESE, NOT THE TABLES. That is the whole
-- enforcement mechanism for "voided rows are not reported", and it is a view
-- rather than a predicate repeated in each function for two reasons.
--
-- First, it is one place to be right instead of twelve. Six functions read
-- these tables, several of them twice, and a rule spelled out twelve times is a
-- rule that will eventually be spelled eleven.
--
-- Second, and more concretely: greeter_missing_days() LEFT JOINs location_daily
-- to find days a site reported nothing. Written as a predicate, the exclusion
-- would have to go in the JOIN's ON clause, because putting `l.voided_at IS
-- NULL` in the WHERE silently converts that LEFT JOIN into an INNER JOIN and
-- deletes exactly the missing days the function exists to find. Reading from a
-- view makes that mistake unavailable.
--
-- Voiding a day therefore makes it MISSING again, which is correct: the site
-- has no standing answer for it, and the missing-days panel should say so.
--
-- SELECT * is deliberate: it saves listing forty-odd columns twice, generated
-- ones included, and reads as "the table, minus the struck-out rows".
--
-- BUT IT DOES NOT TRACK THE TABLE. Postgres expands the star ONCE, at CREATE
-- time, and freezes the result in the view definition. A later ALTER TABLE ...
-- ADD COLUMN does NOT appear here, so any migration that adds a metric to
-- greeter_daily or location_daily must re-run these two statements or the new
-- column is invisible to every reporting function.
--
-- CREATE OR REPLACE VIEW can only APPEND columns. Dropping or reordering one
-- needs DROP VIEW first — see greeter-capture-13.sql, which had to do exactly
-- that to redefine capture_pct.
CREATE OR REPLACE VIEW greeter_daily_live AS
  SELECT * FROM greeter_daily WHERE voided_at IS NULL;

CREATE OR REPLACE VIEW location_daily_live AS
  SELECT * FROM location_daily WHERE voided_at IS NULL;

REVOKE ALL ON greeter_daily_live  FROM PUBLIC;
REVOKE ALL ON location_daily_live FROM PUBLIC;
GRANT SELECT ON greeter_daily_live  TO service_role;
GRANT SELECT ON location_daily_live TO service_role;

COMMENT ON VIEW greeter_daily_live IS
  'greeter_daily minus voided rows. Every reporting function reads this, not '
  'the table. Read the table directly only to show a user their own struck-out '
  'rows so they can restore one.';
COMMENT ON VIEW location_daily_live IS
  'location_daily minus voided rows. See greeter_daily_live.';

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
-- 4b. Goal resolution — which of several overlapping windows grades a day.
-- ===========================================================================
-- Introduced by greeter-goal-overlap-11.sql; kept here so a database built from
-- this file alone behaves identically. Placed after the tables because
-- greeter_restamp_goals writes to both daily tables.
--
-- THE RULE: smallest span wins; an open-ended window has infinite span and
-- therefore always loses to a bounded one. That covers a promo week nested in a
-- monthly baseline, a promo straddling a month boundary, a flash sale nested in
-- the promo, and a standing baseline with no end date — none of them a special
-- case. Resolution lives here and nowhere else; the application must not carry
-- a second copy of this ORDER BY.
--
-- Returns a ROW, not three scalars, so all three goals come from the SAME
-- window. Three separate lookups could tie differently and hand back a capture
-- target from the promo beside a member target from the baseline — a
-- combination nobody set. No row at all when nothing covers the date, and
-- callers stamp NULLs: that is what the goal columns on both daily tables
-- already mean. A zero capture goal would grade every day as a win.
--
-- ORDER BY, term by term:
--   1. bounded windows before open-ended ones. This is how "infinite span" is
--      expressed without subtracting 'infinity'::date, which Postgres refuses.
--   2. among bounded windows, the shortest.
--   3. later start wins the tie. Two equal-length windows can both cover a day
--      (Sept 1-7 and Sept 5-11 both cover Sept 6), and every pair of open-ended
--      windows for a site ties at 1 and NULLs at 2, so they all land here. Same
--      semantic as expense_labor_rate_for: the newest instruction wins.
--   4. created_at, id — pure determinism. Only reachable if the unique index on
--      (site, from, to) is ever dropped.
CREATE OR REPLACE FUNCTION greeter_goal_for(
  p_site_number   integer,
  p_business_date date
)
RETURNS TABLE (
  capture_goal_pct      numeric,
  dob_goal              numeric,
  member_goal_month_end integer
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    g.capture_goal_pct,
    g.dob_goal,
    g.member_goal_month_end
  FROM greeter_goals g
  WHERE g.site_number = p_site_number
    AND g.effective_from <= p_business_date
    AND (g.effective_to IS NULL OR g.effective_to >= p_business_date)
  ORDER BY
    (g.effective_to IS NULL)              ASC,
    (g.effective_to - g.effective_from)   ASC,
    g.effective_from                      DESC,
    g.created_at                          DESC,
    g.id
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION greeter_goal_for(integer, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION greeter_goal_for(integer, date) TO service_role;

-- Goals are SNAPSHOTTED at submit time (see the greeter_goals header), so a
-- goal set today for a window partly in the past leaves those days graded
-- against whatever was in force when they were typed. This walks back over them.
--
-- IT RE-RESOLVES; IT DOES NOT APPLY THE GOAL IT WAS CALLED ABOUT. Every day in
-- the window goes back through greeter_goal_for(), so re-stamping a month-long
-- baseline does not flatten the promo week inside it — those days resolve to
-- the promo again and are left alone. That is also what lets the DELETE path
-- call this same function: with the goal gone the days resolve to whatever is
-- left, possibly nothing, and the NULL-out falls out for free.
--
-- p_to NULL means open-ended, which in practice means "to the last day anybody
-- has submitted" — there is nothing to re-stamp in the future.
--
-- Both counts are returned separately because they are different grains: four
-- greeter rows and one site row is one DAY at a four-greeter site, and adding
-- them into "5 rows" would be arithmetic on two different units. IS DISTINCT
-- FROM on every column keeps the count meaning "days that changed" rather than
-- "days considered", and stops the updated_at triggers firing on rows nothing
-- happened to.
--
-- updated_by / updated_by_email ARE DELIBERATELY LEFT ALONE, which means a
-- re-stamped row shows a fresh updated_at beside the email of whoever last
-- typed its numbers. That is the lesser of two wrongs: overwriting those
-- columns would destroy the only record of who entered the day, to replace it
-- with a name that isn't a person. The updated_at movement is true — the row
-- did change — and /admin/greeters says how many rows moved in the banner, so
-- the change is not silent.
CREATE OR REPLACE FUNCTION greeter_restamp_goals(
  p_site_number integer,
  p_from        date,
  p_to          date DEFAULT NULL
)
RETURNS TABLE (
  greeter_rows  integer,
  location_rows integer
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_greeter  integer := 0;
  v_location integer := 0;
BEGIN
  WITH resolved AS (
    SELECT
      d.id,
      f.capture_goal_pct,
      f.dob_goal
    -- The _live view, so a voided day is never re-graded. The UPDATE below
    -- needs no voided_at predicate of its own: it joins `resolved` on id, and
    -- an id that isn't in this SELECT cannot be written by it.
    FROM greeter_daily_live d
    -- LEFT JOIN LATERAL, not a plain one: when no window covers the day the
    -- resolver returns no rows, and an inner join would skip that day rather
    -- than clearing the stale goal off it. Clearing it is the point on delete.
    LEFT JOIN LATERAL greeter_goal_for(d.site_number, d.business_date) f ON true
    WHERE d.site_number = p_site_number
      AND d.business_date >= p_from
      AND (p_to IS NULL OR d.business_date <= p_to)
  ),
  changed AS (
    UPDATE greeter_daily d
       SET capture_goal_pct = r.capture_goal_pct,
           dob_goal         = r.dob_goal
      FROM resolved r
     WHERE d.id = r.id
       AND (d.capture_goal_pct IS DISTINCT FROM r.capture_goal_pct
         OR d.dob_goal         IS DISTINCT FROM r.dob_goal)
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_greeter FROM changed;

  WITH resolved AS (
    SELECT
      l.id,
      f.capture_goal_pct,
      f.dob_goal,
      f.member_goal_month_end
    FROM location_daily_live l
    LEFT JOIN LATERAL greeter_goal_for(l.site_number, l.business_date) f ON true
    WHERE l.site_number = p_site_number
      AND l.business_date >= p_from
      AND (p_to IS NULL OR l.business_date <= p_to)
  ),
  changed AS (
    UPDATE location_daily l
       SET capture_goal_pct      = r.capture_goal_pct,
           dob_goal              = r.dob_goal,
           member_goal_month_end = r.member_goal_month_end
      FROM resolved r
     WHERE l.id = r.id
       AND (l.capture_goal_pct      IS DISTINCT FROM r.capture_goal_pct
         OR l.dob_goal              IS DISTINCT FROM r.dob_goal
         OR l.member_goal_month_end IS DISTINCT FROM r.member_goal_month_end)
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_location FROM changed;

  greeter_rows  := v_greeter;
  location_rows := v_location;
  RETURN NEXT;
END
$$;

REVOKE ALL ON FUNCTION greeter_restamp_goals(integer, date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION greeter_restamp_goals(integer, date, date) TO service_role;

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
  reactivations       bigint,
  google_reviews      bigint,
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
    -- A plain total and nothing else. Not added to sign_ups, not divided by
    -- wash_sales, not compared to a goal.
    SUM(g.reactivations)         AS reactivations,
    -- Same deal. A review is not a capture and must never reach capture_pct.
    SUM(g.google_reviews)        AS google_reviews,
    SUM(g.hours_worked)          AS hours_worked,
    CASE WHEN SUM(g.hours_worked) > 0
      THEN ROUND(SUM(COALESCE(g.wash_sales, 0))::numeric / SUM(g.hours_worked), 2)
    END                          AS wash_sales_per_hour,
    ROUND(AVG(g.capture_goal_pct), 2) AS capture_goal_pct,
    ROUND(AVG(g.dob_goal), 2)         AS dob_goal,
    -- Opportunities = wash sales + sign-ups. The guard is on the sum, not on
    -- wash_sales alone: a stretch with no wash sales but some sign-ups is
    -- 100%, not unknown.
    CASE WHEN SUM(COALESCE(g.wash_sales, 0)) + SUM(COALESCE(g.sign_ups, 0)) > 0
      THEN ROUND(
             SUM(COALESCE(g.sign_ups, 0))::numeric * 100
             / (SUM(COALESCE(g.wash_sales, 0)) + SUM(COALESCE(g.sign_ups, 0))), 2)
    END                          AS capture_pct,
    -- dob keeps the wash_sales denominator. Deliberate, not an oversight.
    CASE WHEN SUM(g.wash_sales) > 0
      THEN ROUND((SUM(COALESCE(g.package_dollars, 0)) + SUM(COALESCE(g.extras_dollars, 0)))
                 / SUM(g.wash_sales), 2)
    END                          AS dob
  FROM greeter_daily_live g
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
-- greeter-scan-rates-02.sql is a SUPERSEDED copy of this function and is no
-- longer kept in lockstep — do not edit it. The live arithmetic (the scannable
-- denominator) is defined here and in greeter-house-accounts-10.sql.
--
-- THE DENOMINATOR IS NOT wash_sales. It is wash_sales minus house_accounts
-- minus rewashes: both are real wash sales that no customer can scan a card
-- for, so counting them punishes a site for business it did correctly. See
-- greeter-house-accounts-10.sql for the full reasoning, including why
-- capture_pct and dob deliberately keep the gross wash_sales figure rather
-- than netting these two off. That still holds. Note that 10's wider claim —
-- that capture_pct divides by wash_sales — was superseded on 2026-08-22 by
-- greeter-capture-13.sql, which moved the denominator to wash_sales +
-- sign_ups. House accounts and rewashes are excluded from it either way.
CREATE OR REPLACE FUNCTION greeter_scan_rates(
  p_date_from      date    DEFAULT NULL,
  p_date_to        date    DEFAULT NULL,
  p_location_id    integer DEFAULT NULL,
  p_site_number    integer DEFAULT NULL,
  p_location_codes text[]  DEFAULT NULL
)
RETURNS TABLE (
  business_date        date,
  location_id          integer,
  site_number          integer,
  location_code        text,
  site_wash_sales      integer,
  -- The two deductions are returned individually as well as netted, because
  -- "why is my denominator 380 and not 400" is the first question this column
  -- will be asked.
  house_accounts       integer,
  rewashes             integer,
  scannable_wash_sales integer,
  scanned_wash_sales   bigint,
  greeters_logged      bigint,
  scanned_pct          numeric,
  ever_submitted       boolean
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
      l.wash_sales,
      l.house_accounts,
      l.rewashes,
      -- GREATEST(..., 0) because nothing stops a site from typing more
      -- rewashes than wash sales at 11pm, and a negative denominator would
      -- produce a negative percentage that looks like a code bug rather than
      -- like the typo it is.
      GREATEST(
        COALESCE(l.wash_sales, 0)
        - COALESCE(l.house_accounts, 0)
        - COALESCE(l.rewashes, 0),
        0
      ) AS scannable
    FROM location_daily_live l
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
    FROM greeter_daily_live g
    JOIN site s
      ON s.business_date = g.business_date
     AND s.location_id   = g.location_id
    GROUP BY g.business_date, g.location_id
  ),
  ever AS (
    -- Lets the UI tell "onboarded and slipping" (0%, flag it) apart from
    -- "never started" (blank, don't nag).
    SELECT DISTINCT g.location_id FROM greeter_daily_live g
  )
  SELECT
    s.business_date,
    s.location_id,
    s.site_number,
    s.location_code,
    s.wash_sales,
    s.house_accounts,
    s.rewashes,
    s.scannable::integer,
    COALESCE(sc.scanned, 0)::bigint,
    COALESCE(sc.greeters, 0)::bigint,
    -- NULL, not 0, when there were no SCANNABLE cars. That now covers two
    -- cases: the site sold nothing, and the site sold nothing a customer could
    -- have scanned for. Neither has a meaningful scan rate.
    CASE
      WHEN s.scannable > 0
      THEN ROUND(COALESCE(sc.scanned, 0)::numeric * 100 / s.scannable, 1)
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
      FROM location_daily_live l
     WHERE (p_location_id    IS NULL OR l.location_id   =  p_location_id)
       AND (p_site_number    IS NULL OR l.site_number   =  p_site_number)
       AND (p_location_codes IS NULL OR l.location_code = ANY(p_location_codes))
    UNION ALL
    SELECT g.location_id, g.site_number, g.location_code, g.business_date
      FROM greeter_daily_live g
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
      FROM greeter_daily_live g
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
  -- The _live view, which is the ONLY correct spelling here: `l.voided_at IS
  -- NULL` in this query's WHERE would turn the LEFT JOIN into an inner one and
  -- drop every missing day. A voided site day therefore counts as missing
  -- again, which is the answer this function should give.
  LEFT JOIN location_daily_live l
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
--   neither capture_pct IS NULL (no wash sales AND no sign-ups — nothing
--           happened, so there is no rate)
--           OR capture_goal_pct IS NULL (no goal window covered the day)
-- The "neither" bucket is returned as ungraded_days rather than dropped, so the
-- page can say "5 of 12 days couldn't be graded" instead of quietly reporting
-- percentages off a denominator the reader can't see. The percentages are over
-- GRADEABLE days: dividing by days_logged would let a greeter improve their
-- standing by logging days on which nothing happened.
--
-- This bucket got smaller on 2026-08-22. Under the old sign_ups/wash_sales
-- definition a day with sign-ups but no wash sales was NULL and landed here;
-- it is now a genuine 100% and grades as a day over goal.
--
-- low_sample (fewer than 3 gradeable days) exists because two days, both under
-- goal, is "100% under goal" and would otherwise open the underperformer list.
-- The page sorts these to the BOTTOM of both lists with a note rather than
-- hiding them. Computed here, not in the page, so one definition of "few
-- reported numbers" serves every view.
--
-- Three is the floor, not five: four days in a seven-day window is an ordinary
-- part-time schedule, and flagging it made the tag noise rather than signal.
--
-- Weighting follows section 5: summed numerator over summed denominator for
-- capture_pct/dob, AVG for the goal columns.
--
-- Kept in lockstep with supabase/greeter-churn-reviews-09.sql. Change both.
-- (04 defined this function first, but 07 and 09 have since superseded it —
-- read 09, not 04, for the current shape.)
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
  reactivations       bigint,
  google_reviews      bigint,
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
      g.reactivations,
      g.google_reviews,
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
    FROM greeter_daily_live g
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
    -- Keep in lockstep with greeter-churn-reviews-09.sql. See the note above.
    (COUNT(*) FILTER (WHERE r.gradeable) < 3)             AS low_sample,
    SUM(r.wash_sales)::bigint                             AS wash_sales,
    SUM(r.sign_ups)::bigint                               AS sign_ups,
    SUM(r.reactivations)::bigint                          AS reactivations,
    SUM(r.google_reviews)::bigint                         AS google_reviews,
    SUM(r.package_dollars)                                AS package_dollars,
    SUM(r.extras_dollars)                                 AS extras_dollars,
    SUM(r.hours_worked)                                   AS hours_worked,
    CASE WHEN SUM(r.hours_worked) > 0
      THEN ROUND(SUM(COALESCE(r.wash_sales, 0))::numeric / SUM(r.hours_worked), 2)
    END                                                   AS wash_sales_per_hour,
    ROUND(AVG(r.capture_goal_pct), 2)                     AS capture_goal_pct,
    ROUND(AVG(r.dob_goal), 2)                             AS dob_goal,
    -- Opportunities = wash sales + sign-ups. Must match greeter_rollup exactly;
    -- the two are shown on screens a click apart and any drift reads as a bug.
    CASE WHEN SUM(COALESCE(r.wash_sales, 0)) + SUM(COALESCE(r.sign_ups, 0)) > 0
      THEN ROUND(
             SUM(COALESCE(r.sign_ups, 0))::numeric * 100
             / (SUM(COALESCE(r.wash_sales, 0)) + SUM(COALESCE(r.sign_ups, 0))), 2)
    END                                                   AS capture_pct,
    -- dob keeps the wash_sales denominator. Deliberate, not an oversight.
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
-- churn_pct rides along at DAY grain, which is the only grain it is honest at.
-- It arrives already divided, with the site keeping the numerator and the member
-- base to itself, so there is nothing to re-sum and any period figure would be a
-- flat average of daily percentages — the exact thing section 5 forbids. Day rows
-- only; do not add it to a rollup function.
--
-- greeter-churn-reviews-09.sql holds an EARLIER copy of this function and is no
-- longer kept in lockstep — do not edit it. The current shape is defined here
-- and in greeter-house-accounts-10.sql, which added house_accounts.
--
-- This function does no dividing. It hands out day rows, including both
-- unscannable-car columns, and the report page sums them and divides once —
-- because a period scan rate must be summed numerator over summed denominator,
-- never an average of daily percentages (section 5).
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
      l.google_reviews
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
