-- IT Issue Tracker 02 (2026-11-05): customer references + when it actually happened.
--
-- A report used to carry only the moment someone typed it in. Sites often log
-- after the fact, and IT needs the customer's ticket / account to look the
-- transaction up, so:
--   * it_issues.customer_ticket_no / customer_account_no -- from the first report.
--     Later occurrences (often a different customer) keep theirs in
--     it_issue_events.details, the same way error_text already works.
--   * it_issue_events.occurred_at -- when the problem actually happened, for
--     'created' and 'occurrence' events. `at` stays "when it was logged".
--     NULL on older rows: read it as coalesce(occurred_at, at).
--   * first_reported_at / last_occurred_at on it_issues now hold the earliest /
--     latest occurred_at, maintained by the worker.
--
-- Additive only. Safe to apply before the worker deploys.

alter table public.it_issues
  add column if not exists customer_ticket_no  text,
  add column if not exists customer_account_no text;

alter table public.it_issue_events
  add column if not exists occurred_at timestamptz;

comment on column public.it_issue_events.occurred_at is
  'When the problem actually happened (created / occurrence events). NULL on rows before 2026-11-05: use coalesce(occurred_at, at).';
