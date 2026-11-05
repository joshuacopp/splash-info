-- IT Issue Tracker 03 (2026-11-05): IT staff tag + "is IT responding?" clock.
--
-- The daily digest's "Needs attention" used to mean "critical, or nothing
-- happened for 2 days" -- which flagged a one-off glitch that simply never
-- came back. It now means: sent to IT 2+ days ago AND no IT action in the last
-- 2 days. That needs to know (a) when it was first sent to IT and (b) when IT
-- last did something, which needs (c) knowing which actions were IT's.
--
--   * user_tool_access tool 'it_issues_it' -- marks a login as IT support:
--     sees every site in the tracker, and its actions count as IT's.
--   * it_issue_events.by_it -- the action was IT's: an emailed-link action, or
--     a signed-in user holding it_issues_it at the time.
--   * it_issues.first_escalated_at -- first "Send to IT support". Re-sending
--     does not move it, so a site cannot reset the clock.
--   * it_issues.last_it_action_at -- latest IT action (not counting an IT
--     person pressing "Send to IT support").
--
-- Backfill: email-link actions were always IT's; nothing else can be known.

alter table public.user_tool_access drop constraint if exists user_tool_access_tool_check;
alter table public.user_tool_access add constraint user_tool_access_tool_check check (tool = any (array[
  'pricing', 'claims', 'pertrack', 'form_submissions', 'schedule',
  'inventory_view', 'inventory', 'inventory_admin', 'it_issues', 'it_issues_it'
]));

alter table public.it_issue_events
  add column if not exists by_it boolean not null default false;

alter table public.it_issues
  add column if not exists first_escalated_at timestamptz,
  add column if not exists last_it_action_at  timestamptz;

update public.it_issue_events set by_it = true where via = 'email_link' and not by_it;

update public.it_issues i set
  first_escalated_at = e.first_esc
from (select issue_id, min(at) as first_esc from public.it_issue_events where kind = 'escalated' group by issue_id) e
where e.issue_id = i.id and i.first_escalated_at is null;

update public.it_issues i set
  last_it_action_at = e.last_it
from (select issue_id, max(at) as last_it from public.it_issue_events where by_it and kind <> 'escalated' group by issue_id) e
where e.issue_id = i.id and i.last_it_action_at is null;
