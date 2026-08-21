-- Expense log schema — the CPM workbook's "Expense Log" tab, per location, per
-- month.
--
-- Replaces the monthly spreadsheet tab whose shape was:
--
--     row 1  BUDGET                       one number per category column
--     row 2  MTD TOTAL                    =SUM(col)
--     row 3  AMOUNT UNDER (OVER) BUDGET   =BUDGET - MTD TOTAL
--     row 5  category GROUP               Chemicals | Repairs | Supplies | ...
--     row 6  category LABEL               Wash | Detail | Building | Equipment
--     row 7+ DATE | PO NUMBER | METHOD | DESCRIPTION | <one amount per column>
--
-- Operator runs this in the Supabase SQL editor before deploying the
-- performance-worker and apps/web briefs that touch `expense_entry`,
-- `expense_budget` or `expense_categories`.
--
-- Conventions follow greeter-scorecard-tables.sql, which this sits beside
-- behind the same "pertrack" grant: uuid PKs, `uuid NOT NULL` actor columns
-- with no FK into auth.users, timestamptz created_at, indexes co-located with
-- their table, and the three-column location key described below.
--
--
-- SHAPE DIVERGENCE FROM THE SPREADSHEET — read this before "simplifying".
--
-- The sheet is WIDE: one row per purchase with thirteen amount columns, twelve
-- of them blank. This schema is TALL: one row per purchase with a category key
-- and a single amount. The wide grid the operators know is reconstructed at
-- read time by expense_month_rollup() and by the page's pivot.
--
-- Tall, because the wide form makes three things impossible that this feature
-- is specifically for:
--   * Adding a category is a migration and a redeploy in the wide form. Here
--     it's a row in expense_categories.
--   * A per-category budget can't be constrained against a column name. Here
--     expense_budget FKs to the same key the entry does, so a budget for a
--     category that doesn't exist is rejected by the database.
--   * "What did we spend on equipment repairs across the region" is a GROUP BY
--     here and a thirteen-way UNION in the wide form.
--
-- A purchase that genuinely splits across categories is TWO ROWS sharing a PO
-- number. That is why po_number is NOT unique on its own — see the note on the
-- uniqueness key below.
--
--
-- LOCATION KEYING — identical to greeter_daily/location_daily, and deliberate.
-- Each row carries all three of location_id / site_number / location_code and
-- has NO foreign key to `locations`. The full reasoning is in the header of
-- greeter-scorecard-tables.sql; the short version is that `locations` has no
-- location_code column, `location_code` is denormalized purely so the caller-
-- scoping filter can restrict location admins to their own sites, and
-- site_number is the stable cross-app join key. The worker resolves all three
-- server-side from the picked location and HARD-REJECTS when location_code
-- can't be resolved, so a row can never land with a null scope value and leak
-- across sites.
--
--
-- MONEY IS numeric(12,2), NEVER float. Rounding drift in a column that is
-- summed into a variance against a budget is not acceptable, and Postgres
-- `numeric` sums exactly. Do not "optimise" these to double precision.
--
--
-- ============================================================================
-- PARTIALLY SUPERSEDED BY expense-maintenance-labor-01.sql (2026-08-21).
-- ============================================================================
-- This file is still the schema's origin and is safe to run on a fresh database
-- — but running it against a database that already has the labor migration will
-- ROLL TWO FUNCTIONS BACK, silently:
--
--   insert_expense_entry()   would lose its p_labor_hours / p_mechanic_key
--                            parameters, so every hourly entry starts failing
--                            with "function does not exist" AND the 11-arg form
--                            would be left as a second overload.
--   expense_month_rollup()   would lose the roll-up fold, so maintenance labor
--                            would reappear as its own grid column and stop
--                            being counted inside Equipment Repair.
--
-- Neither table DDL below is affected (all of it is IF NOT EXISTS / ON
-- CONFLICT), and the labor migration is itself idempotent — so the recovery, if
-- this file does get re-run, is simply to run expense-maintenance-labor-01.sql
-- again afterwards. Prefer not needing to.


