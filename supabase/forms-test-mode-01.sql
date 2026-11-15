-- Form test mode (2026-11-14). When set, every email the form's workflow sends
-- goes ONLY to this address (subject prefixed "[TEST]"), and the public form
-- shows a TEST MODE banner. Replaces the TEST/LIVE switch baked into each
-- scripts/gen-*.ts generator: going live is clearing this on the Settings
-- tab, not regenerating the schema. Read by apps/forms-worker
-- (workflow-email-step.ts, render), written by PATCH .../forms/{id}/settings.
-- Re-runnable.

alter table public.forms add column if not exists test_email_to text;

comment on column public.forms.test_email_to is
  'Test mode: when set, all workflow emails for this form go only to this address. Null = live.';
