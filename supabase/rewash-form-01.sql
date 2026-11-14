-- Rewash -- authored as a DRAFT, 2026-11-14. Replaces JotForm 250165655616055.
-- APPLIED via psql 2026-11-14: form_id a721b505-e14c-484c-be5c-4c37be9f3fe0 (draft, unpublished).
-- Built by scripts/gen-rewash.ts (strict + draft validated).
--
-- Re-runnable: upserts the forms row, creates a draft version only when there
-- is none, otherwise overwrites the existing draft schema.
--
--   slug rewash   audience link-only   13 fields   no workflow, no emails
--
-- notify_webhook = false: ~100 submissions a day, and nothing downstream
-- needs a per-submission Power Automate call.
--
-- After applying, the operator reviews and publishes from /admin/forms, then
-- pilots it at a few sites before switching every site off the JotForm.

insert into public.forms
  (slug, title, description, audience, status, notify_webhook,
   turnstile_required, success_message, created_by, last_edited_by)
values
  ('rewash',
   'Rewash',
   'Record a rewash and the reason for it.',
   'link-only',
   'draft',
   false,
   false,
   'Thanks - the rewash is recorded.',
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

with f as (select id, draft_version_id from public.forms where slug = 'rewash'),
ins as (
  insert into public.form_versions (form_id, version_number, is_draft, schema)
  select f.id, 1, true, $rw${"fields":[{"key":"site_number","type":"short_text","label":"Site number","helpText":"3-digit site number (leading zeros optional).","required":true,"maxLength":10,"id":"57245e12"},{"key":"site_name","type":"lookup","label":"Site","required":false,"sourceTable":"pricing_simple","sourceColumn":"location_pretty","keyColumn":"pricing_simple.site","keyFieldId":"57245e12","resolutionMode":"prefill_visible","nullBehavior":"block_submit","show_in_queue":true,"id":"53424973"},{"key":"greeter_code","type":"short_text","label":"Greeter code","required":true,"maxLength":10,"placeholder":"0000","show_in_queue":true,"id":"07a65494"},{"key":"reason","type":"radio","label":"Rewash reason","required":true,"layout":"vertical","options":[{"label":"Member 2nd+ wash","value":"member_2nd"},{"label":"Still dirty","value":"still_dirty"},{"label":"Employee wash","value":"employee_wash"},{"label":"Comp wash (manager signs)","value":"comp_wash"},{"label":"Splash member from a non-MLA site (no account fix needed)","value":"non_mla_member"},{"label":"Wash book ticket","value":"wash_book"},{"label":"Auto Care Network redemption","value":"auto_care_network"}],"show_in_queue":true,"id":"d3793a1d"},{"key":"member_account","type":"short_text","label":"Member account plate or barcode","required":true,"maxLength":40,"visible_if":{"field_key":"reason","equals":["member_2nd","non_mla_member"]},"id":"1c4f1a93"},{"key":"members_home","type":"short_text","label":"Member's home location","required":true,"maxLength":80,"visible_if":{"field_key":"reason","equals":["non_mla_member"]},"id":"56b6f1ac"},{"key":"license_plate","type":"short_text","label":"License plate","required":true,"maxLength":20,"visible_if":{"field_key":"reason","equals":["non_mla_member"]},"id":"fc62493a"},{"key":"whats_dirty","type":"long_text","label":"What's still dirty?","required":true,"maxLength":1000,"rows":2,"visible_if":{"field_key":"reason","equals":["still_dirty"]},"id":"8c364d28"},{"key":"employee","type":"employee","label":"Employee","helpText":"Start typing their name. Not listed yet (new hire)? Type their full name and use it.","required":true,"keyFieldKey":"site_number","keyColumn":"pricing_simple.site","allowTyped":true,"visible_if":{"field_key":"reason","equals":["employee_wash"]},"id":"43426ea1"},{"key":"employee_signature","type":"signature","label":"Employee signature","required":true,"format":"png","visible_if":{"field_key":"reason","equals":["employee_wash"]},"id":"5e7c5208"},{"key":"comp_reason","type":"short_text","label":"Reason for comp wash","required":true,"maxLength":200,"visible_if":{"field_key":"reason","equals":["comp_wash"]},"id":"6b056364"},{"key":"manager_signature","type":"signature","label":"Manager signature","helpText":"A manager approves the comp wash by signing here.","required":true,"format":"png","visible_if":{"field_key":"reason","equals":["comp_wash"]},"id":"aad6c1d0"},{"key":"wash_book_photo","type":"file","label":"Photo of the wash book ticket","required":true,"allowedMimeTypes":["image/*"],"maxSizeMb":10,"visible_if":{"field_key":"reason","equals":["wash_book"]},"id":"55d63060"}]}$rw$::jsonb
    from f where f.draft_version_id is null
  returning id, form_id
)
update public.forms set draft_version_id = ins.id, last_edited_at = now()
  from ins where public.forms.id = ins.form_id;

update public.form_versions v
   set schema = $rw${"fields":[{"key":"site_number","type":"short_text","label":"Site number","helpText":"3-digit site number (leading zeros optional).","required":true,"maxLength":10,"id":"57245e12"},{"key":"site_name","type":"lookup","label":"Site","required":false,"sourceTable":"pricing_simple","sourceColumn":"location_pretty","keyColumn":"pricing_simple.site","keyFieldId":"57245e12","resolutionMode":"prefill_visible","nullBehavior":"block_submit","show_in_queue":true,"id":"53424973"},{"key":"greeter_code","type":"short_text","label":"Greeter code","required":true,"maxLength":10,"placeholder":"0000","show_in_queue":true,"id":"07a65494"},{"key":"reason","type":"radio","label":"Rewash reason","required":true,"layout":"vertical","options":[{"label":"Member 2nd+ wash","value":"member_2nd"},{"label":"Still dirty","value":"still_dirty"},{"label":"Employee wash","value":"employee_wash"},{"label":"Comp wash (manager signs)","value":"comp_wash"},{"label":"Splash member from a non-MLA site (no account fix needed)","value":"non_mla_member"},{"label":"Wash book ticket","value":"wash_book"},{"label":"Auto Care Network redemption","value":"auto_care_network"}],"show_in_queue":true,"id":"d3793a1d"},{"key":"member_account","type":"short_text","label":"Member account plate or barcode","required":true,"maxLength":40,"visible_if":{"field_key":"reason","equals":["member_2nd","non_mla_member"]},"id":"1c4f1a93"},{"key":"members_home","type":"short_text","label":"Member's home location","required":true,"maxLength":80,"visible_if":{"field_key":"reason","equals":["non_mla_member"]},"id":"56b6f1ac"},{"key":"license_plate","type":"short_text","label":"License plate","required":true,"maxLength":20,"visible_if":{"field_key":"reason","equals":["non_mla_member"]},"id":"fc62493a"},{"key":"whats_dirty","type":"long_text","label":"What's still dirty?","required":true,"maxLength":1000,"rows":2,"visible_if":{"field_key":"reason","equals":["still_dirty"]},"id":"8c364d28"},{"key":"employee","type":"employee","label":"Employee","helpText":"Start typing their name. Not listed yet (new hire)? Type their full name and use it.","required":true,"keyFieldKey":"site_number","keyColumn":"pricing_simple.site","allowTyped":true,"visible_if":{"field_key":"reason","equals":["employee_wash"]},"id":"43426ea1"},{"key":"employee_signature","type":"signature","label":"Employee signature","required":true,"format":"png","visible_if":{"field_key":"reason","equals":["employee_wash"]},"id":"5e7c5208"},{"key":"comp_reason","type":"short_text","label":"Reason for comp wash","required":true,"maxLength":200,"visible_if":{"field_key":"reason","equals":["comp_wash"]},"id":"6b056364"},{"key":"manager_signature","type":"signature","label":"Manager signature","helpText":"A manager approves the comp wash by signing here.","required":true,"format":"png","visible_if":{"field_key":"reason","equals":["comp_wash"]},"id":"aad6c1d0"},{"key":"wash_book_photo","type":"file","label":"Photo of the wash book ticket","required":true,"allowedMimeTypes":["image/*"],"maxSizeMb":10,"visible_if":{"field_key":"reason","equals":["wash_book"]},"id":"55d63060"}]}$rw$::jsonb
  from public.forms f
 where f.slug = 'rewash' and v.id = f.draft_version_id;

select f.id, f.slug, f.audience, f.status, f.notify_webhook,
       jsonb_array_length(v.schema->'fields') as fields
  from public.forms f
  join public.form_versions v on v.id = f.draft_version_id
 where f.slug = 'rewash';