-- ===========================================================================
-- 1. expense_categories — the grid's columns, as data.
-- ===========================================================================
-- The workbook's row 5 (group) and row 6 (label) become two columns here, so
-- the page can render the same two-tier header — "Chemicals" spanning Wash and
-- Detail — without hard-coding the spans.
--
-- TEXT PRIMARY KEY, not a serial. The key appears in the URL query string of
-- every filtered view and in the form field names, and a stable readable key
-- (`repair_equipment`) survives a re-seed where an integer id would silently
-- repoint every historical row. It is also what makes the seed below
-- idempotent.
--
-- `active` rather than DELETE: a category that stops being used still has years
-- of entries pointing at it. Deactivating drops it from the entry form and from
-- new budgets while leaving history readable. The FKs below are RESTRICT for
-- the same reason — deleting a category with entries must fail loudly.
CREATE TABLE IF NOT EXISTS expense_categories (
  key           text PRIMARY KEY,
  -- The workbook's merged row-5 heading. NULL for a standalone column that
  -- isn't part of a group (Refunds), which the page renders with no group cell.
  group_label   text,
  label         text    NOT NULL,
  -- Column order in the grid. Gapped by 10 so a category can be inserted
  -- between two others without renumbering the table.
  sort_order    integer NOT NULL,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT expense_categories_key_shape
    CHECK (key ~ '^[a-z][a-z0-9_]*$'),
  CONSTRAINT expense_categories_label_nonblank
    CHECK (btrim(label) <> '')
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_expense_categories_order
  ON expense_categories (sort_order);

-- Seed — the thirteen columns of the workbook's Expense Log tab, left to right
-- (columns E through Q). ON CONFLICT DO UPDATE so re-running this file
-- reconciles labels and ordering without duplicating or resetting `active`.
INSERT INTO expense_categories (key, group_label, label, sort_order) VALUES
  ('chem_wash',         'Chemicals', 'Wash',      10),
  ('chem_detail',       'Chemicals', 'Detail',    20),
  ('repair_building',   'Repairs',   'Building',  30),
  ('repair_equipment',  'Repairs',   'Equipment', 40),
  ('repair_other',      'Repairs',   'Other',     50),
  ('supply_building',   'Supplies',  'Building',  60),
  ('supply_equipment',  'Supplies',  'Equipment', 70),
  ('supply_office',     'Supplies',  'Office',    80),
  ('supply_other',      'Supplies',  'Other',     90),
  ('casual_labor',      'Casual',    'Labor',    100),
  ('manager_expense',   'Manager',   'Expense',  110),
  ('refunds',           NULL,        'Refunds',  120),
  ('snow_removal',      'Snow',      'Removal',  130)
ON CONFLICT (key) DO UPDATE
  SET group_label = EXCLUDED.group_label,
      label       = EXCLUDED.label,
      sort_order  = EXCLUDED.sort_order;


-- ===========================================================================
-- 2. expense_entry — one row per purchase per category.
-- ===========================================================================
--
-- PO NUMBER FORMAT (confirmed with Josh 2026-08-20):
--
--     {site_number}-{YYYYMMDD}{initials}{seq}
--     e.g.  196-20260820JC1
--
-- Assembled ENTIRELY SERVER-SIDE. The client sends the date, the location and
-- the submitter's initials; it never sends a PO number, and one supplied in the
-- request body is ignored. Two reasons that matter:
--   * `seq` is "which order of the day is this", which only the database can
--     answer without a race. See next_expense_po() below.
--   * site_number is resolved from location_id against the caller's scope, so a
--     hand-typed PO could otherwise claim another site's number.
--
-- po_number is stored REDUNDANTLY alongside its four parts. It is what appears
-- on the paper invoice and what somebody types into the search box, so it has
-- to be indexable and exactly-matchable as a single string; and keeping the
-- parts lets the sequence be computed without re-parsing text.
--
-- UNIQUENESS IS (location_id, business_date, po_seq), NOT po_number.
-- A purchase that splits across two categories is two rows sharing one PO — the
-- $400 invoice that was $250 of wash chemical and $150 of detail chemical is
-- two rows, both `196-20260820JC7`, so the paperwork still reconciles. Making
-- po_number unique would force that onto one line and lose the split, which is
-- the whole reason the table is tall. The sequence still can't collide, because
-- the seq is what's constrained.
--
-- SOFT DELETE (voided_at), never DELETE. This is a money log that reconciles
-- against invoices; a row that vanishes leaves a hole in the PO sequence with
-- nothing to explain it. Voiding keeps the number and the audit trail, and
-- every read below filters `voided_at IS NULL` by default.
CREATE TABLE IF NOT EXISTS expense_entry (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_date     date NOT NULL,

  -- Location keying — see the header note. All three resolved server-side.
  location_id       integer NOT NULL,
  site_number       integer NOT NULL,
  location_code     text    NOT NULL,

  -- PO, assembled server-side. See the note above.
  po_number         text    NOT NULL,
  -- The submitter's initials, uppercased on the way in. 1-4 letters: two is the
  -- norm, three covers a middle initial, four is the ceiling before this stops
  -- being initials.
  po_initials       text    NOT NULL,
  -- Nth order entered for this location on this date, starting at 1.
  po_seq            integer NOT NULL,

  -- How it was paid. Free text on purpose: the workbook's METHOD column has no
  -- fixed vocabulary, sites use their own words for the same card, and a CHECK
  -- here would reject a legitimate entry at 6pm with nobody around to migrate
  -- it. The form offers a datalist of the common values instead.
  method            text,
  description       text,

  category_key      text NOT NULL
    REFERENCES expense_categories (key) ON UPDATE CASCADE ON DELETE RESTRICT,

  -- Signed on purpose. Refunds and credit memos are negative, and the workbook
  -- has a Refunds column precisely so they net against the month. A CHECK for
  -- >= 0 would make a returned pump impossible to record.
  amount            numeric(12,2) NOT NULL,

  -- Soft delete. Both set together or neither — a void with no actor is
  -- unauditable, which defeats the point of not deleting.
  voided_at         timestamptz,
  voided_by         uuid,
  voided_by_email   text,
  void_reason       text,

  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid NOT NULL,                        -- auth.users.id
  created_by_email  text NOT NULL,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  updated_by        uuid,
  updated_by_email  text,

  CONSTRAINT expense_entry_po_seq_unique
    UNIQUE (location_id, business_date, po_seq),
  CONSTRAINT expense_entry_po_seq_positive
    CHECK (po_seq >= 1),
  CONSTRAINT expense_entry_initials_shape
    CHECK (po_initials ~ '^[A-Z]{1,4}$'),
  CONSTRAINT expense_entry_void_pair
    CHECK ((voided_at IS NULL) = (voided_by IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_expense_entry_date
  ON expense_entry (business_date DESC);
-- The scope filter's index. Partial on the live rows: every scoped read adds
-- `voided_at IS NULL`, and voids are a rounding error in the row count.
CREATE INDEX IF NOT EXISTS idx_expense_entry_scope
  ON expense_entry (location_code) WHERE voided_at IS NULL;
-- The month rollup's access path: one site, one month, grouped by category.
CREATE INDEX IF NOT EXISTS idx_expense_entry_site_date
  ON expense_entry (site_number, business_date DESC) WHERE voided_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_expense_entry_category
  ON expense_entry (category_key, business_date DESC) WHERE voided_at IS NULL;
-- PO lookup from a paper invoice. Not unique — see the note above.
CREATE INDEX IF NOT EXISTS idx_expense_entry_po
  ON expense_entry (po_number);
-- Description search on the filter bar (ILIKE '%needle%'). pg_trgm is already
-- created by greeter-scorecard-tables.sql; repeated here so this file stands
-- alone if it is ever run first.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_expense_entry_desc_trgm
  ON expense_entry USING gin (description gin_trgm_ops);


-- ===========================================================================
-- 3. expense_budget — the workbook's BUDGET row, per site per month.
-- ===========================================================================
-- One row per (location, month, category). The sheet's row 1 is thirteen cells;
-- here it is up to thirteen rows, and a category with no row simply has no
-- budget — which is NOT the same as a budget of zero, and the rollup keeps them
-- apart (NULL vs 0.00). A site that only budgets chemicals should show a dash
-- for the rest, not a fictional overspend on every other column.
--
-- period_month is the FIRST OF THE MONTH, enforced. Storing an arbitrary date
-- in the month would make (location, month, category) non-unique in practice
-- and every lookup a range scan.
CREATE TABLE IF NOT EXISTS expense_budget (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period_month      date NOT NULL,

  location_id       integer NOT NULL,
  site_number       integer NOT NULL,
  location_code     text    NOT NULL,

  category_key      text NOT NULL
    REFERENCES expense_categories (key) ON UPDATE CASCADE ON DELETE RESTRICT,

  budget_amount     numeric(12,2) NOT NULL,

  note              text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid NOT NULL,
  created_by_email  text NOT NULL,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  updated_by        uuid,
  updated_by_email  text,

  CONSTRAINT expense_budget_unique
    UNIQUE (location_id, period_month, category_key),
  CONSTRAINT expense_budget_month_first
    CHECK (period_month = date_trunc('month', period_month)::date),
  -- Unlike an entry amount, a budget cannot be negative: it is a ceiling, and a
  -- negative ceiling makes the variance arithmetic meaningless.
  CONSTRAINT expense_budget_nonneg
    CHECK (budget_amount >= 0)
);
CREATE INDEX IF NOT EXISTS idx_expense_budget_scope
  ON expense_budget (location_code, period_month);
CREATE INDEX IF NOT EXISTS idx_expense_budget_site_month
  ON expense_budget (site_number, period_month);


-- ===========================================================================
-- 4. next_expense_po() — the race-safe sequence allocator.
-- ===========================================================================
-- Returns the next (po_seq, po_number) for a site-day WITHOUT reading and then
-- writing in two statements.
--
-- WHY THIS IS A FUNCTION AND NOT `SELECT MAX(po_seq)+1` IN THE WORKER:
-- two greeters entering an order at the same second both read 6, both write 7,
-- and one insert dies on the unique constraint with an opaque 23505 the user
-- can do nothing about. Advisory-locking the (location, date) pair serialises
-- the allocation so the second caller reads 7. The lock is transaction-scoped
-- (pg_advisory_xact_lock) so it releases on commit or rollback with nothing to
-- clean up, and it is keyed on a hash of the site-day, so two different sites
-- entering orders simultaneously never wait on each other.
--
-- The lock does NOT replace the unique constraint. A row inserted by any path
-- that skips this function must still fail rather than duplicate a PO — the
-- constraint is the guarantee, the lock is what stops it from ever being hit.
--
-- Counts VOIDED rows too (no `voided_at IS NULL` filter). A voided PO has been
-- issued: the paperwork exists, and reissuing the number to a different
-- purchase is exactly the reconciliation problem soft-delete exists to avoid.
CREATE OR REPLACE FUNCTION next_expense_po(
  p_location_id   integer,
  p_site_number   integer,
  p_business_date date,
  p_initials      text
)
RETURNS TABLE (po_seq integer, po_number text)
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
  v_initials text := upper(btrim(coalesce(p_initials, '')));
  v_seq      integer;
BEGIN
  IF v_initials !~ '^[A-Z]{1,4}$' THEN
    RAISE EXCEPTION 'initials must be 1-4 letters, got %', coalesce(p_initials, '(null)')
      USING ERRCODE = '22023';
  END IF;

  -- Two-key form: hashtext of the site-day, split across the pair so different
  -- sites and different days occupy different lock slots.
  PERFORM pg_advisory_xact_lock(
    hashtext('expense_po:' || p_location_id::text),
    hashtext(p_business_date::text)
  );

  SELECT COALESCE(MAX(e.po_seq), 0) + 1
    INTO v_seq
    FROM expense_entry e
   WHERE e.location_id   = p_location_id
     AND e.business_date = p_business_date;

  RETURN QUERY SELECT
    v_seq,
    p_site_number::text
      || '-'
      || to_char(p_business_date, 'YYYYMMDD')
      || v_initials
      || v_seq::text;
END;
$$;

REVOKE ALL ON FUNCTION next_expense_po(integer, integer, date, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION next_expense_po(integer, integer, date, text) TO service_role;


-- ===========================================================================
-- 5. insert_expense_entry() — allocate the PO and write the row, atomically.
-- ===========================================================================
-- The worker calls THIS, not next_expense_po() followed by an insert. Splitting
-- the two across two round trips would end the transaction that holds the
-- advisory lock before the row lands, which puts the race straight back.
--
-- Returns the inserted row so the caller can echo the assigned PO number back
-- to the user — the whole point of server-side assignment is that the submitter
-- doesn't know the number until it's saved.
--
-- category_key is validated by the FK, amount by the column type. Neither is
-- re-checked here: a second copy of a rule the database already enforces is a
-- second place for it to drift.
CREATE OR REPLACE FUNCTION insert_expense_entry(
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
  p_created_by_email text
)
RETURNS expense_entry
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
  v_seq integer;
  v_po  text;
  v_row expense_entry;
BEGIN
  SELECT n.po_seq, n.po_number
    INTO v_seq, v_po
    FROM next_expense_po(p_location_id, p_site_number, p_business_date, p_initials) n;

  INSERT INTO expense_entry (
    business_date, location_id, site_number, location_code,
    po_number, po_initials, po_seq,
    method, description, category_key, amount,
    created_by, created_by_email
  ) VALUES (
    p_business_date, p_location_id, p_site_number, p_location_code,
    v_po, upper(btrim(p_initials)), v_seq,
    nullif(btrim(coalesce(p_method, '')), ''),
    nullif(btrim(coalesce(p_description, '')), ''),
    p_category_key, p_amount,
    p_created_by, p_created_by_email
  )
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION insert_expense_entry(date, integer, integer, text, text, text, text, text, numeric, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION insert_expense_entry(date, integer, integer, text, text, text, text, text, numeric, uuid, text) TO service_role;


-- ===========================================================================
-- 6. expense_month_rollup() — the workbook's three header rows.
-- ===========================================================================
-- One row per category per location for a month: the budget, what's been spent,
-- and the variance. This is rows 1-3 of the sheet, transposed.
--
-- A FUNCTION rather than a view, for the same reason greeter_rollup() is: a
-- view would have to aggregate before the month and scope filters could bind,
-- so every caller would silently get an all-time, all-sites total. The filters
-- are arguments and are applied to the base rows first.
--
-- DRIVEN FROM THE CATEGORY LIST, LEFT JOINED TO BOTH SIDES. Every active
-- category comes back for every location in scope, even with no budget and no
-- spend, because the grid has a column for it either way and a missing row
-- would shift the whole header. Inactive categories appear only where they
-- still carry a budget or an entry — dropping them outright would make a
-- historical month's total disagree with the sum of its own columns.
--
-- THE THREE NULLS ARE DISTINCT AND MUST STAY THAT WAY:
--   budget_amount NULL   no budget was ever set. Not a budget of zero.
--   actual_amount 0.00   never NULL — "no purchases" is a known zero, and the
--                        MTD row on the sheet reads 0 for an untouched column.
--   variance      NULL   follows budget_amount: with no ceiling there is
--                        nothing to be under or over, and rendering -spend
--                        would flag every unbudgeted category as an overrun.
--
-- Variance is BUDGET MINUS ACTUAL, matching the sheet's `=+E1-E2`: positive is
-- under budget, negative is over. The column is named `variance` rather than
-- `under_over` so the sign convention has to be read, not assumed.
--
-- p_period_month is normalised to the first of its month here, so a caller
-- passing any day in August gets August.
CREATE OR REPLACE FUNCTION expense_month_rollup(
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
      date_trunc('month', p_period_month)::date                     AS month_start,
      (date_trunc('month', p_period_month) + interval '1 month')::date AS month_end
  ),
  -- Every location that has EITHER a budget or an entry this month, in scope.
  -- Deliberately not `locations`: a site with nothing to show this month has no
  -- expense log to render, and listing all 40 would bury the ones in use.
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
      e.category_key,
      SUM(e.amount)  AS actual_amount,
      COUNT(*)::bigint AS entry_count
    FROM expense_entry e, bounds b
    WHERE e.voided_at IS NULL
      AND e.business_date >= b.month_start
      AND e.business_date <  b.month_end
    GROUP BY e.location_id, e.category_key
  ),
  budgets AS (
    SELECT g.location_id, g.category_key, g.budget_amount
      FROM expense_budget g, bounds b
     WHERE g.period_month = b.month_start
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
  CROSS JOIN expense_categories c
  LEFT JOIN actuals a
    ON a.location_id  = s.location_id
   AND a.category_key = c.key
  LEFT JOIN budgets bg
    ON bg.location_id  = s.location_id
   AND bg.category_key = c.key
  -- Inactive categories survive only where they still carry money — see above.
  WHERE c.active
     OR a.actual_amount IS NOT NULL
     OR bg.budget_amount IS NOT NULL
  ORDER BY s.location_code, c.sort_order;
$$;

REVOKE ALL ON FUNCTION expense_month_rollup(date, integer, integer, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION expense_month_rollup(date, integer, integer, text[]) TO service_role;


-- ===========================================================================
-- 7. copy_expense_budget_month() — carry a month's budget forward.
-- ===========================================================================
-- Sites set a budget once and adjust it; retyping thirteen numbers every month
-- is how a budget row quietly stops being maintained.
--
-- DOES NOT OVERWRITE. ON CONFLICT DO NOTHING means a category already budgeted
-- in the target month keeps its own number — the operator's later edit always
-- wins over the copy, whichever order the two happen in. Re-running is
-- therefore safe and idempotent, and the return value says how many were
-- actually created so the UI can report "9 copied, 4 already set" rather than
-- claiming success over a no-op.
CREATE OR REPLACE FUNCTION copy_expense_budget_month(
  p_location_id      integer,
  p_from_month       date,
  p_to_month         date,
  p_created_by       uuid,
  p_created_by_email text
)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
  v_from    date := date_trunc('month', p_from_month)::date;
  v_to      date := date_trunc('month', p_to_month)::date;
  v_copied  integer;
BEGIN
  IF v_from = v_to THEN
    RAISE EXCEPTION 'source and target month are the same (%)', v_to
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO expense_budget (
    period_month, location_id, site_number, location_code,
    category_key, budget_amount, note, created_by, created_by_email
  )
  SELECT
    v_to, g.location_id, g.site_number, g.location_code,
    g.category_key, g.budget_amount,
    'Copied from ' || to_char(v_from, 'Mon YYYY'),
    p_created_by, p_created_by_email
  FROM expense_budget g
  WHERE g.location_id  = p_location_id
    AND g.period_month = v_from
  ON CONFLICT (location_id, period_month, category_key) DO NOTHING;

  GET DIAGNOSTICS v_copied = ROW_COUNT;
  RETURN v_copied;
END;
$$;

REVOKE ALL ON FUNCTION copy_expense_budget_month(integer, date, date, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION copy_expense_budget_month(integer, date, date, uuid, text) TO service_role;


-- ===========================================================================
-- 8. updated_at triggers.
-- ===========================================================================
-- Both tables carry updated_at and both are edited in place (an entry can be
-- corrected, a budget re-typed), so the column has to move without every write
-- path remembering to set it.
CREATE OR REPLACE FUNCTION touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_expense_entry_touch ON expense_entry;
CREATE TRIGGER trg_expense_entry_touch
  BEFORE UPDATE ON expense_entry
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

DROP TRIGGER IF EXISTS trg_expense_budget_touch ON expense_budget;
CREATE TRIGGER trg_expense_budget_touch
  BEFORE UPDATE ON expense_budget
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();


-- ===========================================================================
-- 9. RLS.
-- ===========================================================================
-- Enabled with NO policies, matching greeter_daily. Every read and write comes
-- from performance-worker over the service role, which bypasses RLS; the actual
-- authorisation is the "pertrack" grant plus the location scope applied in the
-- worker. Enabling it here means a future anon/authenticated client can't reach
-- these tables by accident.
ALTER TABLE expense_entry      ENABLE ROW LEVEL SECURITY;
ALTER TABLE expense_budget     ENABLE ROW LEVEL SECURITY;
ALTER TABLE expense_categories ENABLE ROW LEVEL SECURITY;
