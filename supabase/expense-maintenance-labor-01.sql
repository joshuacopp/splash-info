-- Maintenance labor: an expense measured in HOURS, priced by an admin-set rate,
-- and reported inside Equipment Repair.
--
-- Run in the Supabase SQL editor AFTER expense-log-tables.sql, and BEFORE
-- deploying the performance-worker and apps/web changes that go with it.
-- Idempotent and re-runnable; the DO block at the bottom fails loudly if any
-- piece did not land.
--
-- Josh, 2026-08-21: "add 'maintenance labor' as a category. if that is chosen,
-- payment method should not be needed, and the input should be 'hours billed to
-- site' - with a calculation of what that actual dollar cost is ... that should
-- go into equipment repair category in the reporting. the rate per hour should
-- be settable by admin", "as a whole. not on a per site basis".
--
--
-- THE FOUR DECISIONS THIS FILE ENCODES, AND WHY.
--
-- 1. ITS OWN CATEGORY KEY THAT ROLLS UP, rather than writing straight into
--    repair_equipment. An hour of in-house mechanic time and a $400 pump are
--    both equipment repair to the P&L, but they are not the same thing to
--    anyone trying to work out where the money went. Keeping the key means the
--    entry rows stay honest and separable forever; rolling it up at READ time
--    means the grid the operators know keeps its thirteen columns and its
--    budgets keep meaning what they meant. Reversing the decision later is a
--    one-row UPDATE of `rolls_up_to`, not a data migration.
--
-- 2. THE ROLL-UP IS A COLUMN, NOT AN `IF key = 'maintenance_labor'`.
--    expense_categories.rolls_up_to is a self-reference. expense_month_rollup()
--    folds any child into its parent generically, so the second category that
--    needs this (and there will be one) is a row, not another edit to a
--    function that four other things read.
--
-- 3. THE RATE IS STAMPED ON THE ENTRY AT INSERT TIME, and the amount is
--    computed from the stamped copy. A rate change in November must not silently
--    restate August's expense log. The entry keeps the hours AND the rate it was
--    priced at, so the row can always explain its own dollar figure, and a CHECK
--    makes it impossible for the three to disagree.
--
-- 4. THE RATE TABLE IS ROW-PER-EFFECTIVE-DATE AND CARRIES A NULLABLE
--    mechanic_key FROM DAY ONE. Josh: "this is v1 - if this catches on, may set
--    by mechanic and have a rate for each mechanic. may be worth building the
--    table to account for that even if it's not currently utilized". So: NULL
--    mechanic_key IS the company-wide rate, which is the only kind v1 writes,
--    and per-mechanic rows already resolve correctly (see
--    expense_labor_rate_for) whenever the UI grows the field. No schema change
--    needed to turn it on — just start writing a non-null key.
--
--    There is deliberately no effective_to. A rate window is closed by the next
--    row's effective_from, which makes gaps and overlaps unrepresentable rather
--    than merely invalid. The cost is that "when did this stop" is a lookup
--    instead of a column; that is the right trade for a table an admin edits by
--    hand a few times a year.
--
--
-- WHO CAN SET THE RATE: super_admin only, enforced in performance-worker, not
-- here. Same as every other authorisation in this schema — the tables are RLS-
-- enabled with no policies and everything arrives over the service role. See
-- section 9 of expense-log-tables.sql.


-- ===========================================================================
-- 1. expense_categories.rolls_up_to — read-time consolidation, as data.
-- ===========================================================================
-- NULL means "I am my own column in the grid", which is every existing row.
-- Non-null means "my money is reported under that key instead, and I am not a
-- column at all".
--
-- Self-FK so a typo can't point at a category that doesn't exist. ON DELETE
-- RESTRICT matches the entry and budget FKs: deleting a parent that children
-- report into must fail loudly rather than orphan them into invisibility.
ALTER TABLE expense_categories
  ADD COLUMN IF NOT EXISTS rolls_up_to text
    REFERENCES expense_categories (key) ON UPDATE CASCADE ON DELETE RESTRICT;

-- One level only. A chain (a -> b -> c) would make the rollup's single join
-- silently drop c's money, and nothing about this feature needs depth. Enforced
-- rather than documented, because the failure mode is missing dollars.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'expense_categories_rollup_not_self'
       AND conrelid = 'expense_categories'::regclass
  ) THEN
    ALTER TABLE expense_categories
      ADD CONSTRAINT expense_categories_rollup_not_self
      CHECK (rolls_up_to IS NULL OR rolls_up_to <> key);
  END IF;
