-- End of Day Car Count -- authored as a DRAFT, 2026-11-14. Replaces JotForm 251036310236039.
-- APPLIED via psql 2026-11-14: form_id 002130ca-5051-4f61-8a06-64cd63f9ad12 (draft, unpublished).
-- Built by scripts/gen-end-of-day-car-count.ts (strict + draft validated), TEST mode
-- (emails go to TEST_TO). Regenerate with LIVE=1 to email Wendy Wandtke.
--
-- Re-runnable: upserts the forms row, creates a draft version only when there
-- is none, otherwise overwrites the existing draft schema.
--
--   slug end-of-day-car-count   audience link-only   7 fields   email step -> outcome
--
-- notify_webhook = false: the email step is the delivery.
-- After applying, the operator reviews and publishes from /admin/forms
-- (publish scopes it by site_number), then moves the 11 sites off the JotForm.

insert into public.forms
  (slug, title, description, audience, status, notify_webhook,
   turnstile_required, success_message, created_by, last_edited_by)
values
  ('end-of-day-car-count',
   'End of Day Car Count',
   'The day''s cars washed, with a photo of the counter.',
   'link-only',
   'draft',
   false,
   false,
   'Thanks - today''s car count is recorded.',
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

with f as (select id, draft_version_id from public.forms where slug = 'end-of-day-car-count'),
ins as (
  insert into public.form_versions (form_id, version_number, is_draft, schema)
  select f.id, 1, true, $ec${"fields":[{"key":"site_number","type":"short_text","label":"Site number","helpText":"3-digit site number (leading zeros optional).","required":true,"maxLength":10,"id":"cd4788e1"},{"key":"site_name","type":"lookup","label":"Site","required":false,"sourceTable":"pricing_simple","sourceColumn":"location_pretty","keyColumn":"pricing_simple.site","keyFieldId":"cd4788e1","resolutionMode":"prefill_visible","nullBehavior":"block_submit","show_in_queue":true,"id":"243b8bfe"},{"key":"count_date","type":"date","label":"Date of the count","helpText":"Leave as today unless this count is for an earlier day.","required":true,"defaultToToday":true,"show_in_queue":true,"id":"673e95dd"},{"key":"cars_washed","type":"short_text","label":"Cars washed today (all bays added together)","helpText":"Tunnel screen: the Cars Washed row, Today's Total column. Counter that only shows a running total: today's reading minus yesterday's.","required":true,"maxLength":5,"placeholder":"0","numeric":{"integer":true,"min":0,"max":5000},"show_in_queue":true,"id":"6303c6b8"},{"key":"bays","type":"radio","label":"Number of bays","required":true,"layout":"inline","defaultValue":"1","options":[{"label":"1","value":"1"},{"label":"2","value":"2"}],"id":"8eda6fac"},{"key":"bay1_photo","type":"file","label":"Bay 1 counter photo","helpText":"A photo of the screen or counter showing the count.","required":true,"allowedMimeTypes":["image/*"],"maxSizeMb":15,"resizeImages":2048,"id":"3a1a8f7c"},{"key":"bay2_photo","type":"file","label":"Bay 2 counter photo","required":true,"allowedMimeTypes":["image/*"],"maxSizeMb":15,"resizeImages":2048,"visible_if":{"field_key":"bays","equals":["2"]},"id":"eba2625d"}],"workflow":{"default_stage":"send","stages":[{"id":"send","label":"Email Wendy","kind":"email","recipients":[{"type":"static_emails","emails":["josh.copp@splashcarwashes.com"]}],"attach_files":true,"subject_template":"[TEST] Car count {field.site_name} {field.count_date}: {field.cars_washed} cars","body_template":"TEST - when live this goes to Wendy Wandtke.\n\n{field.site_name} reported {field.cars_washed} cars washed on {field.count_date}.\n\n{payload.summary}\n\nThe counter photo is attached.","transitions":[{"to":"recorded","label":"Sent"}]},{"id":"recorded","label":"Recorded","kind":"outcome","tint":"neutral","transitions":[]}]}}$ec$::jsonb
    from f where f.draft_version_id is null
  returning id, form_id
)
update public.forms set draft_version_id = ins.id, last_edited_at = now()
  from ins where public.forms.id = ins.form_id;

update public.form_versions v
   set schema = $ec${"fields":[{"key":"site_number","type":"short_text","label":"Site number","helpText":"3-digit site number (leading zeros optional).","required":true,"maxLength":10,"id":"cd4788e1"},{"key":"site_name","type":"lookup","label":"Site","required":false,"sourceTable":"pricing_simple","sourceColumn":"location_pretty","keyColumn":"pricing_simple.site","keyFieldId":"cd4788e1","resolutionMode":"prefill_visible","nullBehavior":"block_submit","show_in_queue":true,"id":"243b8bfe"},{"key":"count_date","type":"date","label":"Date of the count","helpText":"Leave as today unless this count is for an earlier day.","required":true,"defaultToToday":true,"show_in_queue":true,"id":"673e95dd"},{"key":"cars_washed","type":"short_text","label":"Cars washed today (all bays added together)","helpText":"Tunnel screen: the Cars Washed row, Today's Total column. Counter that only shows a running total: today's reading minus yesterday's.","required":true,"maxLength":5,"placeholder":"0","numeric":{"integer":true,"min":0,"max":5000},"show_in_queue":true,"id":"6303c6b8"},{"key":"bays","type":"radio","label":"Number of bays","required":true,"layout":"inline","defaultValue":"1","options":[{"label":"1","value":"1"},{"label":"2","value":"2"}],"id":"8eda6fac"},{"key":"bay1_photo","type":"file","label":"Bay 1 counter photo","helpText":"A photo of the screen or counter showing the count.","required":true,"allowedMimeTypes":["image/*"],"maxSizeMb":15,"resizeImages":2048,"id":"3a1a8f7c"},{"key":"bay2_photo","type":"file","label":"Bay 2 counter photo","required":true,"allowedMimeTypes":["image/*"],"maxSizeMb":15,"resizeImages":2048,"visible_if":{"field_key":"bays","equals":["2"]},"id":"eba2625d"}],"workflow":{"default_stage":"send","stages":[{"id":"send","label":"Email Wendy","kind":"email","recipients":[{"type":"static_emails","emails":["josh.copp@splashcarwashes.com"]}],"attach_files":true,"subject_template":"[TEST] Car count {field.site_name} {field.count_date}: {field.cars_washed} cars","body_template":"TEST - when live this goes to Wendy Wandtke.\n\n{field.site_name} reported {field.cars_washed} cars washed on {field.count_date}.\n\n{payload.summary}\n\nThe counter photo is attached.","transitions":[{"to":"recorded","label":"Sent"}]},{"id":"recorded","label":"Recorded","kind":"outcome","tint":"neutral","transitions":[]}]}}$ec$::jsonb
  from public.forms f
 where f.slug = 'end-of-day-car-count' and v.id = f.draft_version_id;

select f.id, f.slug, f.audience, f.status, f.notify_webhook,
       jsonb_array_length(v.schema->'fields') as fields
  from public.forms f
  join public.form_versions v on v.id = f.draft_version_id
 where f.slug = 'end-of-day-car-count';
