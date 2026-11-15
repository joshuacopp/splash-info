-- end-of-day-car-count: LIVE recipients (Wendy Wandtke) in the draft, with the form put in
-- TEST MODE (forms.test_email_to) so every email still goes only to Josh.
-- Generated 2026-11-14 from scripts/gen-*.ts with LIVE=1. Going live is now
-- switching Test mode off on the form's Settings tab -- no regenerate.
-- Takes effect for the schema when the operator republishes the draft; test
-- mode applies immediately to the published version too.
-- Re-runnable.

update public.forms set test_email_to = 'josh.copp@splashcarwashes.com'
 where slug = 'end-of-day-car-count';

update public.form_versions v
   set schema = $ec${"fields":[{"key":"site_number","type":"short_text","label":"Site number","helpText":"3-digit site number (leading zeros optional).","required":true,"maxLength":10,"id":"cd4788e1"},{"key":"site_name","type":"lookup","label":"Site","required":false,"sourceTable":"pricing_simple","sourceColumn":"location_pretty","keyColumn":"pricing_simple.site","keyFieldId":"cd4788e1","resolutionMode":"prefill_visible","nullBehavior":"block_submit","show_in_queue":true,"id":"243b8bfe"},{"key":"count_date","type":"date","label":"Date of the count","helpText":"Leave as today unless this count is for an earlier day.","required":true,"defaultToToday":true,"show_in_queue":true,"id":"673e95dd"},{"key":"cars_washed","type":"short_text","label":"Cars washed today (all bays added together)","helpText":"Tunnel screen: the Cars Washed row, Today's Total column. Counter that only shows a running total: today's reading minus yesterday's.","required":true,"maxLength":5,"placeholder":"0","numeric":{"integer":true,"min":0,"max":5000},"show_in_queue":true,"id":"6303c6b8"},{"key":"bays","type":"radio","label":"Number of bays","required":true,"layout":"inline","defaultValue":"1","options":[{"label":"1","value":"1"},{"label":"2","value":"2"}],"id":"8eda6fac"},{"key":"bay1_photo","type":"file","label":"Bay 1 counter photo","helpText":"A photo of the screen or counter showing the count.","required":true,"allowedMimeTypes":["image/*"],"maxSizeMb":15,"resizeImages":2048,"id":"3a1a8f7c"},{"key":"bay2_photo","type":"file","label":"Bay 2 counter photo","required":true,"allowedMimeTypes":["image/*"],"maxSizeMb":15,"resizeImages":2048,"visible_if":{"field_key":"bays","equals":["2"]},"id":"eba2625d"}],"workflow":{"default_stage":"send","stages":[{"id":"send","label":"Email Wendy","kind":"email","recipients":[{"type":"static_emails","emails":["wendy.wandtke@splashcarwashes.com"]}],"attach_files":true,"subject_template":"Car count {field.site_name} {field.count_date}: {field.cars_washed} cars","body_template":"{field.site_name} reported {field.cars_washed} cars washed on {field.count_date}.\n\n{payload.summary}\n\nThe counter photo is attached.","transitions":[{"to":"recorded","label":"Sent"}]},{"id":"recorded","label":"Recorded","kind":"outcome","tint":"neutral","transitions":[]}]}}$ec$::jsonb
  from public.forms f
 where f.slug = 'end-of-day-car-count' and v.id = f.draft_version_id;

select f.slug, f.test_email_to, jsonb_array_length(v.schema->'fields')
  from public.forms f join public.form_versions v on v.id = f.draft_version_id
 where f.slug = 'end-of-day-car-count';
