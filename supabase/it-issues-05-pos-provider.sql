-- IT Issue Tracker 05 (2026-11-05): tickets opened with the POS provider
-- (Micrologic, DRB, ICS -- the vendor's own tech support, NOT Splash's
-- internal IT support).
--
-- APPLIED 2026-11-05 as migration it_issues_05_pos_provider.
--
-- The report form now asks whether a ticket has been opened with the POS
-- provider; "yes" requires the provider, when they were called and their
-- ticket #. Every call (the first and any later follow-up) is an
-- it_issue_events row of kind 'provider_contact' with
-- details {provider, ticket_no}, occurred_at = when they were called. The
-- columns below are a summary of those events so lists and IT's emails can
-- show it without reading the timeline.
--
-- pos_provider_opened: null = not asked (issues before this change),
-- false = site said no ticket has been opened, true = at least one call.

alter table public.it_issues
  add column if not exists pos_provider_opened boolean,
  add column if not exists pos_provider text,
  add column if not exists pos_provider_ticket_no text,
  add column if not exists pos_provider_first_contact_at timestamptz,
  add column if not exists pos_provider_last_contact_at timestamptz;

comment on column public.it_issues.pos_provider_opened is
  'Ticket opened with the POS provider (Micrologic / DRB / ICS)? null = not asked (older issue). Set true by any provider_contact event.';
comment on column public.it_issues.pos_provider is
  'POS provider named on the latest provider_contact event.';
comment on column public.it_issues.pos_provider_ticket_no is
  'The provider''s ticket # from the latest provider_contact event that gave one.';
