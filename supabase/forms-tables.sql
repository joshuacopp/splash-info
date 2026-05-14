-- Brief 89: form-builder foundation schema.
-- Operator runs this in Supabase SQL editor before queueing Brief 90.
-- All five tables are new; nothing in the existing schema is modified.

-- 1. forms — identity, slug, audience, status, draft/current pointers.
CREATE TABLE IF NOT EXISTS forms (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                text UNIQUE NOT NULL,
  title               text NOT NULL,
  description         text,
  audience            text NOT NULL CHECK (audience IN ('public', 'internal', 'link-only')),
  status              text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  current_version_id  uuid,                                                   -- FK added below (forward ref)
  draft_version_id    uuid,                                                   -- FK added below
  notify_webhook      boolean NOT NULL DEFAULT true,
  success_message     text,
  turnstile_required  boolean NOT NULL DEFAULT true,                          -- public default; internal/link-only sets false
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid NOT NULL,                                          -- auth.users.id (loosely — no FK to auth schema)
  last_edited_at      timestamptz NOT NULL DEFAULT now(),
  last_edited_by      uuid NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_forms_status ON forms (status);
CREATE INDEX IF NOT EXISTS idx_forms_slug ON forms (slug);

-- 2. form_versions — immutable schema snapshots; one row per (form, version_number).
CREATE TABLE IF NOT EXISTS form_versions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  form_id         uuid NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  version_number  int NOT NULL,                                               -- monotonic per form, starts at 1
  schema          jsonb NOT NULL,                                             -- the FieldBase[] array
  is_draft        boolean NOT NULL DEFAULT true,
  published_at    timestamptz,                                                -- NULL while is_draft = true
  published_by    uuid,                                                       -- NULL while is_draft = true
  UNIQUE (form_id, version_number)
);
CREATE INDEX IF NOT EXISTS idx_form_versions_form_id ON form_versions (form_id);

