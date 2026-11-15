-- PDF templates (2026-11-14, PLAN_FORMS_PDF_TEMPLATES.md): an uploaded blank
-- PDF plus the boxes an admin placed on it, filled from a form's submissions
-- and attached by email steps (attach_documents). Belongs to ONE form
-- (operator: sharing has no real use). Written by splash-forms only; RLS on,
-- no policies, like every other forms table. The PDF itself is in R2
-- (FORMS_FILES, r2_key). Re-runnable.

create table if not exists public.form_pdf_templates (
  id          uuid primary key default gen_random_uuid(),
  form_id     uuid not null references public.forms(id) on delete cascade,
  name        text not null check (length(name) between 1 and 120),
  r2_key      text not null,
  pages       jsonb not null,               -- [{w, h}] in PDF points
  boxes       jsonb not null default '[]',  -- PdfBox[] (packages/forms-schema/src/pdf-template.ts)
  created_by  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists form_pdf_templates_form_idx on public.form_pdf_templates (form_id);
alter table public.form_pdf_templates enable row level security;

comment on table public.form_pdf_templates is
  'Uploaded PDF + placed boxes, filled from a form (Documents tab). Written by splash-forms only.';
