-- employee-warning-notice: turn on "Save and continue later" (2026-11-15).
-- APPLIED via psql 2026-11-15 (email_drafts = true on the PUBLISHED form).
--
-- A manager can start the write-up before the meeting, save it (resume link
-- emailed to a Splash address, 14 days after the last save), and finish it
-- with the employee. While on, the tablet's browser keeps no copy of the
-- answers. Same switch as the builder's Settings tab ("Link and saving"); it
-- lives on the forms row, so it applies at once (no republish) and
-- re-running gen-warning-notice.ts / its SQL does not turn it off.
--
-- NOT done here: the secret link. Turning it on changes the form's address,
-- so do it from the Settings tab when you're ready to re-share the link.

update public.forms set email_drafts = true where slug = 'employee-warning-notice';

select slug, audience, status, email_drafts, link_key is not null as has_secret_link
  from public.forms where slug = 'employee-warning-notice';
