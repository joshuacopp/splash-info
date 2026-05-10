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
