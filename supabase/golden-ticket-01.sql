-- golden-ticket-01.sql
--
-- NOT YET APPLIED. Run in the Supabase SQL editor (production) BEFORE the
-- jotform-worker / apps/web code that reads it deploys. Idempotent: safe to
-- re-run (if not exists / create or replace / on conflict do nothing).
--
-- GOLDEN TICKET PROMO. A customer gets a scratch ticket; on their NEXT visit
-- the employee scratches it. When the prize is free unlimited washing
-- (Month / Year / Lifetime) the employee fills out JotForm 262925137546968.
-- Those submissions are ingested by the existing jotform-worker pipeline into
-- jotform_submissions (Brief 107) like every other JotForm; this file adds
-- what sits on top:
--
--   * jotform_forms.access_tag  -- marks a JotForm as golden-ticket AND
--     grants org-wide read of it to anyone holding a matching
--     form_access_grants tag (same tag table the custom-forms queue uses,
--     form-access-grants-01.sql). One mechanism, so Sysadmin shows the tag
--     next to the forms ones.
--   * golden_ticket_promos      -- promos are DATE RANGES (operator decision
--     2026-10-27). A win belongs to the promo whose range covers the day it
--     was REDEEMED (the submission date), so a promo's end date must be the
--     last day tickets can be redeemed, not the last day they are handed out.
--   * golden_ticket_crd         -- CRD's work on each win (status, two
--     checkboxes, append-only history). Separate from jotform_submissions so
--     a webhook re-delivery or backfill can never overwrite CRD's work.
--   * golden_ticket_settings    -- the no-login site lookup link's token. In
--     the DB rather than a wrangler secret so an admin can kill a leaked link
--     or end the promo from the UI, with no CLI.
--   * golden_ticket_wins (view) -- one clean row per win.
--
-- ONE WIN PER VEHICLE PER PROMO. Vehicle = license plate, compared after
-- gt_plate_norm (upper-case, letters and digits only) so "abc-1234" and
-- "ABC 1234" match. The form has no state field, so the same plate from two
-- states collides; the lookup page shows the earlier win's ticket-and-plate
-- photo so staff can tell. dup_count > 1 flags a second win that got through.
--
-- FIELDS ARE READ BY JotForm FIELD NAME, not question id, so a copied form
-- for a later promo keeps working. Names as of 2026-10-27:
--   customerName, phoneNumber, licensePlatenumber, barcodeif, doesThe
--   (active Unlimited plan already? Yes/No), prize (Month/Year/Lifetime),
--   serialNumber, employeeName, takePicture (file upload), typeA (site
--   number widget -> jotform_submissions.site_number). Renaming a field in
--   the JotForm builder blanks that column here -- edit the view to match.
--
-- Access: RLS on with zero policies, nothing granted to anon/authenticated.
-- Only the service key (jotform-worker) reads or writes any of it.

-- ---------------------------------------------------------------------------
-- 1. Tag the JotForm
-- ---------------------------------------------------------------------------

alter table public.jotform_forms
  add column if not exists access_tag text null;

comment on column public.jotform_forms.access_tag is
  'Optional access tag, same meaning as forms.access_tag: a user holding a matching form_access_grants row reads this JotForm org-wide. ''golden_ticket'' also marks the form as a golden ticket form for the golden_ticket_wins view.';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'jotform_forms_access_tag_shape') then
    alter table public.jotform_forms
      add constraint jotform_forms_access_tag_shape
      check (access_tag is null or access_tag ~ '^[a-z][a-z0-9_]*$');
  end if;
end $$;

insert into public.jotform_forms (form_id, slug, display_name, enabled, access_tag)
values ('262925137546968', 'golden-ticket', 'Golden Ticket - Free Unlimited', true, 'golden_ticket')
on conflict (form_id) do update set access_tag = excluded.access_tag;

-- ---------------------------------------------------------------------------
-- 2. Promos (date ranges)
-- ---------------------------------------------------------------------------

