-- forms.crd_visible (2026-10-30). APPLIED 2026-10-30.
--
-- Per-form switch: when true, CRD agents and supervisors read this form's
-- submissions at the sites they cover in crd_site_coverage (read live by
-- forms-worker submissionGate). Toggled from the form builder's Settings tab.
-- Only location-scoped forms (scope_location_field_key set) can be switched on.

alter table public.forms
  add column if not exists crd_visible boolean not null default false;

comment on column public.forms.crd_visible is
  'CRD agents/supervisors read this form''s submissions at the sites they cover (crd_site_coverage). Toggled in the builder Settings tab.';

create index if not exists forms_crd_visible_idx on public.forms (id) where crd_visible;
