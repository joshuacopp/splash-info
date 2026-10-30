-- forms.fill_audience (2026-10-30). APPLIED 2026-10-30 via Supabase MCP (operator: "Run the sql"); verified: am-assessment {rd}, rm-visit {rm}, price-change {tag} + access_tag price_change, all others {}.
--
-- Who may FILL OUT an internal-audience form. Before this, every signed-in
-- user saw every published internal form on /forms and could open and submit
-- any of them by URL -- including shared site logins (vestalwash@...) seeing
-- the Regional Director assessment and the price change request.
--
-- Values, any combination:
--   site  -- caller is site_email on some location
--   rm    -- caller is rm_email on some location   (Regional Manager)
--   rd    -- caller is am_email on some location   (Regional Director; the
--            column name is legacy, see the label-vs-data note in CLAUDE.md)
--   tag   -- caller holds a form_access_grants row for this form's access_tag
--
-- EMPTY MEANS EVERYONE SIGNED IN, i.e. exactly the old behaviour, so adding
-- the column changes nothing until a form is given a value. Full admin tier
-- (super_admin / dc_role admin) can always fill every form. Enforced by
-- forms-worker in three places -- the /forms list, the render, and the
-- submit -- and only for audience = 'internal'; public and link-only forms
-- ignore it (for those the link is the permission).
--
-- Read live per request, like form_access_grants, so changing a location's
-- emails in sysadmin moves fill access immediately -- no sign-out needed.

alter table public.forms
  add column if not exists fill_audience text[] not null default '{}';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'forms_fill_audience_values'
  ) then
    alter table public.forms
      add constraint forms_fill_audience_values
      check (fill_audience <@ array['site', 'rm', 'rd', 'tag']::text[]);
  end if;
end $$;

comment on column public.forms.fill_audience is
  'Who may fill out this INTERNAL form: any of site (site_email), rm (rm_email), rd (am_email), tag (holds a form_access_grants row for access_tag). Empty = every signed-in user. Admin tier always may. Ignored for public / link-only forms. Set in the builder Settings tab.';

-- Initial settings, per operator decisions 2026-10-30.
--   price-change: marketing, via the price_change tag. Tagging also lets tag
--   holders read every price change submission org-wide (operator: yes).
update public.forms set fill_audience = array['rd']            where slug = 'am-assessment';
update public.forms set fill_audience = array['rm']            where slug = 'rm-visit';
update public.forms set fill_audience = array['tag'],
                        access_tag    = 'price_change'         where slug = 'price-change';

-- Verify:
-- select slug, audience, status, access_tag, fill_audience
--   from public.forms where audience = 'internal' order by slug;
--
-- Once Gina has a login:
--   insert into public.form_access_grants (user_id, tag)
--     select id, 'price_change' from auth.users
--      where lower(email) = 'gina.colley@splashcarwashes.com';
