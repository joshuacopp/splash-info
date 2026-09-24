-- Notes on an action item (Brief 176 follow-up). APPLIED 2026-09-24 via the
-- Supabase connector at the operator's instruction.
--
-- The running record of what was actually done: "added to MaintainX", then
-- later "parts arrived", then "swapped Tuesday". The item's `description` says
-- what was asked for at the visit and never changes; these say what happened
-- since, and neither can stand in for the other.
--
-- APPEND-ONLY. No UPDATE or DELETE path exists in the worker. A note that can
-- be quietly rewritten after an RM has read it is worse than no note. Same
-- posture as form_submission_comments (Brief 174), which this mirrors.
--
-- Allowed on a VERIFIED item, unlike edits to the item itself. Verification
-- freezes what the item IS; recording what happened to it afterwards is not a
-- state change, and "verified, then the part failed again" must stay sayable.
--
-- RLS ENABLED WITH ZERO POLICIES. Authority is enforced in the worker against
-- the PARENT item's location_code (action-items/access.ts,
-- getLocationsByContactEmail). Do not add policies.
--
-- Verified after apply: table present, rowsecurity true, 0 policies, 2 check
-- constraints, FK confdeltype 'c' (cascade), 0 rows.

create table if not exists public.action_item_notes (
  id             uuid primary key default gen_random_uuid(),
  action_item_id uuid not null
                   references public.action_items (id) on delete cascade,
  author_email   text not null,
  author_user_id uuid null references auth.users (id),
  body           text not null,
  created_at     timestamptz not null default now(),

  constraint action_item_notes_body_not_blank
    check (length(btrim(body)) > 0),
  constraint action_item_notes_body_len check (length(body) <= 5000)
);

create index if not exists action_item_notes_item_idx
  on public.action_item_notes (action_item_id, created_at);

alter table public.action_item_notes enable row level security;
