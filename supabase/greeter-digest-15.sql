-- Greeter scorecard, migration 15: weekly digest enrollment + suppression.
--
-- Run the WHOLE file — select all (Ctrl+A) first. Running a highlighted fragment
-- fails with "syntax error at end of input", because most of this file is
-- comments and a comment-only selection parses to nothing.
--
-- Safe to re-run. Every statement is IF NOT EXISTS or ON CONFLICT DO NOTHING,
-- and the seed will not resurrect a site you have since un-enrolled through the
-- admin card — see "WHY THE SEED IS NOT IDEMPOTENT IN THE WAY YOU EXPECT" below.
--
-- Depends on nothing in 01-14. It adds two standalone tables and touches no
-- existing table, view, or function. Nothing in the scorecard reads these; only
-- the Monday digest cron and the super_admin card on /admin/greeters do.
--
--
-- WHAT THIS IS FOR
--
-- A cron in performance-worker mails a weekly greeter digest to the managers
-- who hold the `pertrack` tool grant. Two questions have to be answered before
-- that email can be addressed, and neither can be derived from existing data:
--
--   1. Which sites are ON the scorecard? (greeter_digest_locations)
--   2. Which people should NOT be mailed? (greeter_digest_suppressions)
--
--
-- WHY ENROLLMENT IS AN EXPLICIT TABLE AND NOT DERIVED
--
-- The obvious derivation is "a site is enrolled if somebody holds pertrack on
-- it". That is wrong, and the way it is wrong is the whole reason this table
-- exists. pertrack grants are held REGION-WIDE by a few people — one trainer
-- holds it on 37 locations. Deriving the site list from grants would put all 37
-- in his digest, two dozen of which have never been given the tool at all. He
-- would get a weekly email scolding sites that were never asked to submit.
--
-- The other obvious derivation is "a site is enrolled once it logs its first
-- row". That is worse: it excludes precisely the sites the digest exists to
-- nudge. batavia_veterans, cicero and watertown are seeded below with zero
-- logged rows. A digest that only lists sites that are already submitting can
-- never say "you have not submitted".
--
-- So: "this site is on the scorecard" and "this person can see the scorecard"
-- are two different facts. Grants answer the second. This table answers the
-- first. A recipient's digest is the intersection.
--
--
-- WHY THERE IS NO FOREIGN KEY ON location_code
--
-- There is nowhere to point it. `locations` has no location_code column at all
-- (it has location, site, mla_location, site_number) and its only unique key is
-- the surrogate id. pricing_simple has location_code but its primary key is
-- (location_code, pkg), so the column is not unique there either — 350 rows
-- across 79 codes. Nothing in this database holds a one-row-per-code table of
-- location codes to reference.
--
-- The CHECK below therefore enforces shape, not existence: lowercase, no
-- whitespace, non-empty. A code that is well-formed but wrong — a typo, or a
-- site that was renamed — will insert cleanly. That is caught in the admin
-- card's drift panel, which lists enrolled codes with no pricing_simple match
-- alongside logged codes with no enrollment row. The final SELECT in this file
-- runs the same check once for the seed.
--
-- Do not "fix" this by adding a unique index to pricing_simple.location_code.
-- The multi-row-per-code shape is the pricing table's whole design.
--
--
-- WHY THE SEED IS NOT IDEMPOTENT IN THE WAY YOU EXPECT
--
-- ON CONFLICT DO NOTHING, not upsert. Re-running this file after someone has
-- un-enrolled a site through the card must NOT put it back — the card is the
-- authority once the table exists, and a re-run is usually someone checking
-- that the migration applied, not someone asking to reset enrollment. The
-- verification block reports the actual row count rather than asserting 10, so
-- a legitimately-edited table still reads as healthy.
--
-- If you genuinely want the seed state back, DELETE the table's rows first.
--
--
-- WHY SUPPRESSION IS BY EMAIL AND NOT BY user_id
--
-- The thing being suppressed is a delivery, and the digest is addressed by
-- email. user_permissions has both columns but its email is the one the
-- pricing_simple trigger populates, so it is the value actually in hand at send
-- time. Suppressing by user_id would need a join that could miss a row the
-- trigger created without a matching auth user.
--
-- The immediate use is the super_admins: their user_permissions rows carry
-- location_code IS NULL, which is a wildcard, so they would otherwise receive a
-- digest covering every enrolled site. Josh's decision was to keep them off the
-- list FOR NOW and expects that to change. That is why they are held out by data
-- rather than by a `role <> 'super_admin'` filter in the worker — turning them
-- back on should be a DELETE, not a deploy.


