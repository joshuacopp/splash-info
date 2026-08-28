-- Editing a posted expense entry, including its date, its site and its initials
-- — which means re-issuing the PO number.
--
-- Run in the Supabase SQL editor AFTER expense-log-tables.sql and
-- expense-maintenance-labor-01.sql, and BEFORE deploying the performance-worker
-- and apps/web changes that go with it. Idempotent and re-runnable; the DO block
-- at the bottom fails loudly if any piece did not land.
--
-- Josh, 2026-08-28: asked for an edit function on the expense log, and when
-- offered the choice between locking the three PO-bearing fields or allowing
-- everything and re-minting the number, chose the latter knowing the paper
-- invoice stops matching.
--
--
-- WHY THIS IS A DATABASE FUNCTION AND NOT AN UPDATE IN THE WORKER.
--
-- Because the edit can move a row to a different site or a different day, and
-- the PO sequence is per (location, date). Landing in a new site-day means
-- ALLOCATING a sequence number there, and allocation is the one thing this
-- schema has always refused to do in two round trips: next_expense_po() takes a
-- transaction-scoped advisory lock precisely so two writers can't both read 6
-- and both write 7. A worker that called next_expense_po() and then issued an
-- UPDATE would drop that lock in between and reintroduce the race the function
-- exists to prevent — with the unique constraint catching it as an opaque 23505
-- the user can do nothing about. Same reasoning as insert_expense_entry(); this
-- is its mirror image, not a new idea.
--
--
-- THE FOUR DECISIONS THIS FILE ENCODES, AND WHY.
--
-- 1. THE PO IS RE-MINTED ONLY WHEN THE SEQUENCE NAMESPACE MOVES.
--    Uniqueness is (location_id, business_date, po_seq). Changing the INITIALS
--    changes the printed string but not the namespace, so the row keeps its
--    po_seq and only the text is rebuilt. Burning a fresh sequence number for a
--    corrected typo in someone's initials would leave a hole in the day's
--    sequence for no reason at all.
--
-- 2. MOVING A ROW LEAVES A GAP, AND THAT IS ACCEPTED, NOT FIXED.
--    next_expense_po() is MAX(po_seq)+1 and deliberately counts voided rows too,
--    so a row that leaves 2026-08-20 does not free seq 7 for the next entry —
--    the day just reads 1,2,3,4,5,6,8. Renumbering the survivors would rewrite
--    PO numbers already printed on other invoices, which is far worse than a
--    gap. A gap is a question someone can ask; a silently changed PO on paper is
--    a reconciliation nobody can complete.
--
--    KNOWN CONSEQUENCE, ACCEPTED BY JOSH: the PO on the original paper invoice
--    no longer resolves. Searching 196-20260820JC7 after that entry moved to the
--    21st returns nothing. If that turns out to hurt, the fix is a nullable
--    superseded_po column plus an OR in the search — deliberately not built now.
--
-- 3. THE LABOR RATE IS RE-RESOLVED FROM THE (POSSIBLY NEW) BUSINESS DATE,
--    not carried over from the row. Decision 3 of expense-maintenance-labor-01
--    stamps the rate in force on the entry's date so the row can explain its own
--    dollar figure. Once the DATE is editable that has to be re-derived: a row
--    dated the 21st carrying the rate that was in force on the 20th cannot
--    explain itself, and its amount would fail the very CHECK that decision
--    added. So this function calls expense_labor_rate_for(new date) exactly as
--    the insert does. Editing an entry whose date predates every configured rate
--    is refused rather than priced at zero, same as insert.
--
-- 4. VOIDED ROWS ARE NOT EDITABLE. A void is a statement that the entry should
--    not count; quietly editing one would resurrect it as something else while
--    leaving the void audit trail attached to a row it no longer describes.
--    Restore it first, then edit it. This mirrors the greeter day rule, where a
--    voided row shows no Edit link for the same reason.


-- ===========================================================================
-- 1. expense_po_text() — the one place the PO string is spelled.
-- ===========================================================================
-- Extracted because there are now TWO callers that must produce byte-identical
-- output: next_expense_po() when allocating, and update_expense_entry() when it
-- rebuilds the string after an initials-only change without re-allocating. Two
-- copies of a format that appears on paper is exactly the kind of thing that
-- drifts by one character and is not noticed for a month.
--
-- STABLE, NOT IMMUTABLE, AND DO NOT INDEX IT. to_char(date, text) depends on
-- the session's DateStyle and lc_time, which makes this function's output a
-- function of more than its arguments. Declaring it IMMUTABLE would be accepted
-- by Postgres and would work — right up until someone builds an index on it,
-- which would then be silently wrong for any session with different settings.
-- Both callers invoke it inside a single statement, where STABLE costs nothing.
CREATE OR REPLACE FUNCTION expense_po_text(
  p_site_number   integer,
  p_business_date date,
  p_initials      text,
  p_po_seq        integer
)
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT p_site_number::text
      || '-'
      || to_char(p_business_date, 'YYYYMMDD')
      || upper(btrim(coalesce(p_initials, '')))
      || p_po_seq::text;