END
$$;

-- ===========================================================================
-- 2. expense_categories.billed_by_hours — which categories are priced, not typed.
-- ===========================================================================
-- The form asks for "hours billed to site" instead of a dollar amount, and
-- drops the payment-method field entirely, for any category flagged here. That
-- decision has to be data for the same reason the roll-up does: the worker, the
-- form and the insert function all need to agree on it, and three copies of
-- `key = 'maintenance_labor'` is three places to forget.
--
-- There is no payment method because there is no payment: this is internal
-- labor billed to the site, not a purchase anybody made.
ALTER TABLE expense_categories
  ADD COLUMN IF NOT EXISTS billed_by_hours boolean NOT NULL DEFAULT false;

-- ===========================================================================
-- 3. The category row itself.
-- ===========================================================================
-- sort_order 45 sits it immediately after repair_equipment (40) and before
-- repair_other (50) — where a reader would look for it — using the gap the
-- original seed left for exactly this. It is not a grid column (rolls_up_to is
-- set), but the ordering still governs where it appears in the entry form's
-- category picker.
--
-- group_label 'Repairs' matches its parent so the picker groups them together.
INSERT INTO expense_categories
  (key, group_label, label, sort_order, rolls_up_to, billed_by_hours)
VALUES
  ('maintenance_labor', 'Repairs', 'Maintenance Labor', 45, 'repair_equipment', true)
ON CONFLICT (key) DO UPDATE
  SET group_label     = EXCLUDED.group_label,
      label           = EXCLUDED.label,
      sort_order      = EXCLUDED.sort_order,
      rolls_up_to     = EXCLUDED.rolls_up_to,
      billed_by_hours = EXCLUDED.billed_by_hours;


-- ===========================================================================
-- 4. expense_labor_rate — the admin-set hourly rate, versioned by date.
-- ===========================================================================
-- Company-wide in v1: every row has mechanic_key NULL. See decision 4 in the
-- header for why the column exists anyway.
--
-- No updated_at/updated_by. A rate is not edited, it is superseded — correcting
-- one in place would restate the price of work already logged against it, which
-- is precisely what stamping the rate onto the entry exists to prevent. Getting
-- it wrong means inserting a new row, and if the wrong one was already used,
-- fixing the affected entries deliberately.
CREATE TABLE IF NOT EXISTS expense_labor_rate (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- NULL = the company-wide rate. Non-null = that mechanic's rate, which wins
  -- over the company one for the same date. Unused in v1.
  mechanic_key      text,

  -- Inclusive. The window runs until the next row's effective_from — see the
  -- header note on why there is no effective_to.
  effective_from    date NOT NULL,

  rate_per_hour     numeric(10,2) NOT NULL,

  note              text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid NOT NULL,
  created_by_email  text NOT NULL,

  -- Strictly positive. Zero is not a rate, it is a mistake that would price a
  -- day of work at nothing and pass every other check silently.
  CONSTRAINT expense_labor_rate_positive
    CHECK (rate_per_hour > 0),
  CONSTRAINT expense_labor_rate_mechanic_shape
    CHECK (mechanic_key IS NULL OR btrim(mechanic_key) <> '')
);

-- One rate per mechanic per start date. Expression index rather than a plain
-- UNIQUE because NULLs compare distinct by default, which would let the
-- company-wide rate be inserted twice for the same day and make the lookup
-- below non-deterministic.
CREATE UNIQUE INDEX IF NOT EXISTS idx_expense_labor_rate_unique
  ON expense_labor_rate (COALESCE(mechanic_key, ''), effective_from);

-- The lookup's access path: newest row at or before a date.
CREATE INDEX IF NOT EXISTS idx_expense_labor_rate_effective
  ON expense_labor_rate (effective_from DESC);

ALTER TABLE expense_labor_rate ENABLE ROW LEVEL SECURITY;


