-- Salt Log -- authored as a DRAFT, 2026-11-14. Replaces JotForm 243523811897060.
-- APPLIED via psql 2026-11-14: form_id 1b830fdd-2f5a-4f89-a7c3-8e7364ef7ca9 (draft, unpublished).
-- Built by scripts/gen-salt-log.ts (strict + draft validated).
--
-- Re-runnable: upserts the forms row, creates a draft version only when there
-- is none, otherwise overwrites the existing draft schema.
--
--   slug salt-log   audience link-only   7 fields   no workflow, no emails
--
-- notify_webhook = false: up to ~900 submissions a month in winter, and
-- nothing downstream needs a per-submission Power Automate call.
--
-- After applying, the operator reviews and publishes from /admin/forms
-- (publish scopes it by site_number), then moves sites off the JotForm.

insert into public.forms
  (slug, title, description, audience, status, notify_webhook,
   turnstile_required, success_message, created_by, last_edited_by)
values
  ('salt-log',
   'Salt Log',
   'Record ice melt put down: how much and where.',
   'link-only',
   'draft',
   false,
   false,
   'Thanks - the salt log is recorded.',
   'f42882fd-ee5a-433e-b10b-713d5dff8a89',
   'f42882fd-ee5a-433e-b10b-713d5dff8a89')
on conflict (slug) do update
  set title = excluded.title,
      description = excluded.description,
      audience = excluded.audience,
      notify_webhook = excluded.notify_webhook,
      turnstile_required = excluded.turnstile_required,
      success_message = excluded.success_message,
      last_edited_at = now();

with f as (select id, draft_version_id from public.forms where slug = 'salt-log'),
ins as (
  insert into public.form_versions (form_id, version_number, is_draft, schema)
  select f.id, 1, true, $sl${"fields":[{"key":"site_number","type":"short_text","label":"Site number","helpText":"3-digit site number (leading zeros optional).","required":true,"maxLength":10,"id":"5bc0ba8d"},{"key":"site_name","type":"lookup","label":"Site","required":false,"sourceTable":"pricing_simple","sourceColumn":"location_pretty","keyColumn":"pricing_simple.site","keyFieldId":"5bc0ba8d","resolutionMode":"prefill_visible","nullBehavior":"block_submit","show_in_queue":true,"id":"29abb6ce"},{"key":"applied_date","type":"date","label":"Date applied","helpText":"Change it if you're logging salt that went down earlier.","required":true,"defaultToToday":true,"show_in_queue":true,"id":"bb8b7e30"},{"key":"applied_time","type":"time","label":"Time applied","required":true,"defaultToNow":true,"id":"73d95fd4"},{"key":"pounds","type":"short_text","label":"Pounds of ice melt used","required":true,"maxLength":5,"placeholder":"50","numeric":{"integer":true,"min":1,"max":2000},"show_in_queue":true,"id":"4b31362c"},{"key":"areas","type":"multi","label":"Areas ice melt applied","helpText":"Tick every one that applies.","required":true,"minSelected":1,"options":[{"label":"Entrance pad","value":"entrance_pad"},{"label":"Exit pad","value":"exit_pad"},{"label":"Vacuums","value":"vacuums"},{"label":"Sidewalks","value":"sidewalks"},{"label":"Driveway","value":"driveway"},{"label":"Full property","value":"full_property"}],"show_in_queue":true,"id":"d953702b"},{"key":"applied_by","type":"employee","label":"Your name","helpText":"Start typing your name. Not listed yet (new hire)? Type your full name and use it.","required":true,"keyFieldKey":"site_number","keyColumn":"pricing_simple.site","allowTyped":true,"id":"a8864e7b"}]}$sl$::jsonb
    from f where f.draft_version_id is null
  returning id, form_id
)
update public.forms set draft_version_id = ins.id, last_edited_at = now()
  from ins where public.forms.id = ins.form_id;

update public.form_versions v
   set schema = $sl${"fields":[{"key":"site_number","type":"short_text","label":"Site number","helpText":"3-digit site number (leading zeros optional).","required":true,"maxLength":10,"id":"5bc0ba8d"},{"key":"site_name","type":"lookup","label":"Site","required":false,"sourceTable":"pricing_simple","sourceColumn":"location_pretty","keyColumn":"pricing_simple.site","keyFieldId":"5bc0ba8d","resolutionMode":"prefill_visible","nullBehavior":"block_submit","show_in_queue":true,"id":"29abb6ce"},{"key":"applied_date","type":"date","label":"Date applied","helpText":"Change it if you're logging salt that went down earlier.","required":true,"defaultToToday":true,"show_in_queue":true,"id":"bb8b7e30"},{"key":"applied_time","type":"time","label":"Time applied","required":true,"defaultToNow":true,"id":"73d95fd4"},{"key":"pounds","type":"short_text","label":"Pounds of ice melt used","required":true,"maxLength":5,"placeholder":"50","numeric":{"integer":true,"min":1,"max":2000},"show_in_queue":true,"id":"4b31362c"},{"key":"areas","type":"multi","label":"Areas ice melt applied","helpText":"Tick every one that applies.","required":true,"minSelected":1,"options":[{"label":"Entrance pad","value":"entrance_pad"},{"label":"Exit pad","value":"exit_pad"},{"label":"Vacuums","value":"vacuums"},{"label":"Sidewalks","value":"sidewalks"},{"label":"Driveway","value":"driveway"},{"label":"Full property","value":"full_property"}],"show_in_queue":true,"id":"d953702b"},{"key":"applied_by","type":"employee","label":"Your name","helpText":"Start typing your name. Not listed yet (new hire)? Type your full name and use it.","required":true,"keyFieldKey":"site_number","keyColumn":"pricing_simple.site","allowTyped":true,"id":"a8864e7b"}]}$sl$::jsonb
  from public.forms f
 where f.slug = 'salt-log' and v.id = f.draft_version_id;

select f.id, f.slug, f.audience, f.status, f.notify_webhook,
       jsonb_array_length(v.schema->'fields') as fields
  from public.forms f
  join public.form_versions v on v.id = f.draft_version_id
 where f.slug = 'salt-log';
