-- Seed the greeter scorecard from the Binghamton August 2026 greeter charts.
--
-- Run greeter-clear-all-05.sql first if you still have hand-entered test rows.
--
-- SOURCE: "Binghamton Greeter Charts.xlsx", site 122, August 2026. Every number
-- below is copied off that workbook. NOTHING IS INVENTED — no synthetic days,
-- no filled-in blanks, no other sites. That means the report's 60-day presets
-- (underperformers / top performers) and the site-ranking chart will look thin:
-- one site, fifteen calendar days, and only five of them with site totals.
-- That is the real shape of the data, and a scorecard that looked fuller than
-- the numbers behind it would be worse than a sparse one.
--
-- WHY THIS IS ONE GIANT `DO` BLOCK. The first cut of this file resolved the
-- location and the greeter ids into TEMP TABLES and then read them from the
-- INSERTs a few statements later. That fails in the Supabase SQL editor with
--     ERROR: 42P01: relation "_seed_scope" does not exist
-- because the editor does not hold one session across statement boundaries the
-- way psql does — the temp tables are gone before the statement that needs them
-- runs. Everything that has to see the resolved keys therefore lives inside a
-- single DO block: one statement, one session, one transaction. Nothing is
-- carried between statements, so there is nothing to lose. It also means the
-- whole seed is atomic without an explicit BEGIN/COMMIT (which additionally
-- provoked `WARNING: there is already a transaction in progress` in this
-- editor) — a RAISE anywhere below rolls back all of it.
--
-- TWO JUDGEMENT CALLS, both flagged because they are NOT from the workbook:
--
--   1. dob_goal = 7.00. Only the capture goal (20%) was specified, and
--      greeter_goals.dob_goal is NOT NULL so a number had to go in. 7.00 is a
--      round figure just under the site's actual D.O.B. for the days that have
--      one ($7.11 — see the footer note below), which mirrors how the capture
--      goal was set: 20% against an actual 23.2%, a floor rather than a
--      stretch. Change it with the UPDATE at the bottom of this file; nothing
--      else depends on the value.
--
--   2. Kedar Clarke's 2026-08-05 shift is stored as 16:00–20:00, read off the
--      "4pm-8pm" note on his sheet. It is the only shift window anywhere in
--      the workbook, so it is also the only row where hours_worked and
--      wash_sales_per_hour compute at all. Drop the two time values if you'd
--      rather every row be shift-less and consistent.
--
-- THREE NUMBERS THAT LOOK WRONG AND AREN'T:
--
--   a) THE SITE TOTAL WILL NOT MATCH THE WORKBOOK'S OWN FOOTER, and that is the
--      point. The workbook reports 27.50% capture and $7.41 D.O.B. for the
--      month; this data will report 23.16% and $7.11. Neither transcription is
--      wrong — the footer is a FLAT AVERAGE of the five daily percentages
--      ((30.77 + 18.18 + 30.77 + 14.94 + 42.86) / 5 = 27.50), which lets a
--      14-car Tuesday count as heavily as an 87-car Monday. The scorecard
--      recomputes from summed numerators and denominators (41 sign ups over 177
--      wash sales = 23.16%), which is the number that actually reconciles to
--      the rows underneath it. This gap is exactly the reporting error the
--      scorecard exists to remove; expect it, don't "fix" it.
--
--   b) Dylan Donovan, 2026-08-13 — 2 wash sales, 3 sign ups. capture_pct
--      generates as 150.00. What the sheet says (a member signed up off a car
--      that wasn't an ALC sale, or a scan landed on the wrong day).
--
--   c) 2026-08-05 scans over 100%. The site tab records 14 ALC cars; the
--      greeter tabs record 15 + 6 + 1 = 22 for the same day, so
--      greeter_scan_rates() returns 157.1%. Again a source-sheet
--      inconsistency, preserved rather than papered over.
--
-- All three are left as-is per "workbook only". If any turns out to be a
-- transcription error on the sheet, fix the sheet and re-run — this file is
-- idempotent.
--
-- WHAT THIS FILE DOES NOT WRITE:
--   * capture_pct, dob, hours_worked, wash_sales_per_hour, net_members — all
--     GENERATED ALWAYS ... STORED. Postgres computes them; inserting into them
--     is an error, not an override.
--   * rewashes — the "1re" / "3re" notes on the greeter sheets almost certainly
--     mean rewash counts, but they're free text in a notes column and reading
--     them as integers would be interpretation, not transcription. They are
--     preserved verbatim in `comments` instead. Say the word and they can be
--     promoted to the rewashes column.
--   * cancellations, total_members, member_goal_month_end — the workbook has no
--     membership roll or churn figures at all, so these stay NULL. One caveat:
--     net_members is generated as
--     COALESCE(sign_ups, 0) - COALESCE(cancellations, 0), so a NULL
--     cancellations day reports its sign ups as pure net growth. That is the
--     schema's existing behaviour rather than something this file introduces,
--     but it means "net members" on these rows reads as "sign ups, churn
--     unknown" — do not present it as real membership growth.
--
-- IDEMPOTENT. Both daily tables upsert on their natural unique keys and the
-- goal row is ON CONFLICT DO NOTHING, so re-running corrects rows rather than
-- duplicating them. Re-running will NOT change an existing goal row (an
-- exclusion constraint means there can only be one window per site) — delete
-- it first if you want a different target.
--
-- OUTPUT. Expect "Success. No rows returned." from the DO block — the Supabase
-- dashboard editor generally does not surface RAISE NOTICE, so the NOTICEs in
-- it are for psql and for anyone reading a log. The SELECT after the block is
-- the only feedback you will actually see, and it is where you verify the seed.