-- ===========================================================================
-- 1. greeter_digest_locations — the sites the digest covers.
-- ===========================================================================
-- One row per enrolled site. Presence in this table is the entire definition of
-- "on the scorecard"; absence means the site is not mentioned in anyone's
-- digest, however many grants exist on it.

CREATE TABLE IF NOT EXISTS greeter_digest_locations (
  location_code     text PRIMARY KEY,
  enrolled_at       timestamptz NOT NULL DEFAULT now(),
  -- Nullable on purpose: the seed rows below were not enrolled by a person
  -- clicking a button, and recording a fake actor for them would be a lie the
  -- audit trail could not distinguish from a real one.
  enrolled_by_email text,
  note              text
);

-- Shape only. See "WHY THERE IS NO FOREIGN KEY" above — this cannot and does
-- not check that the code names a real site.
ALTER TABLE greeter_digest_locations
  DROP CONSTRAINT IF EXISTS greeter_digest_locations_code_shape;
ALTER TABLE greeter_digest_locations
  ADD CONSTRAINT greeter_digest_locations_code_shape
  CHECK (
    location_code = lower(location_code)
    AND length(location_code) > 0
    AND location_code !~ '\s'
  );

COMMENT ON TABLE greeter_digest_locations IS
  'Sites covered by the weekly greeter digest. Explicit enrollment, never derived from grants or from logged rows — see greeter-digest-15.sql. A recipient''s digest is their granted locations intersected with this table.';
COMMENT ON COLUMN greeter_digest_locations.location_code IS
  'Lowercase slug matching greeter_daily.location_code / pricing_simple.location_code. No FK is possible; nothing in this database holds a unique list of codes.';
COMMENT ON COLUMN greeter_digest_locations.enrolled_by_email IS
  'The super_admin who enrolled the site through /admin/greeters. NULL for the rows seeded by migration 15.';

-- ===========================================================================
-- 2. greeter_digest_suppressions — people the digest must not reach.
-- ===========================================================================
-- Checked last, after recipients are resolved and after their site list is
-- built. A suppressed address is dropped whole; there is deliberately no
-- per-site suppression, because the complaint this answers is always "stop
-- mailing me", never "mail me about fewer sites".

CREATE TABLE IF NOT EXISTS greeter_digest_suppressions (
  email            text PRIMARY KEY,
  -- Free text, but write something. Six months from now the only way to know
  -- whether a suppression is still wanted is what somebody typed here.
  reason           text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by_email text
);

-- Lowercase is enforced rather than normalised because the worker looks this
-- table up by exact match against a lowercased address. A mixed-case row would
-- sit in the table looking effective and silently suppress nobody.
ALTER TABLE greeter_digest_suppressions
  DROP CONSTRAINT IF EXISTS greeter_digest_suppressions_email_shape;
ALTER TABLE greeter_digest_suppressions
  ADD CONSTRAINT greeter_digest_suppressions_email_shape
  CHECK (
    email = lower(email)
    AND position('@' IN email) > 1
    AND email !~ '\s'
  );

COMMENT ON TABLE greeter_digest_suppressions IS
  'Addresses the weekly greeter digest must not send to. Currently holds the super_admins, who are excluded by data rather than by code so re-enabling them is a DELETE and not a deploy. See greeter-digest-15.sql.';
COMMENT ON COLUMN greeter_digest_suppressions.email IS
  'Lowercase. Matched exactly against the lowercased recipient address; a mixed-case row would suppress nothing.';

-- ===========================================================================
-- 3. Access.
-- ===========================================================================
-- RLS on with zero policies, matching greeter_daily, location_daily,
-- greeter_goals and site_monthly_targets. Every worker reaches Supabase with
-- the service key, which bypasses RLS, so this is what actually keeps anon and
-- authenticated out.
--
-- The REVOKEs go further than the older greeter tables do — those still carry
-- Supabase's default anon/authenticated grants and rely on RLS alone. Two locks
-- rather than one, on a table whose whole job is deciding who gets mailed.

ALTER TABLE greeter_digest_locations    ENABLE ROW LEVEL SECURITY;
ALTER TABLE greeter_digest_suppressions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE greeter_digest_locations    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE greeter_digest_suppressions FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE greeter_digest_locations    TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE greeter_digest_suppressions TO service_role;

