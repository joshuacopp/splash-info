-- Per-form access, by tag. APPLIED 2026-09-21 via the Supabase connector at
-- the operator's explicit instruction (these tables are normally operator-
-- applied per CLAUDE.md constraint #10). Recorded here to match the convention
-- of every other script in this directory. DO NOT RE-RUN blindly -- it is
-- idempotent (if not exists / guarded constraint), but verify first.
--
-- WHY A TAG AND NOT A TOOL GRANT
--
--   user_tool_access is pinned by a CHECK constraint, VALID_TOOLS in the
--   sysadmin worker, and ALL_TOOLS in apps/web. Adding a grant there is a
--   migration plus two code changes, every time. Here the operator tags a form
--   in the builder and the grant appears in sysadmin by itself, because the
--   checkbox list is sourced from `select distinct access_tag from forms`.
--   That difference only shows up on the SECOND tag, which is exactly when
--   the other choice would be regretted.
--
-- WHY NOT LOCATION SCOPING
--
--   form_submissions already scopes by location for a location admin. That
--   cannot express the queue case: CRD works every site, so scoping them by
--   location means granting every location, which is "all" by another name AND
--   drags in every other location-scoped form. A tag says "these forms,
--   org-wide" without widening anyone else -- which is the requirement: a
--   location admin who approves one form must NOT gain org-wide sight of it.

alter table public.forms
  add column if not exists access_tag text null;

comment on column public.forms.access_tag is
  'Optional access tag. A user holding a matching form_access_grants row reads EVERY submission of this form org-wide, including completed ones -- unlike the location-scoped form_submissions tool grant. Null means no tag: only full admins and location admins (scoped to their sites) can read it.';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'forms_access_tag_shape'
  ) then
    alter table public.forms
      add constraint forms_access_tag_shape
      check (access_tag is null or access_tag ~ '^[a-z][a-z0-9_]*$');
  end if;
end $$;

-- Supports both access patterns: resolving one tag to its form ids, and the
-- distinct-tag scan that builds the sysadmin checkbox list.
create index if not exists forms_access_tag_idx
  on public.forms (access_tag)
  where access_tag is not null;

create table if not exists public.form_access_grants (
  user_id    uuid not null references auth.users (id) on delete cascade,
  tag        text not null,
  granted_by uuid null references auth.users (id),
  granted_at timestamptz not null default now(),

  primary key (user_id, tag),

  -- No FK to a tags table, because there isn't one: a tag exists by virtue of
  -- a form carrying it. A grant for a tag no form uses yet is inert and starts
  -- working the moment a form is tagged, which is the intended behaviour. The
  -- sysadmin UI only offers tags already in use, so the typo path is direct
  -- SQL; the shape check is the guard there.
  constraint form_access_grants_tag_shape check (tag ~ '^[a-z][a-z0-9_]*$')
);

-- The gate resolves caller -> tags on each request, so the PK covers that.
-- This one serves the reverse: who holds a given tag.
create index if not exists form_access_grants_tag_idx
  on public.form_access_grants (tag);

alter table public.form_access_grants enable row level security;

comment on table public.form_access_grants is
  'Which form access tags a user holds. Read by forms-worker submissionGate on each request rather than carried on the session -- one indexed lookup, and it buys a property the session path cannot: a grant takes effect IMMEDIATELY. dc_role, promo_role and role all require the user to sign out and back in, which is a documented footgun in three places in CLAUDE.md. RLS enabled with zero policies like every other table here: the workers reach it with SUPABASE_SERVICE_KEY, which bypasses RLS; anon and authenticated get nothing. Do not add policies -- "on with zero policies" IS the lockdown.';

comment on column public.form_access_grants.granted_by is
  'Audit only, mirroring promo_user_roles.created_by. Nullable so a grant made by SQL rather than the sysadmin card still records cleanly.';

-- ---------------------------------------------------------------------------
-- Verification. Confirmed immediately after apply: column present, shape check
-- present, index present, table present, rowsecurity true, 0 policies, 2 FKs
-- (user_id + granted_by), 0 rows, 0 tagged forms.
-- ---------------------------------------------------------------------------
-- select
--   (select count(*) from information_schema.columns
--      where table_schema='public' and table_name='forms' and column_name='access_tag') as forms_access_tag_col,
--   (select count(*) from pg_constraint where conname='forms_access_tag_shape')          as forms_tag_check,
--   (select c.relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace
--      where n.nspname='public' and c.relname='form_access_grants')                      as grants_rls_enabled,
--   (select count(*) from pg_policy p join pg_class c on c.oid=p.polrelid
--      where c.relname='form_access_grants')                                             as grants_policies;
--
-- To grant CRD access once a form is tagged:
--   update public.forms set access_tag = 'crd' where title = 'Transition Account Issue';
--   insert into public.form_access_grants (user_id, tag)
--     select id, 'crd' from auth.users where email = '<crd user>';
