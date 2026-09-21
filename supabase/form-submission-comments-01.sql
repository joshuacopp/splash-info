-- Comment threads on form submissions (Brief 174).
--
-- WHY THIS IS NOT workflow_history
--
--   workflow_history is an audit of what HAPPENED to a ticket: who moved it,
--   from where to where, when. Before this table the only way to say anything
--   about a submission was a transition note, so information could only move
--   when the ticket moved -- a CRD worker wanting to ask "which card did they
--   use?" had to bounce the ticket back to the site to ask it, and the site
--   had to transition it forward to answer, whether or not a stage change was
--   warranted. The state machine ended up being driven by the need to talk.
--
--   Transitions stay the record of state changes. Comments carry the
--   conversation. A comment moves nothing and changes nobody's queue.
--
-- APPEND-ONLY ON PURPOSE. No UPDATE or DELETE path exists in the worker. A
-- thread that can be quietly rewritten after someone has acted on what it said
-- is worse than no thread -- the whole value is that it is a faithful record
-- of what was asked and answered.
--
-- RLS ENABLED WITH NO POLICIES, matching every other table here. The workers
-- reach this with SUPABASE_SERVICE_KEY, which bypasses RLS entirely; anon and
-- authenticated get nothing. Do NOT add policies -- "on with zero policies" IS
-- the lockdown, and a policy written here would only widen it.
--
-- Applied out-of-band (Supabase SQL editor / MCP apply_migration), matching
-- the convention of every other script in this directory.

begin;

create table if not exists public.form_submission_comments (
  id             uuid primary key default gen_random_uuid(),
  submission_id  uuid not null
                   references public.form_submissions (id) on delete cascade,
  -- Denormalized at write, like form_submissions.submitter_email. The thread
  -- has to stay readable after a user row is removed -- an attributed comment
  -- whose author has left is still evidence; an orphaned one is not.
  author_email   text not null,
  author_user_id uuid null references auth.users (id),
  body           text not null,
  created_at     timestamptz not null default now(),

  constraint form_submission_comments_body_not_blank
    check (length(btrim(body)) > 0),
  -- Matches the worker's cap. Enforced here too so a direct SQL insert cannot
  -- park something unbounded in a column the UI has to render.
  constraint form_submission_comments_body_len
    check (length(body) <= 10000)
);

-- The only access pattern: every comment on one submission, oldest first.
create index if not exists form_submission_comments_submission_idx
  on public.form_submission_comments (submission_id, created_at);

alter table public.form_submission_comments enable row level security;

comment on table public.form_submission_comments is
  'Brief 174. Append-only discussion on a form submission. Separate from workflow_history, which audits state changes -- this carries what people said. Comments notify nobody at v1; a transition is still the only "your turn" signal. Read/post authority is enforced in the worker: admin tier, the current stage''s resolved approver, the submitter, or anyone who already acted (workflow_history.actor_email).';
comment on column public.form_submission_comments.author_email is
  'Denormalized at write so the thread survives the author''s user row being removed.';

commit;

-- ---------------------------------------------------------------------------
-- Verification. Expected immediately after apply: table present, 1 index,
-- rowsecurity true, 0 policies, 0 rows.
-- ---------------------------------------------------------------------------
-- select c.relrowsecurity as rls_enabled,
--        (select count(*) from pg_policy p where p.polrelid = c.oid) as policies,
--        (select count(*) from pg_index i where i.indrelid = c.oid)  as indexes,
--        (select count(*) from public.form_submission_comments)      as rows
--   from pg_class c
--   join pg_namespace n on n.oid = c.relnamespace
--  where n.nspname = 'public' and c.relname = 'form_submission_comments';
--
-- Cascade check -- deleting a submission must take its thread with it:
-- select conname, confdeltype  -- expect 'c' (cascade)
--   from pg_constraint
--  where conrelid = 'public.form_submission_comments'::regclass
--    and contype = 'f';

-- ---------------------------------------------------------------------------
-- Brief 174 follow-up, APPLIED with the above: GIN index on
-- form_submissions.workflow_history.
--
-- The approvals queue asks "which submissions has this person acted on?" via
-- jsonb containment (workflow_history @> '[{"actor_email":"..."}]'). Without
-- an index that is a sequential scan of every submission on every queue load.
-- Added while the table is small enough for the build to be instant, rather
-- than diagnosed later as a slow queue.
--
-- jsonb_path_ops rather than the default opclass: it indexes containment only,
-- which is the single operator this query uses, and is smaller than the
-- default which also supports key-exists operators we never issue.
-- ---------------------------------------------------------------------------
-- create index if not exists form_submissions_workflow_history_gin
--   on public.form_submissions
--   using gin (workflow_history jsonb_path_ops);