-- ===========================================================================
-- 5. expense_labor_rate_for() — the rate in force on a date.
-- ===========================================================================
-- Resolution order, most specific first:
--   1. the mechanic's own newest row at or before the date
--   2. the company-wide (mechanic_key IS NULL) newest row at or before the date
--
-- The fallback is what makes the unused mechanic column free: with every row
-- company-wide, step 1 never matches and step 2 always does.
--
-- Returns NULL when no rate has ever been set for a date that early. The caller
-- must treat that as "refuse the entry", NOT as zero — pricing an hour of work
-- at nothing because an admin hasn't configured the rate yet would post a $0.00
-- expense that looks deliberate. insert_expense_entry() below raises instead.
CREATE OR REPLACE FUNCTION expense_labor_rate_for(
  p_business_date date,
  p_mechanic_key  text DEFAULT NULL
)
RETURNS numeric
LANGUAGE sql
STABLE
AS $$
  SELECT r.rate_per_hour
    FROM expense_labor_rate r
   WHERE r.effective_from <= p_business_date
     AND (
       r.mechanic_key IS NULL
       OR (p_mechanic_key IS NOT NULL AND r.mechanic_key = p_mechanic_key)
     )
   -- Mechanic-specific beats company-wide at the same date; within either,
   -- newest effective_from wins.
   ORDER BY (r.mechanic_key IS NOT NULL) DESC, r.effective_from DESC
   LIMIT 1;
$$;

REVOKE ALL ON FUNCTION expense_labor_rate_for(date, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION expense_labor_rate_for(date, text) TO service_role;


-- ===========================================================================
-- 6. expense_entry — hours, the stamped rate, and the mechanic.
-- ===========================================================================
-- amount stays the one column every read sums. An hourly entry is not a special
-- case downstream: it lands in the same numeric(12,2), rolls into the same
-- month total, nets against the same budget. These three columns exist so the
-- row can SHOW ITS WORK, not so anything has to branch on them.
ALTER TABLE expense_entry
  ADD COLUMN IF NOT EXISTS labor_hours  numeric(8,2);
ALTER TABLE expense_entry
  ADD COLUMN IF NOT EXISTS labor_rate   numeric(10,2);
-- Who did the work. Free text in v1 and not FK'd to anything — there is no
-- mechanic table yet, and inventing one to hold a name typed into a box would
-- be building the v2 Josh explicitly deferred. It is the column
-- expense_labor_rate.mechanic_key will match against when that day comes.
ALTER TABLE expense_entry
  ADD COLUMN IF NOT EXISTS mechanic_key text;

DO $$
BEGIN
  -- Hours and rate arrive together or not at all. A rate with no hours prices
  -- nothing; hours with no rate can't have produced the amount.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'expense_entry_labor_pair'
       AND conrelid = 'expense_entry'::regclass
  ) THEN
    ALTER TABLE expense_entry
      ADD CONSTRAINT expense_entry_labor_pair
      CHECK ((labor_hours IS NULL) = (labor_rate IS NULL));
  END IF;

  -- Zero hours is a no-op entry, not a record of anything. Negative hours would
  -- be a credit, which belongs in Refunds where the sign convention is
  -- documented.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'expense_entry_labor_hours_positive'
       AND conrelid = 'expense_entry'::regclass
  ) THEN
    ALTER TABLE expense_entry
      ADD CONSTRAINT expense_entry_labor_hours_positive
      CHECK (labor_hours IS NULL OR labor_hours > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'expense_entry_labor_rate_positive'
       AND conrelid = 'expense_entry'::regclass
  ) THEN
    ALTER TABLE expense_entry
      ADD CONSTRAINT expense_entry_labor_rate_positive
      CHECK (labor_rate IS NULL OR labor_rate > 0);
  END IF;

  -- THE ONE THAT MATTERS. An hourly row's amount must be exactly what its own
  -- hours and rate produce. Without this, an edit that touched the dollar
  -- figure and left the hours alone would leave a row that contradicts itself
  -- and a grid whose total nobody can reproduce from what's on screen.
  --
  -- round() to 2 because that is what numeric(12,2) stores anyway; making the
  -- rounding explicit means the constraint compares two values computed the
  -- same way rather than one rounded by assignment and one not.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'expense_entry_labor_amount_matches'
       AND conrelid = 'expense_entry'::regclass
  ) THEN
    ALTER TABLE expense_entry
      ADD CONSTRAINT expense_entry_labor_amount_matches
      CHECK (
        labor_hours IS NULL
        OR amount = round(labor_hours * labor_rate, 2)
      );
  END IF;
END
$$;