-- ===========================================================================
-- 4. Seed — the ten sites on the tool today.
-- ===========================================================================
-- Seven of these have logged rows (binghamton, cortland, elmira_heights,
-- johnson_city, leray, oswego, vestal). Three do not — batavia_veterans, cicero
-- and watertown are onboarding, and are enrolled precisely so the digest can
-- tell somebody they have not started. `test` is deliberately absent.
--
-- All ten were confirmed present in pricing_simple before this file was
-- written; section 5 re-confirms it rather than trusting that.

INSERT INTO greeter_digest_locations (location_code, enrolled_by_email, note)
VALUES
  ('batavia_veterans', NULL, 'Seeded by migration 15. Onboarding — no logged rows at seed time.'),
  ('binghamton',       NULL, 'Seeded by migration 15.'),
  ('cicero',           NULL, 'Seeded by migration 15. Onboarding — no logged rows at seed time.'),
  ('cortland',         NULL, 'Seeded by migration 15.'),
  ('elmira_heights',   NULL, 'Seeded by migration 15.'),
  ('johnson_city',     NULL, 'Seeded by migration 15.'),
  ('leray',            NULL, 'Seeded by migration 15.'),
  ('oswego',           NULL, 'Seeded by migration 15.'),
  ('vestal',           NULL, 'Seeded by migration 15.'),
  ('watertown',        NULL, 'Seeded by migration 15. Onboarding — no logged rows at seed time.')
ON CONFLICT (location_code) DO NOTHING;

-- No suppression rows are seeded. The super_admin addresses go in through the
-- card, so that each one carries a real created_by_email and a reason — the two
-- things that make a suppression reversible with confidence later.

-- ===========================================================================
-- 5. Verification — must be the LAST statement.
-- ===========================================================================
-- The editor renders only the final result grid, so this sits alone at the end.
-- Expect eight rows, all ok = true.
--
-- Row 6 is the one worth reading closely: it is the only check that looks at
-- the CONTENT of the seed rather than the shape of the table, and it is what
-- would catch a typo'd code that the CHECK constraint happily accepted.

SELECT 'greeter_digest_locations exists' AS check_name,
       to_regclass('public.greeter_digest_locations') IS NOT NULL AS ok,
       '' AS detail
UNION ALL
SELECT 'greeter_digest_suppressions exists',
       to_regclass('public.greeter_digest_suppressions') IS NOT NULL,
       ''
UNION ALL
SELECT 'location_code shape is checked',
       EXISTS (SELECT 1 FROM pg_constraint
               WHERE conname = 'greeter_digest_locations_code_shape'),
       ''
UNION ALL
SELECT 'suppression email shape is checked',
       EXISTS (SELECT 1 FROM pg_constraint
               WHERE conname = 'greeter_digest_suppressions_email_shape'),
       ''
UNION ALL
SELECT 'RLS is on for both tables',
       (SELECT bool_and(c.relrowsecurity)
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relname IN ('greeter_digest_locations',
                            'greeter_digest_suppressions')),
       ''
UNION ALL
-- Every enrolled code names a site pricing knows about. Not a constraint,
-- because it cannot be one; this is the check that stands in for the FK.
SELECT 'every enrolled code matches a pricing_simple site',
       NOT EXISTS (
         SELECT 1 FROM greeter_digest_locations d
         WHERE NOT EXISTS (
           SELECT 1 FROM pricing_simple p WHERE p.location_code = d.location_code
         )
       ),
       COALESCE((SELECT string_agg(d.location_code, ', ' ORDER BY d.location_code)
                 FROM greeter_digest_locations d
                 WHERE NOT EXISTS (
                   SELECT 1 FROM pricing_simple p
                   WHERE p.location_code = d.location_code
                 )), 'none unmatched')
UNION ALL
-- Reported, not asserted. See "WHY THE SEED IS NOT IDEMPOTENT" — on a re-run
-- after someone has edited the list through the card, ten is the wrong number
-- and the edit is correct.
SELECT 'enrolled sites (10 on a first run; may differ after edits)',
       (SELECT COUNT(*) FROM greeter_digest_locations) > 0,
       (SELECT COUNT(*)::text FROM greeter_digest_locations)
UNION ALL
SELECT 'suppressions',
       true,
       (SELECT COUNT(*)::text FROM greeter_digest_suppressions)
ORDER BY 1;
