-- Cancellation Request -- authored as a DRAFT, 2026-11-04.
-- APPLIED via the Supabase connector at the operator's instruction, 2026-11-04:
--   form_id 8af52b3f-9411-422a-80a4-89a9183869b7
--   draft_version_id 01e5aa8c-fd34-42b1-b824-059af547d718
-- Re-running is safe (upsert + draft overwrite) and is how to push a
-- regenerated schema into the still-unpublished draft.
-- Built by scripts/gen-cancellation-request.ts (strict + draft validated).
-- Re-runnable: upserts the forms row, creates a draft version only when there
-- is none, otherwise overwrites the existing draft schema.
--
--   slug cancellation-request   audience link-only  8 fields
--
-- Fields: site_number (scope field) -> site_name + site_email lookups,
-- customer_name, account_id (barcode or plate), customer_phone, reason
-- (Not using / Price/value / Moving / Competitor better / Other) and
-- reason_other, required and shown only when reason = Other.
--
-- Workflow: "New" (approver = the site_email lookup) -> Saved | Cancelled,
-- each with an optional note. No per-submission email: sites learn of open tickets
-- from the 12:00 UTC "waiting on you" digest and work them at /admin/approvals.
--
-- After applying, the operator reviews and publishes from /admin/forms.

insert into public.forms
  (slug, title, description, audience, status, notify_webhook,
   turnstile_required, success_message, created_by, last_edited_by)
values
  ('cancellation-request',
   'Cancellation Request',
   'Record a customer request to cancel their membership. The site follows up and marks it Saved or Cancelled.',
   'link-only',
   'draft',
   true,
   false,
   'Thanks - the cancellation request is with the site.',
   'f42882fd-ee5a-433e-b10b-713d5dff8a89',
   'f42882fd-ee5a-433e-b10b-713d5dff8a89')
on conflict (slug) do update
  set title = excluded.title,
      description = excluded.description,
      audience = excluded.audience,
      turnstile_required = excluded.turnstile_required,
      success_message = excluded.success_message,
      last_edited_at = now();

with f as (select id, draft_version_id from public.forms where slug = 'cancellation-request'),
ins as (
  insert into public.form_versions (form_id, version_number, is_draft, schema)
  select f.id, 1, true, '{"fields":[{"key":"site_number","type":"short_text","label":"Site number","helpText":"3-digit site number (leading zeros optional).","required":true,"maxLength":10,"id":"2328267d"},{"key":"site_name","type":"lookup","label":"Site","required":false,"sourceTable":"pricing_simple","sourceColumn":"location_pretty","keyColumn":"pricing_simple.site","keyFieldId":"2328267d","resolutionMode":"prefill_visible","nullBehavior":"block_submit","show_in_queue":true,"id":"d6eb4e14"},{"key":"site_email","type":"lookup","label":"Site email","required":false,"sourceTable":"pricing_simple","sourceColumn":"site_email","keyColumn":"pricing_simple.site","keyFieldId":"2328267d","resolutionMode":"prefill_visible","nullBehavior":"allow_empty","id":"e3562a77"},{"key":"customer_name","type":"name","label":"Customer name","required":true,"maxLength":120,"show_in_queue":true,"id":"8f74e505"},{"key":"account_id","type":"short_text","label":"Account barcode or plate","helpText":"The barcode on the customer''s account, or the license plate on it.","required":true,"maxLength":40,"show_in_queue":true,"id":"f929c776"},{"key":"customer_phone","type":"phone","label":"Customer phone","required":true,"show_in_queue":true,"id":"494613b0"},{"key":"reason","type":"radio","label":"Reason for cancellation","required":true,"layout":"vertical","options":[{"label":"Not using","value":"not_using"},{"label":"Price/value","value":"price_value"},{"label":"Moving","value":"moving"},{"label":"Competitor better","value":"competitor_better"},{"label":"Other","value":"other"}],"show_in_queue":true,"id":"3c0c599d"},{"key":"reason_other","type":"long_text","label":"Other reason (explain)","required":true,"maxLength":1000,"rows":3,"visible_if":{"field_key":"reason","equals":["other"]},"id":"6a20c2ed"}],"workflow":{"default_stage":"site_review","stages":[{"id":"site_review","label":"New","kind":"approval","approver_source":{"type":"payload_field","field_key":"site_email"},"transitions":[{"to":"saved","label":"Saved"},{"to":"cancelled","label":"Cancelled"}]},{"id":"saved","label":"Saved","kind":"outcome","tint":"success","transitions":[]},{"id":"cancelled","label":"Cancelled","kind":"outcome","tint":"danger","transitions":[]}]}}'::jsonb
    from f where f.draft_version_id is null
  returning id, form_id
)
update public.forms set draft_version_id = ins.id, last_edited_at = now()
  from ins where public.forms.id = ins.form_id;

update public.form_versions v
   set schema = '{"fields":[{"key":"site_number","type":"short_text","label":"Site number","helpText":"3-digit site number (leading zeros optional).","required":true,"maxLength":10,"id":"2328267d"},{"key":"site_name","type":"lookup","label":"Site","required":false,"sourceTable":"pricing_simple","sourceColumn":"location_pretty","keyColumn":"pricing_simple.site","keyFieldId":"2328267d","resolutionMode":"prefill_visible","nullBehavior":"block_submit","show_in_queue":true,"id":"d6eb4e14"},{"key":"site_email","type":"lookup","label":"Site email","required":false,"sourceTable":"pricing_simple","sourceColumn":"site_email","keyColumn":"pricing_simple.site","keyFieldId":"2328267d","resolutionMode":"prefill_visible","nullBehavior":"allow_empty","id":"e3562a77"},{"key":"customer_name","type":"name","label":"Customer name","required":true,"maxLength":120,"show_in_queue":true,"id":"8f74e505"},{"key":"account_id","type":"short_text","label":"Account barcode or plate","helpText":"The barcode on the customer''s account, or the license plate on it.","required":true,"maxLength":40,"show_in_queue":true,"id":"f929c776"},{"key":"customer_phone","type":"phone","label":"Customer phone","required":true,"show_in_queue":true,"id":"494613b0"},{"key":"reason","type":"radio","label":"Reason for cancellation","required":true,"layout":"vertical","options":[{"label":"Not using","value":"not_using"},{"label":"Price/value","value":"price_value"},{"label":"Moving","value":"moving"},{"label":"Competitor better","value":"competitor_better"},{"label":"Other","value":"other"}],"show_in_queue":true,"id":"3c0c599d"},{"key":"reason_other","type":"long_text","label":"Other reason (explain)","required":true,"maxLength":1000,"rows":3,"visible_if":{"field_key":"reason","equals":["other"]},"id":"6a20c2ed"}],"workflow":{"default_stage":"site_review","stages":[{"id":"site_review","label":"New","kind":"approval","approver_source":{"type":"payload_field","field_key":"site_email"},"transitions":[{"to":"saved","label":"Saved"},{"to":"cancelled","label":"Cancelled"}]},{"id":"saved","label":"Saved","kind":"outcome","tint":"success","transitions":[]},{"id":"cancelled","label":"Cancelled","kind":"outcome","tint":"danger","transitions":[]}]}}'::jsonb
  from public.forms f
 where f.slug = 'cancellation-request' and v.id = f.draft_version_id;

select f.id, f.slug, f.audience, f.status,
       jsonb_array_length(v.schema->'fields') as fields,
       jsonb_array_length(v.schema->'workflow'->'stages') as stages
  from public.forms f
  join public.form_versions v on v.id = f.draft_version_id
 where f.slug = 'cancellation-request';
