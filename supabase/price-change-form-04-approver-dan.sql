-- Price change approval: approver back to Dan Petrelle (slug: price-change).
--
-- APPLIED to the DRAFT (v6) 2026-11-03 via the Supabase connector, at the
-- operator's request. Publishing it in the builder is what makes it live; v5
-- (published 2026-10-27) still routes to Jay Frank until then.
--
-- v5 and its draft had jfrank@splashcarwashes.com in exactly two places, the
-- "notify_dan" email step's recipients and the "dan_review" approval step's
-- approver_source. The committed 03 SQL says Dan, so v5 was generated or
-- edited with a different approver after the fact. The draft was otherwise
-- byte-identical to v5, so publishing ships only this change. No submission
-- was waiting on Jay (all five on record were closed).
--
-- Draft only, never the published row (CLAUDE.md constraint #10). SAFE TO
-- RE-RUN: a second run finds no jfrank and changes nothing.

update public.form_versions v
   set schema = replace(v.schema::text, '"jfrank@splashcarwashes.com"', '"dpetrelle@splashcarwashes.com"')::jsonb
  from public.forms f
 where f.slug = 'price-change' and v.id = f.draft_version_id and v.published_at is null;

select v.version_number,
       (select s->'approver_source'->'emails'->>0 from jsonb_array_elements(v.schema->'workflow'->'stages') s
         where s->>'id' = 'dan_review') as approver
  from public.form_versions v join public.forms f on v.id = f.draft_version_id
 where f.slug = 'price-change';