-- ===========================================================================
-- 7. insert_expense_entry() — now prices hourly categories itself.
-- ===========================================================================
-- DROPPED AND RECREATED, NOT `CREATE OR REPLACE`. Adding defaulted parameters
-- creates a SECOND overload rather than replacing the first, and every existing
-- 11-argument call then fails as ambiguous. The drop below is the whole reason
-- this section is not a two-line edit.
--
-- WHY THE PRICING HAPPENS HERE AND NOT IN THE WORKER: the client must never be
-- able to send the dollar amount for an hourly entry. If it could, the rate
-- would be advisory — a stale page, a replayed request or a hand-rolled curl
-- would price labor at whatever it liked. The worker sends HOURS; the database
-- looks up the rate, computes the amount, and stamps both onto the row inside
-- the same transaction that allocates the PO number.
--
-- p_amount is IGNORED for an hourly category, deliberately and silently. It is
-- ignored rather than rejected because the form has no dollar box to leave
-- blank on that path, so a null or a zero arriving there is normal traffic, not
-- an error worth failing a user's entry over.
DROP FUNCTION IF EXISTS insert_expense_entry(
  date, integer, integer, text, text, text, text, text, numeric, uuid, text
);

CREATE FUNCTION insert_expense_entry(
  p_business_date    date,
  p_location_id      integer,
  p_site_number      integer,
  p_location_code    text,
  p_initials         text,
  p_method           text,
  p_description      text,
  p_category_key     text,
  p_amount           numeric,
  p_created_by       uuid,
  p_created_by_email text,
  -- New, defaulted so nothing that doesn't do labor has to know they exist.
  p_labor_hours      numeric DEFAULT NULL,
  p_mechanic_key     text    DEFAULT NULL
)
RETURNS expense_entry
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
  v_seq      integer;
  v_po       text;
  v_row      expense_entry;
  v_hourly   boolean;
  v_mech     text := nullif(btrim(coalesce(p_mechanic_key, '')), '');
  v_rate     numeric;
  v_amount   numeric := p_amount;
  v_hours    numeric := NULL;
  v_method   text    := p_method;