DO $$
DECLARE
  -- The resolved keys. These are the ONLY state the seed carries, and they
  -- live in variables precisely so no temp table has to survive a statement
  -- boundary. See the header.
  v_location_id   integer;
  v_site_number   integer;
  v_location_code text;
  v_user_id       uuid;
  v_email         text;

  v_n         bigint;
  v_offender  text;
  v_uncovered date;
  v_rows      bigint;
BEGIN
  -- =========================================================================
  -- 1. Resolve the location. Nothing is hardcoded except the site number.
  -- =========================================================================
  -- Same chain the worker walks at submit time — locations.site_number ->
  -- pricing_simple -> location_code, probing unpadded then zero-padded because
  -- pricing_simple.site is TEXT and its padding has been observed to diverge
  -- from the integer in `locations`. See resolveGreeterLocationKey() in
  -- packages/db-supabase/src/greeter.ts.
  --
  -- Copying an id out of the dashboard and pasting it here would work today and
  -- silently seed the wrong site the next time these tables are rebuilt.
  --
  -- count(*) OVER () rides along so one query answers both "what is it" and
  -- "is it unique". It is computed on the already-DISTINCTed subquery, not
  -- alongside the DISTINCT, or duplicate pricing_simple rows would inflate it.
  SELECT x.location_id, x.site_number, x.location_code, x.n
    INTO v_location_id, v_site_number, v_location_code, v_n
  FROM (
    SELECT d.*, count(*) OVER () AS n
    FROM (
      SELECT DISTINCT
        l.id::integer          AS location_id,
        l.site_number::integer AS site_number,
        btrim(p.location_code) AS location_code
      FROM locations l
      JOIN pricing_simple p
        ON p.site IN (
             l.site_number::text,
             lpad(l.site_number::text, 3, '0'),
             lpad(l.site_number::text, 4, '0')
           )
      WHERE l.site_number = 122
        AND p.location_code IS NOT NULL
        AND btrim(p.location_code) <> ''
    ) d
  ) x;

  -- A missing location_code produces rows invisible to their own location
  -- admin; an ambiguous one produces rows split across two spellings of the
  -- same site. Both are silent — they look like a successful seed and only
  -- surface weeks later as numbers that don't add up. Fail loudly instead,
  -- inside the transaction, so nothing lands.
  IF v_location_id IS NULL THEN
    RAISE EXCEPTION 'Seed aborted: site 122 has no locations row joined to a pricing_simple.location_code. Check locations.site_number = 122 and that pricing_simple has a row for site ''122'' (padded or not) with a non-empty location_code.';
  ELSIF v_n > 1 THEN
    RAISE EXCEPTION 'Seed aborted: site 122 resolved to % distinct location keys. pricing_simple has conflicting location_code values for this site; fix that before seeding.', v_n;
  END IF;

  -- The actor stamped on every row. created_by is `uuid NOT NULL` and
  -- created_by_email is `text NOT NULL`, so both have to come from somewhere
  -- real — a made-up uuid would make these rows unattributable in an audit.
  SELECT u.id, u.email::text, count(*) OVER ()
    INTO v_user_id, v_email, v_n
  FROM auth.users u
  WHERE lower(u.email) = 'josh.copp@splashcarwashes.com';

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Seed aborted: no auth.users row for josh.copp@splashcarwashes.com. Edit the address in section 1 to whichever account should own these rows.';
  ELSIF v_n > 1 THEN
    RAISE EXCEPTION 'Seed aborted: % auth.users rows match josh.copp@splashcarwashes.com. Pick one by id.', v_n;
  END IF;

  RAISE NOTICE 'Seeding location_id=% site=% code=% as %',
    v_location_id, v_site_number, v_location_code, v_email;

  -- =========================================================================
  -- 2. Every greeter name must resolve to exactly one beekeeper_users row.
  -- =========================================================================
  -- beekeeper_user_id is the stable identity on greeter_daily and it has to be
  -- the SAME id the form writes, or one person appears twice in every rollup.
  -- Matched on the display name the roster builds — display_name when set, else
  -- firstname + lastname — see rosterName() in greeter.ts.
  --
  -- The name list appears here and again in section 5's roster CTE. Keeping the
  -- two in step is enforced at the bottom of section 5, which asserts the insert
  -- touched exactly 37 rows: a name that drifts out of either list drops rows
  -- from the join and trips that check.
  --
  -- Daniel Ralston is deliberately absent from both. He has a sheet in the
  -- workbook and not one day of data on it. Seeding him a zero row would invent
  -- a day he didn't work and would drag his capture rate into the
  -- underperformer list off nothing at all.
  SELECT string_agg(p.full_name || ' (' || c.n || ' matches)', ', ' ORDER BY p.full_name)
    INTO v_offender
  FROM (VALUES
    ('Nathan Schneider'),
    ('Kedar Clarke'),
    ('Hasan Wakefield'),
    ('Skylar Baranyk'),
    ('David Lee'),
    ('Dylan Donovan'),
    ('Maximus Kinner')
  ) AS p(full_name)
  CROSS JOIN LATERAL (
    SELECT count(*) AS n
    FROM beekeeper_users b
    WHERE COALESCE(
            NULLIF(btrim(b.display_name), ''),
            btrim(concat_ws(' ', b.firstname, b.lastname))
          ) ILIKE p.full_name
  ) c
  WHERE c.n <> 1;

  IF v_offender IS NOT NULL THEN
    RAISE EXCEPTION 'Seed aborted: these names do not resolve to exactly one beekeeper_users row: %. 0 matches means the standardized name differs from display_name (or firstname + lastname); 2+ means duplicate people and the right id has to be picked by hand.', v_offender;
  END IF;

  -- =========================================================================
  -- 3. The goal — 20% capture, open-ended from 2026-08-01.
  -- =========================================================================
  -- Open-ended (effective_to NULL) so it also covers days entered after the
  -- workbook's window; the exclusion constraint on greeter_goals guarantees it
  -- can never overlap a second window for this site.
  --
  -- ON CONFLICT DO NOTHING is targetless on purpose: the guard here is an
  -- EXCLUDE ... USING gist constraint, which a column-list conflict target
  -- cannot name. It also means an existing goal row wins — see the header.
  INSERT INTO greeter_goals (
    site_number, location_code, effective_from, effective_to,
    capture_goal_pct, dob_goal, member_goal_month_end, note, created_by
  )
  VALUES (
    v_site_number,
    v_location_code,
    DATE '2026-08-01',
    NULL,
    20.00,   -- specified
    7.00,    -- ASSUMED — see the header
    NULL,    -- no membership target in the workbook
    'Seeded from the Binghamton August 2026 greeter charts. Capture goal 20% as specified; D.O.B. goal assumed.',
    v_user_id
  )
  ON CONFLICT DO NOTHING;

  -- ...and then confirm a goal actually covers the whole seeded window.
  --
  -- The DO NOTHING above is silent by design, which opens one specific trap: a
  -- pre-existing site-122 goal with a NARROWER window (say 2026-08-01 to
  -- 2026-08-10) blocks the insert without covering Aug 11-15, and the snapshot
  -- joins below would then write NULL goals onto those days. Nothing errors —
  -- the rows just land ungradeable, and greeter_period_report() quietly reports
  -- them as "couldn't be graded" weeks later. Check every day in the window.
  SELECT d::date INTO v_uncovered
  FROM generate_series(DATE '2026-08-01', DATE '2026-08-15', interval '1 day') d
  WHERE NOT EXISTS (
    SELECT 1
    FROM greeter_goals g
    WHERE g.site_number = v_site_number
      AND d::date BETWEEN g.effective_from
                      AND COALESCE(g.effective_to, DATE '9999-12-31')
  )
  LIMIT 1;

  IF v_uncovered IS NOT NULL THEN
    RAISE EXCEPTION 'Seed aborted: no greeter_goals window covers % for site 122. A goal row already exists but does not span 2026-08-01..2026-08-15; delete it and re-run, or widen its effective_to.', v_uncovered;
  END IF;

  -- =========================================================================
  -- 4. location_daily — the site's own totals. Seven days.
  -- =========================================================================
  -- They are not uniform: Aug 1-5 have the full metric set, then the site tab
  -- records sign ups only on Aug 14 and 15 with no car counts and no dollars.
  -- Those two rows go in exactly as they are. With wash_sales NULL their
  -- capture_pct and dob generate as NULL, which is correct — a day with no
  -- denominator has no rate, and the report draws that as a gap rather than 0%.
  -- Aug 6-13 have no site row at all in the workbook, so they get none here,
  -- and greeter_missing_days() will correctly flag them.
  --
  -- Goal columns are joined off greeter_goals rather than typed in, so the
  -- snapshot on each row can't drift from the goal that governs it.
  INSERT INTO location_daily (
    business_date, location_id, site_number, location_code,
    total_cars, wash_sales, rewashes, package_dollars, extras_dollars,
    sign_ups, cancellations, total_members,
    capture_goal_pct, dob_goal, member_goal_month_end,
    comments, created_by, created_by_email
  )
  SELECT
    v.business_date, v_location_id, v_site_number, v_location_code,
    v.total_cars, v.wash_sales, NULL, v.package_dollars, v.extras_dollars,
    v.sign_ups, NULL, NULL,
    g.capture_goal_pct, g.dob_goal, g.member_goal_month_end,
    v.comments, v_user_id, v_email
  FROM (VALUES
    --  date                     cars       ALC       package $         extras $       sign ups  comment
    (DATE '2026-08-01', 401::integer,  39::integer, 202.00::numeric, 112.00::numeric, 12::integer, NULL::text),
    (DATE '2026-08-02', 180,           11,          128.00,           11.00,           2,          NULL),
    (DATE '2026-08-03', 346,           26,           87.00,           46.00,           8,          NULL),
    (DATE '2026-08-04', 327,           87,          422.00,          192.00,          13,          NULL),
    (DATE '2026-08-05', 164,           14,           43.00,           16.00,           6,          NULL),
    -- Sign ups only from here — the site tab stops recording cars and dollars.
    (DATE '2026-08-14', NULL,          NULL,        NULL,             NULL,            7,          'Sign ups only on the site tab; no car count or dollars recorded.'),
    (DATE '2026-08-15', NULL,          NULL,        NULL,             NULL,            4,          'Sign ups only on the site tab; no car count or dollars recorded.')
  ) AS v(business_date, total_cars, wash_sales, package_dollars, extras_dollars, sign_ups, comments)
  LEFT JOIN greeter_goals g
    ON g.site_number = v_site_number
   AND v.business_date BETWEEN g.effective_from
                           AND COALESCE(g.effective_to, DATE '9999-12-31')
  -- Every column this file writes is in the SET list, including the ones it
  -- writes as NULL. A partial SET list would make a re-run asymmetric: the first
  -- run leaves rewashes NULL, a hand edit fills it in, and the re-run silently
  -- keeps the hand edit while overwriting everything around it. Either this file
  -- is the source of truth for a row or it isn't.
  ON CONFLICT (location_id, business_date) DO UPDATE SET
    -- Refreshed, not just carried: location_code is the caller-scoping column
    -- and has been observed to diverge between tables for the same site. If
    -- pricing_simple is corrected and this file re-run, a stale code left in
    -- place would keep the row invisible to its own location admin — the exact
    -- silent failure section 1 exists to prevent.
    site_number           = EXCLUDED.site_number,
    location_code         = EXCLUDED.location_code,
    total_cars            = EXCLUDED.total_cars,
    wash_sales            = EXCLUDED.wash_sales,
    rewashes              = EXCLUDED.rewashes,
    package_dollars       = EXCLUDED.package_dollars,
    extras_dollars        = EXCLUDED.extras_dollars,
    sign_ups              = EXCLUDED.sign_ups,
    cancellations         = EXCLUDED.cancellations,
    total_members         = EXCLUDED.total_members,
    capture_goal_pct      = EXCLUDED.capture_goal_pct,
    dob_goal              = EXCLUDED.dob_goal,
    member_goal_month_end = EXCLUDED.member_goal_month_end,
    comments              = EXCLUDED.comments,
    updated_by            = EXCLUDED.created_by,
    updated_by_email      = EXCLUDED.created_by_email;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 7 THEN
    RAISE EXCEPTION 'Seed aborted: location_daily touched % rows, expected 7. The VALUES list below section 4 has been edited without updating this check.', v_rows;
  END IF;
  RAISE NOTICE 'location_daily: % rows', v_rows;

  -- =========================================================================
  -- 5. greeter_daily — 37 person-days across seven greeters.
  -- =========================================================================
  -- Straight off each person's tab: ALC, package $, extras $, sign ups, and the
  -- free-text notes into `comments`. No total_cars column exists here on purpose
  -- (every greeter on a shift would type the same site number and summing across
  -- the crew would multiply the day).
  --
  -- The per-greeter ALC deliberately does not reconcile to the site's ALC — that
  -- gap IS the scan rate, and greeter_scan_rates() exists to measure it. Aug 4
  -- is the loud example: the site sold 87 ALC cars and greeters scanned 20.
  --
  -- Each row carries the greeter's STANDARDIZED name (the one in the form's
  -- dropdown), not the workbook's tab name — "Nate", "Dave" and "Max" are
  -- translated here rather than in a lookup table, so every row reads as what
  -- it will become. `roster` turns those names into ids; section 2 has already
  -- proven each one matches exactly one person, so this is an inner join with
  -- no possibility of a silent drop.
  WITH roster AS (
    SELECT p.greeter_name, b.id::text AS beekeeper_user_id
    FROM (VALUES
      ('Nathan Schneider'),
      ('Kedar Clarke'),
      ('Hasan Wakefield'),
      ('Skylar Baranyk'),
      ('David Lee'),
      ('Dylan Donovan'),
      ('Maximus Kinner')
    ) AS p(greeter_name)
    JOIN beekeeper_users b
      ON COALESCE(
           NULLIF(btrim(b.display_name), ''),
           btrim(concat_ws(' ', b.firstname, b.lastname))
         ) ILIKE p.greeter_name
  )
  INSERT INTO greeter_daily (
    business_date, location_id, site_number, location_code,
    beekeeper_user_id, greeter_name,
    wash_sales, rewashes, package_dollars, extras_dollars, sign_ups,
    shift_start, shift_end,
    capture_goal_pct, dob_goal,
    comments, created_by, created_by_email
  )
  SELECT
    v.business_date, v_location_id, v_site_number, v_location_code,
    r.beekeeper_user_id, r.greeter_name,
    v.wash_sales, NULL, v.package_dollars, v.extras_dollars, v.sign_ups,
    v.shift_start, v.shift_end,
    g.capture_goal_pct, g.dob_goal,
    v.comments, v_user_id, v_email
  FROM (VALUES
    --  who                  date                    ALC          package $        extras $       signs      shift start  shift end    note
    ('Nathan Schneider', DATE '2026-08-01', 15::integer, 115.00::numeric,  0.00::numeric, 1::integer, NULL::time, NULL::time, '1re'::text),
    ('Nathan Schneider', DATE '2026-08-02',  2,           17.00,            4.00,         0,          NULL,       NULL,       NULL),
    ('Nathan Schneider', DATE '2026-08-04', 13,           59.00,           16.00,         4,          NULL,       NULL,       '1re'),
    ('Nathan Schneider', DATE '2026-08-05', 15,           94.00,           28.00,         1,          NULL,       NULL,       NULL),
    ('Nathan Schneider', DATE '2026-08-06', 10,           55.00,           16.00,         2,          NULL,       NULL,       NULL),
    ('Nathan Schneider', DATE '2026-08-08', 20,          118.00,           32.00,         0,          NULL,       NULL,       '4pay'),
    ('Nathan Schneider', DATE '2026-08-09', 16,           95.00,           32.00,         0,          NULL,       NULL,       '1pay'),
    ('Nathan Schneider', DATE '2026-08-11', 23,          132.00,            8.00,         2,          NULL,       NULL,       '1re; 1pay; addons low; only 1 express'),
    ('Nathan Schneider', DATE '2026-08-12', 25,          137.00,           44.00,         1,          NULL,       NULL,       '1re'),
    ('Nathan Schneider', DATE '2026-08-13', 12,           66.00,           32.00,         1,          NULL,       NULL,       '1re'),
    ('Nathan Schneider', DATE '2026-08-14', 20,          117.00,           53.00,         4,          NULL,       NULL,       '3re'),

    -- The only recorded shift window in the workbook.
    ('Kedar Clarke',     DATE '2026-08-05',  6,           35.00,            0.00,         0,          TIME '16:00', TIME '20:00', '4pm-8pm'),
    ('Kedar Clarke',     DATE '2026-08-07',  6,            9.00,            0.00,         0,          NULL,       NULL,       '1re; 2pay; 2 scan mised but 1 was in lane 2'),

    ('Hasan Wakefield',  DATE '2026-08-04',  4,           23.00,            0.00,         0,          NULL,       NULL,       NULL),
    ('Hasan Wakefield',  DATE '2026-08-06',  3,           14.00,            0.00,         0,          NULL,       NULL,       NULL),
    ('Hasan Wakefield',  DATE '2026-08-11',  8,           61.00,           12.00,         0,          NULL,       NULL,       'great package working on pitch'),
    ('Hasan Wakefield',  DATE '2026-08-12',  5,           17.00,            8.00,         0,          NULL,       NULL,       'covered kedar'),
    ('Hasan Wakefield',  DATE '2026-08-13',  9,           43.00,           16.00,         2,          NULL,       NULL,       'shoulda had 3 signs customer was a jerk about it'),

    ('Skylar Baranyk',   DATE '2026-08-01', 20,           90.00,           14.00,         1,          NULL,       NULL,       NULL),
    ('Skylar Baranyk',   DATE '2026-08-04',  3,           20.00,            0.00,         0,          NULL,       NULL,       NULL),
    ('Skylar Baranyk',   DATE '2026-08-09', 14,           77.00,           28.00,         0,          NULL,       NULL,       '1re'),

    ('David Lee',        DATE '2026-08-07',  7,           45.00,           12.00,         0,          NULL,       NULL,       NULL),
    ('David Lee',        DATE '2026-08-14',  7,           46.00,            0.00,         1,          NULL,       NULL,       NULL),

    ('Dylan Donovan',    DATE '2026-08-01',  3,           17.00,            4.00,         0,          NULL,       NULL,       NULL),
    ('Dylan Donovan',    DATE '2026-08-03',  4,           15.00,            4.00,         2,          NULL,       NULL,       NULL),
    ('Dylan Donovan',    DATE '2026-08-06',  3,            6.00,            0.00,         0,          NULL,       NULL,       NULL),
    ('Dylan Donovan',    DATE '2026-08-08',  4,           12.00,            0.00,         0,          NULL,       NULL,       NULL),
    -- 3 sign ups on 2 wash sales. capture_pct generates as 150.00. See header.
    ('Dylan Donovan',    DATE '2026-08-13',  2,            6.00,            0.00,         3,          NULL,       NULL,       '2pay'),
    ('Dylan Donovan',    DATE '2026-08-15', 16,           49.00,           16.00,         1,          NULL,       NULL,       '1pay; so many express couldnt talk them outta it; work on dob'),

    ('Maximus Kinner',   DATE '2026-08-05',  1,            0.00,            0.00,         1,          NULL,       NULL,       '1re'),
    ('Maximus Kinner',   DATE '2026-08-06',  2,            9.00,            0.00,         0,          NULL,       NULL,       NULL),
    ('Maximus Kinner',   DATE '2026-08-07',  8,           20.00,            0.00,         0,          NULL,       NULL,       NULL),
    ('Maximus Kinner',   DATE '2026-08-09',  4,           31.00,            0.00,         0,          NULL,       NULL,       NULL),
    ('Maximus Kinner',   DATE '2026-08-10',  8,           55.00,            0.00,         1,          NULL,       NULL,       NULL),
    ('Maximus Kinner',   DATE '2026-08-11',  2,            6.00,            0.00,         0,          NULL,       NULL,       NULL),
    ('Maximus Kinner',   DATE '2026-08-12',  7,           48.00,            0.00,         0,          NULL,       NULL,       NULL),
    ('Maximus Kinner',   DATE '2026-08-14',  4,           11.00,            8.00,         1,          NULL,       NULL,       NULL)
  ) AS v(greeter_name, business_date, wash_sales, package_dollars, extras_dollars, sign_ups, shift_start, shift_end, comments)
  JOIN roster r ON r.greeter_name = v.greeter_name
  LEFT JOIN greeter_goals g
    ON g.site_number = v_site_number
   AND v.business_date BETWEEN g.effective_from
                           AND COALESCE(g.effective_to, DATE '9999-12-31')
  -- Full SET list, same reasoning as location_daily above.
  ON CONFLICT (location_id, beekeeper_user_id, business_date) DO UPDATE SET
    site_number       = EXCLUDED.site_number,
    location_code     = EXCLUDED.location_code,
    greeter_name      = EXCLUDED.greeter_name,
    wash_sales        = EXCLUDED.wash_sales,
    rewashes          = EXCLUDED.rewashes,
    package_dollars   = EXCLUDED.package_dollars,
    extras_dollars    = EXCLUDED.extras_dollars,
    sign_ups          = EXCLUDED.sign_ups,
    shift_start       = EXCLUDED.shift_start,
    shift_end         = EXCLUDED.shift_end,
    capture_goal_pct  = EXCLUDED.capture_goal_pct,
    dob_goal          = EXCLUDED.dob_goal,
    comments          = EXCLUDED.comments,
    updated_by        = EXCLUDED.created_by,
    updated_by_email  = EXCLUDED.created_by_email;

  -- The drift check promised in section 2. 37 is the row count of the VALUES
  -- list above; anything less means a name in it failed to join `roster`
  -- (someone edited one list and not the other), anything more means a name
  -- matched two beekeeper_users rows after section 2 ran.
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 37 THEN
    RAISE EXCEPTION 'Seed aborted: greeter_daily touched % rows, expected 37. A greeter name in section 5''s VALUES list is missing from its roster CTE (or vice versa).', v_rows;
  END IF;
  RAISE NOTICE 'greeter_daily: % rows', v_rows;
