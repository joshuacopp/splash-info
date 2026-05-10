-- Brief 90: test forms for the public render path.
--
-- Three forms, one per audience (public / internal / link-only) with a
-- representative subset of field types. Operator runs this in Supabase
-- SQL editor AFTER `forms-tables.sql` (Brief 89) and BEFORE Brief 90's
-- smoke tests so the executor has something to verify against.
--
-- Idempotency: re-running this file fails on the slug UNIQUE constraint.
-- To re-create the test forms, the operator first deletes them:
--
--   DELETE FROM forms WHERE slug IN ('test-public', 'test-internal',
--                                    'test-link-only-x4kp9q2m7nf3');
--
-- ON DELETE CASCADE on form_versions / form_submissions covers the
-- dependent rows. The zero-uuid `created_by` / `last_edited_by` /
-- `published_by` references are intentional placeholders — these test
-- forms aren't owned by a real auth.users row.

-- =============================================================================
-- Test form 1: public (Turnstile-gated, anonymous submitter)
-- =============================================================================
WITH form_row AS (
  INSERT INTO forms (
    slug, title, description, audience, status,
    notify_webhook, success_message, turnstile_required,
    created_by, last_edited_by
  )
  VALUES (
    'test-public',
    'Public Test Form',
    'Brief 90 verification — public audience.',
    'public', 'published',
    false, 'Thanks for testing!', true,
    '00000000-0000-0000-0000-000000000000',
    '00000000-0000-0000-0000-000000000000'
  )
  RETURNING id
),
version_row AS (
  INSERT INTO form_versions (form_id, version_number, schema, is_draft, published_at, published_by)
  SELECT id, 1, '{
    "fields": [
      { "id": "f1", "type": "heading", "key": "h1", "label": "Header", "required": false, "level": "h2", "text": "Tell us about your interest" },
      { "id": "f2", "type": "name", "key": "full_name", "label": "Full name", "required": true },
      { "id": "f3", "type": "email", "key": "email", "label": "Email", "required": true },
      { "id": "f4", "type": "phone", "key": "phone", "label": "Phone (10 digits)", "required": true },
      { "id": "f5", "type": "location", "key": "site", "label": "Which location?", "required": true, "displayFormat": "name" },
      { "id": "f6", "type": "long_text", "key": "comments", "label": "Comments", "required": false, "rows": 4 }
    ]
  }'::jsonb, false, now(), '00000000-0000-0000-0000-000000000000'
  FROM form_row
  RETURNING form_id, id
)
UPDATE forms
SET current_version_id = version_row.id
FROM version_row
WHERE forms.id = version_row.form_id;

-- =============================================================================
-- Test form 2: internal (cookie-gated)
--   Includes a Lookup field — Brief 90 renders it disabled; Brief 93 wires
--   resolution.
-- =============================================================================
WITH form_row AS (
  INSERT INTO forms (
    slug, title, description, audience, status,
    notify_webhook, success_message, turnstile_required,
    created_by, last_edited_by
  )
  VALUES (
    'test-internal',
    'Internal Test Form',
    'Brief 90 verification — internal audience.',
    'internal', 'published',
    false, 'Submitted.', false,
    '00000000-0000-0000-0000-000000000000',
    '00000000-0000-0000-0000-000000000000'
  )
  RETURNING id
),
version_row AS (
  INSERT INTO form_versions (form_id, version_number, schema, is_draft, published_at, published_by)
  SELECT id, 1, '{
    "fields": [
      { "id": "f1", "type": "short_text", "key": "site_number", "label": "Site number (3 digits)", "required": true, "maxLength": 4 },
      { "id": "f2", "type": "lookup", "key": "location_name", "label": "Location", "required": false, "keyFieldId": "f1", "keyColumn": "pricing_simple.site", "sourceTable": "pricing_simple", "sourceColumn": "location_pretty", "resolutionMode": "prefill_visible", "nullBehavior": "allow_empty" },
      { "id": "f3", "type": "lookup", "key": "rd_email", "label": "Regional Director email", "required": false, "keyFieldId": "f1", "keyColumn": "pricing_simple.site", "sourceTable": "pricing_simple", "sourceColumn": "am_email", "resolutionMode": "prefill_hidden", "nullBehavior": "allow_empty" },
      { "id": "f4", "type": "long_text", "key": "issue", "label": "Issue description", "required": true, "rows": 5 }
    ]
  }'::jsonb, false, now(), '00000000-0000-0000-0000-000000000000'
  FROM form_row
  RETURNING form_id, id
)
UPDATE forms
SET current_version_id = version_row.id
FROM version_row
WHERE forms.id = version_row.form_id;

-- =============================================================================
-- Test form 3: link-only (slug-as-secret, no Turnstile, no auth)
-- =============================================================================
WITH form_row AS (
  INSERT INTO forms (
    slug, title, description, audience, status,
    notify_webhook, success_message, turnstile_required,
    created_by, last_edited_by
  )
  VALUES (
    'test-link-only-x4kp9q2m7nf3',
    'Link-Only Test Form',
    'Brief 90 verification — link-only audience.',
    'link-only', 'published',
    false, 'Submitted.', false,
    '00000000-0000-0000-0000-000000000000',
    '00000000-0000-0000-0000-000000000000'
  )
  RETURNING id
),
version_row AS (
  INSERT INTO form_versions (form_id, version_number, schema, is_draft, published_at, published_by)
  SELECT id, 1, '{
    "fields": [
      { "id": "f1", "type": "heading", "key": "h1", "label": "Header", "required": false, "level": "h2", "text": "Quick survey" },
      { "id": "f2", "type": "dropdown", "key": "satisfaction", "label": "How satisfied are you?", "required": true, "options": [{"value":"5","label":"Very satisfied"},{"value":"3","label":"Neutral"},{"value":"1","label":"Very unsatisfied"}] }
    ]
  }'::jsonb, false, now(), '00000000-0000-0000-0000-000000000000'
  FROM form_row
  RETURNING form_id, id
)
UPDATE forms
SET current_version_id = version_row.id
FROM version_row
WHERE forms.id = version_row.form_id;