$$;

REVOKE ALL ON FUNCTION expense_po_text(integer, date, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION expense_po_text(integer, date, text, integer) TO service_role;


-- ===========================================================================
-- 2. next_expense_po() — unchanged behaviour, now built on the helper.
-- ===========================================================================
-- CREATE OR REPLACE with the identical signature, so nothing that calls it has
-- to change and re-running expense-log-tables.sql afterwards would simply put
-- the inline version back with the same output. The only edit is the last
-- expression: the concatenation moved into expense_po_text().
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

  PERFORM pg_advisory_xact_lock(
    hashtext('expense_po:' || p_location_id::text),
    hashtext(p_business_date::text)
  );

  -- Counts voided rows too. See decision 2 in the header, and the original note
  -- in expense-log-tables.sql: a voided PO has been issued.
  SELECT COALESCE(MAX(e.po_seq), 0) + 1
    INTO v_seq
    FROM expense_entry e
   WHERE e.location_id   = p_location_id
     AND e.business_date = p_business_date;

  RETURN QUERY SELECT
    v_seq,
    expense_po_text(p_site_number, p_business_date, v_initials, v_seq);
END;
$$;

REVOKE ALL ON FUNCTION next_expense_po(integer, integer, date, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION next_expense_po(integer, integer, date, text) TO service_role;


-- ===========================================================================
-- 3. update_expense_entry() — the mirror of insert_expense_entry().
-- ===========================================================================
-- Takes the SAME payload the insert takes, plus the row id and the editor, and
-- returns the updated row. The pricing block below is deliberately a
-- line-for-line copy of the insert's rather than a shared helper: the two differ
-- in what they do with the OLD values, and factoring them together would need a
-- function that takes a flag and branches, which is harder to read than the
-- duplication and much easier to break for both paths at once.
--
-- p_amount is IGNORED for an hourly category, exactly as on insert, and for the
-- same reason: the client must never be able to price labor.
--
-- ERROR CODES, and what the worker does with them:
--   P0002  the id matched nothing live          -> 404
--   22023  invalid value / voided / no rate     -> 400 or 409, by message
--   23503  unknown category                     -> 400
--   23505  po_seq collision                     -> 409
-- These are the codes translatePgError() in performance-worker already knows,
-- which is why they were chosen over inventing new ones.
CREATE OR REPLACE FUNCTION update_expense_entry(
  p_id               uuid,
  p_business_date    date,
  p_location_id      integer,
  p_site_number      integer,
  p_location_code    text,
  p_initials         text,
  p_method           text,
  p_description      text,
  p_category_key     text,
  p_amount           numeric,
  p_updated_by       uuid,
  p_updated_by_email text,
  p_labor_hours      numeric DEFAULT NULL,
  p_mechanic_key     text    DEFAULT NULL
)
RETURNS expense_entry
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
  v_old      expense_entry;
  v_row      expense_entry;
  v_hourly   boolean;
  v_initials text    := upper(btrim(coalesce(p_initials, '')));
  v_mech     text    := nullif(btrim(coalesce(p_mechanic_key, '')), '');
  v_rate     numeric;
  v_amount   numeric := p_amount;
  v_hours    numeric := NULL;
  v_method   text    := p_method;
  v_seq      integer;
  v_po       text;
BEGIN
  IF v_initials !~ '^[A-Z]{1,4}$' THEN
    RAISE EXCEPTION 'initials must be 1-4 letters, got %', coalesce(p_initials, '(null)')
      USING ERRCODE = '22023';
  END IF;

  -- FOR UPDATE, not a plain SELECT. Between reading the old row and writing the
  -- new one this function decides whether to re-mint the PO based on what the
  -- old location and date were; a concurrent edit landing in that window would
  -- make that decision against values that no longer exist.
  SELECT * INTO v_old
    FROM expense_entry
   WHERE id = p_id
   FOR UPDATE;

  IF v_old.id IS NULL THEN
    RAISE EXCEPTION 'expense entry % not found', p_id
      USING ERRCODE = 'P0002';
  END IF;

  -- See decision 4. Checked here and not only in the worker so no other caller
  -- can route around it.
  IF v_old.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'this entry is voided — restore it before editing it'
      USING ERRCODE = '22023';
  END IF;

  SELECT c.billed_by_hours INTO v_hourly
    FROM expense_categories c
   WHERE c.key = p_category_key;

  IF v_hourly IS NULL THEN
    RAISE EXCEPTION 'unknown expense category %', coalesce(p_category_key, '(null)')
      USING ERRCODE = '23503';
  END IF;

  IF v_hourly THEN
    -- ROUNDED TO THE COLUMN'S OWN PRECISION FIRST. expense_entry.labor_hours is
    -- numeric(8,2), so 2.125 would be STORED as 2.13 while v_amount below was
    -- computed from 2.125 — and expense_entry_labor_amount_matches, which
    -- compares the stored triple, would then reject the row with 23514. Rounding
    -- here makes the stored hours and the priced hours the same number by
    -- construction. (insert_expense_entry() has the same latent bug; the worker
    -- now rounds before calling either, so this is belt and braces.)
    v_hours := round(p_labor_hours, 2);

    IF v_hours IS NULL OR v_hours <= 0 THEN
      RAISE EXCEPTION 'category % is billed by the hour: hours billed must be greater than zero', p_category_key
        USING ERRCODE = '22023';
    END IF;

    -- Resolved from the NEW date, not carried over from v_old. See decision 3.
    v_rate := expense_labor_rate_for(p_business_date, v_mech);

    IF v_rate IS NULL THEN
      RAISE EXCEPTION 'no labor rate is in effect on % — an administrator must set one before hourly work can be logged', p_business_date
        USING ERRCODE = '22023';
    END IF;

    v_amount := round(v_hours * v_rate, 2);
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

    v_mech := NULL;
  END IF;

  -- THE PO DECISION. See decision 1.
  --
  -- IS DISTINCT FROM rather than <>, because a NULL on either side of a plain
  -- <> yields NULL, which reads as false, which would silently skip the
  -- re-issue. location_id and business_date are NOT NULL on the table, but
  -- p_location_id and p_business_date are function arguments and nothing stops a
  -- future caller passing one null.
  IF p_location_id   IS DISTINCT FROM v_old.location_id
     OR p_business_date IS DISTINCT FROM v_old.business_date THEN
    -- New site-day: allocate there, under the same advisory lock the insert
    -- takes, inside this transaction.
    SELECT n.po_seq, n.po_number
      INTO v_seq, v_po
      FROM next_expense_po(p_location_id, p_site_number, p_business_date, v_initials) n;
  ELSE
    -- Same site-day. Keep the sequence; rebuild the string in case the initials
    -- changed. p_site_number is used rather than v_old.site_number so a
    -- re-pointed location_id -> site_number mapping corrects itself here; the
    -- two are the same value whenever the location has not moved.
    v_seq := v_old.po_seq;
    v_po  := expense_po_text(p_site_number, p_business_date, v_initials, v_seq);
  END IF;

  UPDATE expense_entry SET
    business_date    = p_business_date,
    location_id      = p_location_id,
    site_number      = p_site_number,
    location_code    = p_location_code,
    po_number        = v_po,
    po_initials      = v_initials,
    po_seq           = v_seq,
    method           = nullif(btrim(coalesce(v_method, '')), ''),
    description      = nullif(btrim(coalesce(p_description, '')), ''),
    category_key     = p_category_key,
    amount           = v_amount,
    labor_hours      = v_hours,
    labor_rate       = v_rate,
    mechanic_key     = v_mech,
    updated_at       = now(),
    updated_by       = p_updated_by,
    updated_by_email = p_updated_by_email
  WHERE id = p_id
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION update_expense_entry(uuid, date, integer, integer, text, text, text, text, text, numeric, uuid, text, numeric, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION update_expense_entry(uuid, date, integer, integer, text, text, text, text, text, numeric, uuid, text, numeric, text) TO service_role;


-- ===========================================================================
-- 4. Landing check.
-- ===========================================================================
-- Fails loudly rather than leaving a half-applied migration to be discovered by
-- a 500 in production.
-- EVERY COUNT IS SCOPED TO `public`. An unqualified pg_proc scan also sees
-- extensions and any other schema, so a same-named function anywhere in the
-- database would make these assertions pass or fail for a reason that has
-- nothing to do with whether this migration landed.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE p.proname = 'expense_po_text' AND n.nspname = 'public'
  ) THEN
    RAISE EXCEPTION 'expense_po_text() did not land';
  END IF;

  -- Exactly one overload. A second would make every call ambiguous, which is
  -- the failure mode that forced the DROP in expense-maintenance-labor-01.
  IF (
    SELECT count(*) FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE p.proname = 'update_expense_entry' AND n.nspname = 'public'
  ) <> 1 THEN
    RAISE EXCEPTION 'expected exactly one public.update_expense_entry overload, found %',
      (SELECT count(*) FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE p.proname = 'update_expense_entry' AND n.nspname = 'public');
  END IF;

  IF (
    SELECT count(*) FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE p.proname = 'next_expense_po' AND n.nspname = 'public'
  ) <> 1 THEN
    RAISE EXCEPTION 'expected exactly one public.next_expense_po overload, found %',
      (SELECT count(*) FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE p.proname = 'next_expense_po' AND n.nspname = 'public');
  END IF;

  -- The helper and the allocator must agree, or a PO rebuilt after an
  -- initials-only edit would not match one that was allocated. Site 196, the
  -- 20th of August, initials JC, seq 7 -> 196-20260820JC7.
  IF expense_po_text(196, DATE '2026-08-20', 'jc', 7) <> '196-20260820JC7' THEN
    RAISE EXCEPTION 'expense_po_text() produced %, expected 196-20260820JC7',
      expense_po_text(196, DATE '2026-08-20', 'jc', 7);
  END IF;
END
$$;