-- Forward-ref FKs from forms → form_versions (couldn't be inlined above due to circular ref).
ALTER TABLE forms
  ADD CONSTRAINT forms_current_version_fk FOREIGN KEY (current_version_id) REFERENCES form_versions(id) DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT forms_draft_version_fk   FOREIGN KEY (draft_version_id)   REFERENCES form_versions(id) DEFERRABLE INITIALLY DEFERRED;

-- 3. form_assets — in-form display images, uploaded once at form-build time.
--    R2 path convention: form-assets/{form_id}/{asset_id}.{ext}
CREATE TABLE IF NOT EXISTS form_assets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  form_id     uuid NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  r2_key      text UNIQUE NOT NULL,
  mime        text NOT NULL,
  size_bytes  bigint NOT NULL,
  width       int,                                                            -- pixel width (extracted at upload)
  height      int,                                                            -- pixel height
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  uploaded_by uuid NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_form_assets_form_id ON form_assets (form_id);

-- 4. form_submissions — one row per submission. FK to form_versions.id (NOT forms.id)
--    so past submissions always render under the schema they were submitted against.
CREATE TABLE IF NOT EXISTS form_submissions (
  id                       uuid PRIMARY KEY,                                  -- pending_submission_id from client (Brief 92)
  form_id                  uuid NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  form_version_id          uuid NOT NULL REFERENCES form_versions(id),
  payload                  jsonb NOT NULL,                                    -- keyed by field key per Decision 1
  submitter_kind           text NOT NULL CHECK (submitter_kind IN ('authenticated', 'anonymous')),
  submitter_user_id        uuid,                                              -- NULL when anonymous
  submitter_email          text,                                              -- NULL when anonymous; denormalized from session at submit time
  submitter_ip             text,                                              -- captured for both audiences; retention TBD
  submitted_at             timestamptz NOT NULL DEFAULT now(),
  status                   text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'in_progress', 'closed')),
  status_updated_at        timestamptz,
  status_updated_by        uuid,
  splash_notes             text,                                              -- mirrors fleet Brief 87
  splash_notes_updated_at  timestamptz,
  splash_notes_updated_by  uuid
);
CREATE INDEX IF NOT EXISTS idx_form_submissions_form_id ON form_submissions (form_id);
CREATE INDEX IF NOT EXISTS idx_form_submissions_version_id ON form_submissions (form_version_id);
CREATE INDEX IF NOT EXISTS idx_form_submissions_submitted_at ON form_submissions (submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_form_submissions_status ON form_submissions (status);

-- 5. form_submission_files — per-submission file uploads + signatures.
--    R2 path convention: form-submission-files/{form_id}/{submission_id}/{field_key}/{filename}
--    Source of truth for retention/cleanup queries.
CREATE TABLE IF NOT EXISTS form_submission_files (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id       uuid NOT NULL REFERENCES form_submissions(id) ON DELETE CASCADE,
  field_key           text NOT NULL,
  r2_key              text UNIQUE NOT NULL,
  mime                text NOT NULL,
  size_bytes          bigint NOT NULL,
  original_filename   text,
  uploaded_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_form_submission_files_submission_id ON form_submission_files (submission_id);

-- 6. outbound_emails — Brief 127. Shared queue of fully-rendered outbound
--    emails. Any worker holding `SUPABASE_SERVICE_KEY` can enqueue; the
--    splash-forms worker exposes the claim/confirm endpoints PA polls.
--
--    Idempotent enqueue: re-firing the same (source_worker, source_kind,
--    source_id, recipient) tuple is a no-op via the unique index +
--    PostgREST `Prefer: resolution=ignore-duplicates`.
--
--    The `claim_outbound_emails(claim_id, limit)` SQL function below
--    selects + locks pending rows with FOR UPDATE SKIP LOCKED, which
--    PostgREST doesn't expose directly. PA POSTs to
--    `/rest/v1/rpc/claim_outbound_emails` indirectly via the splash-forms
--    `POST /forms/internal/api/email-queue/claim` proxy endpoint, which
--    also inlines R2 attachments before returning the batch.
CREATE TABLE IF NOT EXISTS outbound_emails (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_worker   text NOT NULL,
  source_kind     text NOT NULL,
  source_id       text NOT NULL,
  recipient       text NOT NULL,
  cc              text[] NOT NULL DEFAULT ARRAY[]::text[],
  reply_to        text,
  subject         text NOT NULL,
  body_html       text,
  body_text       text,
  attachments     jsonb NOT NULL DEFAULT '[]'::jsonb,
  scheduled_for   timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  claimed_at      timestamptz,
  claim_id        uuid,
  sent_at         timestamptz,
  send_attempts   int NOT NULL DEFAULT 0,
  last_error      text
);

-- Idempotent enqueue: re-firing the same logical email is a no-op via
-- ON CONFLICT DO NOTHING.
CREATE UNIQUE INDEX IF NOT EXISTS outbound_emails_dedup_idx
  ON outbound_emails (source_worker, source_kind, source_id, recipient);

-- Partial index over the eligible-for-send pool. Pending rows whose
-- `scheduled_for` has passed AND aren't currently claimed (or claim is
-- stale > 10 min). `sent_at IS NULL` is the partial predicate; the
-- claim function adds the stale-claim and attempts filters inline.
CREATE INDEX IF NOT EXISTS outbound_emails_pending_idx
  ON outbound_emails (scheduled_for)
  WHERE sent_at IS NULL;

-- For the admin viewer (Brief 128) — narrow source filter.
CREATE INDEX IF NOT EXISTS outbound_emails_source_idx
  ON outbound_emails (source_worker, source_kind, created_at DESC);

-- claim_outbound_emails(p_claim_id, p_limit) — picks up to p_limit rows
-- eligible to send, stamps them with the caller-supplied claim_id, and
-- returns the row data needed by the sender. `FOR UPDATE SKIP LOCKED`
-- allows multiple PA runs to claim disjoint rows without blocking.
--
-- A claim becomes stale after 10 minutes (claimed but never confirmed —
-- PA flow died or had a network issue); the WHERE clause picks up
-- those rows on the next call so they get retried automatically.
-- `send_attempts >= 5` rows naturally drop out — no separate stuck
-- state at v1; the admin viewer surfaces them via the unfiltered list.
CREATE OR REPLACE FUNCTION claim_outbound_emails(
  p_claim_id uuid,
  p_limit    int
)
RETURNS TABLE (
  id            uuid,
  source_worker text,
  source_kind   text,
  source_id     text,
  recipient     text,
  cc            text[],
  reply_to      text,
  subject       text,
  body_html     text,
  body_text     text,
  attachments   jsonb,
  scheduled_for timestamptz,
  send_attempts int
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  UPDATE outbound_emails oe
  SET claimed_at = now(),
      claim_id   = p_claim_id
  FROM (
    SELECT inner_oe.id
    FROM outbound_emails inner_oe
    WHERE inner_oe.sent_at IS NULL
      AND inner_oe.scheduled_for <= now()
      AND inner_oe.send_attempts < 5
      AND (inner_oe.claimed_at IS NULL
           OR inner_oe.claimed_at < now() - interval '10 minutes')
    ORDER BY inner_oe.scheduled_for
    LIMIT GREATEST(1, LEAST(p_limit, 200))
    FOR UPDATE OF inner_oe SKIP LOCKED
  ) eligible
  WHERE oe.id = eligible.id
  RETURNING oe.id, oe.source_worker, oe.source_kind, oe.source_id,
            oe.recipient, oe.cc, oe.reply_to, oe.subject,
            oe.body_html, oe.body_text, oe.attachments,
            oe.scheduled_for, oe.send_attempts;
END;
$$;