BEGIN
  -- Is this category priced by the hour? Asked of the category table, not of
  -- the key, so adding a second hourly category needs no change here.
  SELECT c.billed_by_hours INTO v_hourly
    FROM expense_categories c
   WHERE c.key = p_category_key;

  IF v_hourly IS NULL THEN
    -- The FK on the insert would catch this a moment later with a less
    -- readable message; catching it now says which key was wrong.
    RAISE EXCEPTION 'unknown expense category %', coalesce(p_category_key, '(null)')
      USING ERRCODE = '23503';
  END IF;

  IF v_hourly THEN
    v_hours := p_labor_hours;

    IF v_hours IS NULL OR v_hours <= 0 THEN
      RAISE EXCEPTION 'category % is billed by the hour: hours billed must be greater than zero', p_category_key
        USING ERRCODE = '22023';
    END IF;

    v_rate := expense_labor_rate_for(p_business_date, v_mech);

    IF v_rate IS NULL THEN
      -- Deliberately not defaulted to anything. See expense_labor_rate_for().
      RAISE EXCEPTION 'no labor rate is in effect on % — an administrator must set one before hourly work can be logged', p_business_date
        USING ERRCODE = '22023';
    END IF;

    v_amount := round(v_hours * v_rate, 2);

    -- No payment method on an hourly entry: nothing was paid for. Nulled here
    -- rather than trusted to the form, so a stale page that still posts one
    -- can't leave "Amex" on a row nobody charged.
    v_method := NULL;

  ELSE
    IF p_labor_hours IS NOT NULL THEN
      RAISE EXCEPTION 'category % is not billed by the hour, so hours cannot be recorded against it', p_category_key
        USING ERRCODE = '22023';
    END IF;

    IF v_amount IS NULL THEN
      RAISE EXCEPTION 'an amount is required for category %', p_category_key
        USING ERRCODE = '22023';
    END IF;

    -- A mechanic on a purchase is meaningless and would make the column
    -- unreliable as "who did the work" the moment anything reads it.
    v_mech := NULL;
  END IF;

  SELECT n.po_seq, n.po_number
    INTO v_seq, v_po
    FROM next_expense_po(p_location_id, p_site_number, p_business_date, p_initials) n;

  INSERT INTO expense_entry (
    business_date, location_id, site_number, location_code,
    po_number, po_initials, po_seq,
    method, description, category_key, amount,
    labor_hours, labor_rate, mechanic_key,
    created_by, created_by_email
  ) VALUES (
    p_business_date, p_location_id, p_site_number, p_location_code,
    v_po, upper(btrim(p_initials)), v_seq,
    nullif(btrim(coalesce(v_method, '')), ''),
    nullif(btrim(coalesce(p_description, '')), ''),
    p_category_key, v_amount,
    v_hours, v_rate, v_mech,
    p_created_by, p_created_by_email
  )
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION insert_expense_entry(date, integer, integer, text, text, text, text, text, numeric, uuid, text, numeric, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION insert_expense_entry(date, integer, integer, text, text, text, text, text, numeric, uuid, text, numeric, text) TO service_role;


-- ===========================================================================
-- 8. expense_month_rollup() — fold children into their parent.
-- ===========================================================================
-- ITS SIGNATURE AND OUTPUT COLUMNS ARE UNCHANGED. Every caller — the worker,
-- the page's pivot, the types package — keeps working untouched, which is the
-- point: the fold happens entirely inside the function, so nothing downstream
-- has to learn what a child category is. Dropped first anyway, purely so a
-- re-run can never leave a stale definition behind next to the new one.
--
-- THREE CHANGES, all of them the same idea applied in three places:
--
--   * The grid's columns are now the categories with NO parent. A child is not
--     a column; it has no header, no budget cell and no variance of its own.
--   * Actuals group by COALESCE(rolls_up_to, key), so a maintenance-labor entry
--     is summed into repair_equipment's actual before anything divides or
--     compares.
--   * Budgets do the same. A budget should never be set against a child (the UI
--     won't offer one), but folding rather than ignoring means a row that
--     somehow exists still shows up in a total instead of vanishing.
--
-- `entry_count` consequently counts the parent's entries AND its children's,
-- which is correct but worth knowing: an Equipment Repair cell reading $1,800
-- over 4 entries may include labor rows that a filter on repair_equipment alone
-- will not return. The entry LIST is unfolded — it shows each row under its own
-- category — because "where did the money go" and "what did we buy" are
-- different questions and only the first one wants the fold.
--
-- Everything else — the three distinct NULLs, the variance sign convention, the
-- scope filters, the inactive-category rule — is unchanged from
-- expense-log-tables.sql section 6, and the reasoning there still applies.
DROP FUNCTION IF EXISTS expense_month_rollup(date, integer, integer, text[]);

CREATE FUNCTION expense_month_rollup(
  p_period_month   date,
  p_location_id    integer DEFAULT NULL,
  p_site_number    integer DEFAULT NULL,
  p_location_codes text[]  DEFAULT NULL
)
RETURNS TABLE (
  location_id    integer,
  site_number    integer,
  location_code  text,
  category_key   text,
  group_label    text,
  label          text,
  sort_order     integer,
  budget_amount  numeric,
  actual_amount  numeric,
  variance       numeric,
  entry_count    bigint
)
LANGUAGE sql
STABLE
AS $$
  WITH bounds AS (
    SELECT
      date_trunc('month', p_period_month)::date                        AS month_start,
      (date_trunc('month', p_period_month) + interval '1 month')::date AS month_end
  ),
  -- key -> the key its money is reported under. Identity for a normal category.
  reported AS (
    SELECT c.key, COALESCE(c.rolls_up_to, c.key) AS report_key
      FROM expense_categories c
  ),
  sites AS (
    SELECT DISTINCT location_id, site_number, location_code
    FROM (
      SELECT e.location_id, e.site_number, e.location_code
        FROM expense_entry e, bounds b
       WHERE e.voided_at IS NULL
         AND e.business_date >= b.month_start
         AND e.business_date <  b.month_end
      UNION ALL
      SELECT g.location_id, g.site_number, g.location_code
        FROM expense_budget g, bounds b
       WHERE g.period_month = b.month_start
    ) u
    WHERE (p_location_id    IS NULL OR u.location_id   =  p_location_id)
      AND (p_site_number    IS NULL OR u.site_number   =  p_site_number)
      AND (p_location_codes IS NULL OR u.location_code = ANY (p_location_codes))
  ),
  actuals AS (
    SELECT
      e.location_id,
      r.report_key       AS category_key,
      SUM(e.amount)      AS actual_amount,
      COUNT(*)::bigint   AS entry_count
    FROM expense_entry e
    JOIN reported r ON r.key = e.category_key
    CROSS JOIN bounds b
    WHERE e.voided_at IS NULL
      AND e.business_date >= b.month_start
      AND e.business_date <  b.month_end
    GROUP BY e.location_id, r.report_key
  ),
  budgets AS (
    SELECT
      g.location_id,
      r.report_key          AS category_key,
      SUM(g.budget_amount)  AS budget_amount
      FROM expense_budget g
      JOIN reported r ON r.key = g.category_key
      CROSS JOIN bounds b
     WHERE g.period_month = b.month_start
     GROUP BY g.location_id, r.report_key
  )
  SELECT
    s.location_id,
    s.site_number,
    s.location_code,
    c.key,
    c.group_label,
    c.label,
    c.sort_order,
    bg.budget_amount,
    COALESCE(a.actual_amount, 0)::numeric,
    CASE WHEN bg.budget_amount IS NOT NULL
      THEN bg.budget_amount - COALESCE(a.actual_amount, 0)
    END,
    COALESCE(a.entry_count, 0)::bigint
  FROM sites s
  -- Only parents are columns. A child's money is already inside its parent's
  -- row; giving it a column too would double it in any total across the grid.
  CROSS JOIN (SELECT * FROM expense_categories WHERE rolls_up_to IS NULL) c
  LEFT JOIN actuals a
    ON a.location_id  = s.location_id
   AND a.category_key = c.key
  LEFT JOIN budgets bg
    ON bg.location_id  = s.location_id
   AND bg.category_key = c.key
  WHERE c.active
     OR a.actual_amount IS NOT NULL
     OR bg.budget_amount IS NOT NULL
  ORDER BY s.location_code, c.sort_order;
$$;

REVOKE ALL ON FUNCTION expense_month_rollup(date, integer, integer, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION expense_month_rollup(date, integer, integer, text[]) TO service_role;


-- ===========================================================================
-- 9. Verify — fail loudly rather than half-apply.
-- ===========================================================================
-- Every check below is something a later section depends on. Running this file
-- against a database where one ALTER silently no-op'd would otherwise surface
-- as a runtime error in the worker days later.
DO $$
DECLARE
  v_rate numeric;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'expense_categories' AND column_name = 'rolls_up_to'
  ) THEN
    RAISE EXCEPTION 'expense_categories.rolls_up_to missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'expense_categories' AND column_name = 'billed_by_hours'
  ) THEN
    RAISE EXCEPTION 'expense_categories.billed_by_hours missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM expense_categories
     WHERE key = 'maintenance_labor'
       AND rolls_up_to = 'repair_equipment'
       AND billed_by_hours
  ) THEN
    RAISE EXCEPTION 'maintenance_labor category missing or not rolling into repair_equipment';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables WHERE table_name = 'expense_labor_rate'
  ) THEN
    RAISE EXCEPTION 'expense_labor_rate table missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'expense_entry' AND column_name = 'labor_hours'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'expense_entry' AND column_name = 'labor_rate'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'expense_entry' AND column_name = 'mechanic_key'
  ) THEN
    RAISE EXCEPTION 'expense_entry labor columns missing';
  END IF;

  -- Exactly one insert_expense_entry must exist. Two means the DROP above
  -- didn't match the deployed signature and every call is now ambiguous — the
  -- specific failure this file's section 7 exists to avoid.
  IF (SELECT count(*) FROM pg_proc WHERE proname = 'insert_expense_entry') <> 1 THEN
    RAISE EXCEPTION 'expected exactly one insert_expense_entry overload, found %',
      (SELECT count(*) FROM pg_proc WHERE proname = 'insert_expense_entry');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
     WHERE proname = 'insert_expense_entry'
       AND 'p_labor_hours' = ANY (proargnames)
  ) THEN
    RAISE EXCEPTION 'insert_expense_entry is missing p_labor_hours';
  END IF;

  -- The lookup must run and return nothing on a fresh install; the point is
  -- that it resolves at all, not what it returns.
  v_rate := expense_labor_rate_for(CURRENT_DATE, NULL);

  RAISE NOTICE 'maintenance labor migration OK. Current company labor rate: %',
    COALESCE(v_rate::text, '(none set — an admin must set one before hourly entries can be logged)');
END
$$;