create table if not exists public.golden_ticket_promos (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(btrim(name)) between 1 and 120),
  starts_on   date not null,
  ends_on     date not null,
  created_at  timestamptz not null default now(),
  created_by  text,
  updated_at  timestamptz not null default now(),
  updated_by  text,
  check (ends_on >= starts_on)
);
-- Overlap is refused by the worker (it reads the ranges before writing); a
-- DB exclusion constraint would need btree_gist for one small table.
alter table public.golden_ticket_promos enable row level security;

-- ---------------------------------------------------------------------------
-- 3. CRD work per win
-- ---------------------------------------------------------------------------

create table if not exists public.golden_ticket_crd (
  submission_id      text primary key
                     references public.jotform_submissions (id) on delete cascade,
  status             text not null default 'new'
                     check (status in ('new', 'in_progress', 'done', 'void')),
  account_setup      boolean not null default false,
  micrologic_tagged  boolean not null default false,
  -- Append-only: [{at, by, changes: {field: [from, to]}, note?}]. Written by
  -- the worker only. Holds CRD's notes too, so what was done and why stay in
  -- one timeline.
  history            jsonb not null default '[]'::jsonb,
  updated_at         timestamptz not null default now(),
  updated_by         text
);
alter table public.golden_ticket_crd enable row level security;

-- ---------------------------------------------------------------------------
-- 4. Lookup link (single row)
-- ---------------------------------------------------------------------------

create table if not exists public.golden_ticket_settings (
  id              int primary key default 1 check (id = 1),
  -- NULL = the lookup page is off. Changing it kills every copy of the old
  -- link. Generated by the worker (24 random URL-safe characters).
  lookup_token    text check (lookup_token is null or length(lookup_token) >= 16),
  updated_at      timestamptz not null default now(),
  updated_by      text
);
insert into public.golden_ticket_settings (id) values (1) on conflict (id) do nothing;
alter table public.golden_ticket_settings enable row level security;

-- ---------------------------------------------------------------------------
-- 5. Helpers + the view
-- ---------------------------------------------------------------------------

create or replace function public.gt_plate_norm(p text)
returns text language sql immutable as $$
  select upper(regexp_replace(coalesce(p, ''), '[^A-Za-z0-9]', '', 'g'))
$$;

-- Text of one JotForm answer, found by field NAME. prettyFormat first (it is
-- the human form of name / phone / radio fields), then a plain answer, then
-- the parts of an object answer joined by spaces.
create or replace function public.jotform_answer_text(answers jsonb, field_name text)
returns text language sql immutable as $$
  select nullif(btrim(coalesce(
    case when jsonb_typeof(e.value -> 'prettyFormat') = 'string' then e.value ->> 'prettyFormat' end,
    case when jsonb_typeof(e.value -> 'answer') in ('string', 'number') then e.value ->> 'answer' end,
    -- Name / phone objects. Named keys first: jsonb sorts object keys
    -- (shortest first), so a blind join of all parts would print "last first".
    case when jsonb_typeof(e.value -> 'answer') = 'object' then
      coalesce(
        nullif(concat_ws(' ',
          nullif(e.value -> 'answer' ->> 'prefix', ''),
          nullif(e.value -> 'answer' ->> 'first', ''),
          nullif(e.value -> 'answer' ->> 'middle', ''),
          nullif(e.value -> 'answer' ->> 'last', ''),
          nullif(e.value -> 'answer' ->> 'suffix', '')), ''),
        nullif(e.value -> 'answer' ->> 'full', ''),
        nullif(concat_ws(' ',
          nullif(e.value -> 'answer' ->> 'area', ''),
          nullif(e.value -> 'answer' ->> 'phone', '')), ''),
        (select string_agg(x.v, ' ') from jsonb_each_text(e.value -> 'answer') as x(k, v) where x.v <> '')
      )
    end
  )), '')
  from jsonb_each(coalesce(answers, '{}'::jsonb)) as e
  where e.value ->> 'name' = field_name
  limit 1
$$;