END $$;

-- ===========================================================================
-- 6. Prove it landed.
-- ===========================================================================
-- A SEPARATE statement from the DO block, and the LAST one in the file. The
-- Supabase SQL editor renders only the final statement's result grid: a check
-- placed before the seed is run and discarded, and so is every check but the
-- last if you write three of them. All three are unioned into one grid here so
-- all three are actually visible. Nothing here writes; re-run it any time.
--
-- EXPECTED:
--   counts     greeter_goals 1 · location_daily 7 · greeter_daily 37
--   goal       capture 20.00, dob 7.00, from 2026-08-01, no end
--   greeter    Nathan 11 days, Kedar 2, Hasan 5, Skylar 3, David 2, Dylan 6,
--              Maximus 8. Daniel Ralston must NOT appear.
--   site       1418 cars, 177 wash sales, 41 sign ups, 23.16%, $7.11
--
-- READ THE `goal` LINE, don't skim past it. The insert in section 3 is
-- ON CONFLICT DO NOTHING, so a goal row that already existed for site 122 wins
-- silently — the seed reports success while every row is graded against
-- whatever target was already there. If that line does not say 20.00 / 7.00,
-- delete the goal row and re-run the file.
--
-- READ THE `beekeeper_user_id` COLUMN TOO. The seed matches greeter names
-- across all of beekeeper_users; the form's dropdown only offers people
-- attached to site 122. If a name resolved to a same-named person from another
-- site, nothing errors — that greeter just splits into two identities the first
-- time someone submits the form. Spot-check the ids against the dropdown once.
--
-- The site line is restricted to the five days that HAVE a denominator. Drop
-- that filter and Aug 14-15's 11 sign ups ride into the numerator while
-- contributing nothing to the denominator, inflating capture to 29.38% — the
-- same shape of error as the workbook's flat-average footer. And 23.16% is
-- correct: it is NOT the workbook's 27.50%. See note (a) in the header.
--
-- The two daily counts are bounded to the seeded window. Unbounded they would
-- also count any pre-existing site-122 rows from another month and the "7 / 37"
-- expectation above would be wrong whenever clear-all wasn't run first.
WITH counts AS (
  SELECT 'greeter_goals'  AS label, count(*) AS n FROM greeter_goals  WHERE site_number = 122
  UNION ALL
  SELECT 'location_daily (Aug 1-15)', count(*) FROM location_daily
   WHERE site_number = 122 AND business_date BETWEEN DATE '2026-08-01' AND DATE '2026-08-15'
  UNION ALL
  SELECT 'greeter_daily (Aug 1-15)',  count(*) FROM greeter_daily
   WHERE site_number = 122 AND business_date BETWEEN DATE '2026-08-01' AND DATE '2026-08-15'
),
goal AS (
  SELECT effective_from::text || ' -> ' || COALESCE(effective_to::text, 'open')  AS label,
         capture_goal_pct                                                        AS capture_pct,
         dob_goal                                                                AS dob
  FROM greeter_goals
  WHERE site_number = 122
),
per_greeter AS (
  SELECT greeter_name                                                     AS label,
         max(beekeeper_user_id)                                           AS beekeeper_user_id,
         count(*)                                                         AS n,
         sum(wash_sales)::bigint                                          AS wash_sales,
         sum(sign_ups)::bigint                                            AS sign_ups,
         round(sum(sign_ups)::numeric * 100 / nullif(sum(wash_sales), 0), 2) AS capture_pct
  FROM greeter_daily
  WHERE site_number = 122
  GROUP BY greeter_name
),
site AS (
  SELECT 'Aug 1-5 (days with a denominator)'                              AS label,
         sum(total_cars)::bigint                                          AS n,
         sum(wash_sales)::bigint                                          AS wash_sales,
         sum(sign_ups)::bigint                                            AS sign_ups,
         round(sum(sign_ups)::numeric * 100 / sum(wash_sales), 2)         AS capture_pct,
         round((sum(package_dollars) + sum(extras_dollars)) / sum(wash_sales), 2) AS dob
  FROM location_daily
  WHERE site_number = 122
    AND wash_sales > 0
)
SELECT 1 AS ord, 'counts' AS section, label, NULL::text AS beekeeper_user_id, n,
       NULL::bigint AS wash_sales, NULL::bigint AS sign_ups,
       NULL::numeric AS capture_pct, NULL::numeric AS dob
FROM counts
UNION ALL
SELECT 2, 'goal',    label, NULL, NULL, NULL, NULL, capture_pct, dob FROM goal
UNION ALL
SELECT 3, 'greeter', label, beekeeper_user_id, n, wash_sales, sign_ups, capture_pct, NULL FROM per_greeter
UNION ALL
SELECT 4, 'site',    label, NULL, n, wash_sales, sign_ups, capture_pct, dob FROM site
ORDER BY ord, capture_pct DESC NULLS LAST, label;

-- ---------------------------------------------------------------------------
-- Changing the assumed D.O.B. goal. Updates the goal row and every snapshot
-- that was taken from it, so the two can't disagree. Run all three together as
-- one selection — the editor wraps a multi-statement run in a transaction.
-- ---------------------------------------------------------------------------
-- UPDATE greeter_goals  SET dob_goal = 7.11 WHERE site_number = 122;
-- UPDATE greeter_daily  SET dob_goal = 7.11 WHERE site_number = 122;
-- UPDATE location_daily SET dob_goal = 7.11 WHERE site_number = 122;