-- First URL of a file-upload answer (an array of URLs, or one string).
create or replace function public.jotform_answer_first_url(answers jsonb, field_name text)
returns text language sql immutable as $$
  select nullif(btrim(case jsonb_typeof(e.value -> 'answer')
    when 'array'  then e.value -> 'answer' ->> 0
    when 'string' then e.value ->> 'answer'
  end), '')
  from jsonb_each(coalesce(answers, '{}'::jsonb)) as e
  where e.value ->> 'name' = field_name
  limit 1
$$;

create or replace view public.golden_ticket_wins as
with base as (
  select
    s.id                                                    as submission_id,
    s.form_id,
    s.site_number,
    s.jotform_created_at                                    as submitted_at,
    (s.jotform_created_at at time zone 'America/New_York')::date as won_on,
    public.jotform_answer_text(s.answers, 'customerName')       as customer_name,
    public.jotform_answer_text(s.answers, 'phoneNumber')        as phone,
    public.jotform_answer_text(s.answers, 'licensePlatenumber') as plate,
    public.jotform_answer_text(s.answers, 'barcodeif')          as barcode,
    public.jotform_answer_text(s.answers, 'doesThe')            as existing_unlimited,
    public.jotform_answer_text(s.answers, 'prize')              as prize,
    public.jotform_answer_text(s.answers, 'serialNumber')       as ticket_serial,
    public.jotform_answer_text(s.answers, 'employeeName')       as employee_name,
    public.jotform_answer_first_url(s.answers, 'takePicture')   as photo_url
  from public.jotform_submissions s
  join public.jotform_forms f
    on f.form_id = s.form_id and f.access_tag = 'golden_ticket'
),
joined as (
  select
    b.*,
    public.gt_plate_norm(b.plate) as plate_norm,
    case
      when b.prize ilike '%life%'  then 'GTLIFE'
      when b.prize ilike '%year%'  then 'GT365'
      when b.prize ilike '%month%' then 'GT30'
    end as prize_code,
    loc.site            as site_name,
    p.id                as promo_id,
    p.name              as promo_name,
    coalesce(c.status, 'new')              as status,
    coalesce(c.account_setup, false)       as account_setup,
    coalesce(c.micrologic_tagged, false)   as micrologic_tagged,
    coalesce(c.history, '[]'::jsonb)       as history,
    c.updated_at        as crd_updated_at,
    c.updated_by        as crd_updated_by
  from base b
  left join lateral (
    select l.site from public.locations l
    where l.site_number::text = ltrim(b.site_number, '0')
       or l.site_number::text = b.site_number
    limit 1
  ) loc on true
  left join lateral (
    select gp.id, gp.name from public.golden_ticket_promos gp
    where b.won_on between gp.starts_on and gp.ends_on
    order by gp.starts_on desc
    limit 1
  ) p on true
  left join public.golden_ticket_crd c on c.submission_id = b.submission_id
)
select
  j.*,
  -- Non-void wins for the same plate in the same promo, this one included.
  -- > 1 means a vehicle won twice. 0 when there is no plate or no promo.
  case
    when j.plate_norm = '' or j.promo_id is null then 0
    else count(*) filter (where j.status <> 'void')
           over (partition by j.promo_id, j.plate_norm)::int
  end as dup_count
from joined j;

-- ---------------------------------------------------------------------------
-- 6. Lock down (default privileges already revoke tables/views; explicit here
--    so this file is correct on its own).
-- ---------------------------------------------------------------------------

revoke all on public.golden_ticket_promos   from anon, authenticated;
revoke all on public.golden_ticket_crd      from anon, authenticated;
revoke all on public.golden_ticket_settings from anon, authenticated;
revoke all on public.golden_ticket_wins     from anon, authenticated;
revoke execute on function public.gt_plate_norm(text)                    from public, anon, authenticated;
revoke execute on function public.jotform_answer_text(jsonb, text)       from public, anon, authenticated;
revoke execute on function public.jotform_answer_first_url(jsonb, text)  from public, anon, authenticated;
