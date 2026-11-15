# Plan: fill an existing PDF from a form (PDF templates)

Status: PLANNED (agreed with the operator 2026-11-14), not built.

## Why

Some forms must produce a specific document, not our generic "completed form"
PDF: the NY pay notices (official NYS DOL LS 54 / LS 59), the Employee Warning
Notice and Notice of Negative Information, and more to come (terminations,
injury reports, check requests, vendor forms). Today each one is hand-coded
(`apps/forms-worker/src/pdf/ny-pay-notice.ts`, `pdf/warning-notice.ts`) and
coupled to field keys, so every new document is a code change and a deploy.

The operator wants it the way JotForm does it: choose to fill an existing PDF,
upload it, then drag stretchable / sizable boxes onto the pages and say which
form field goes in each box.

## What the admin does (builder: new "Documents" tab on /admin/forms/{id})

1. **Upload a PDF** (the blank document). Any PDF works: a scanned paper form,
   an official fillable PDF, or our own letterhead.
2. **See its pages** rendered in the builder, page by page.
3. **Drag boxes onto the page** and resize them. Each box gets:
   - **What goes in it**: a form field (text, number, date, name, email, a
     choice's label, an employee's name), or a fixed value ("today's date",
     "submission id", "site name"), or free text.
   - **Kind**: text (single line or wrapping), a check mark ("tick this box
     when field X is answer Y" -- one box per option, the way paper forms
     have a box per choice), a signature image, or an uploaded photo.
   - **Font size** (or "shrink to fit"), alignment, and an optional format
     (date as 11/14/2026, money as $1,234.00).
4. **Preview** the filled PDF against a real recent submission (or sample
   data) before saving.
5. **Attach it** from an email step: "Attach document: [Warning Notice]", next
   to the existing "Attach PDF of completed form" and "Attach uploaded files".

Fillable PDFs (with AcroForm fields, like the NY notices) get a shortcut: the
builder lists the PDF's own fields and the admin maps each to a form field,
no drawing needed. Boxes and AcroForm mapping can be mixed in one template.

## Design

- **Storage.** The uploaded PDF in R2 (`FORMS_FILES`, `form-pdf-templates/{form_id}/{template_id}.pdf`).
  The mapping in a new table `form_pdf_templates` (id, form_id, name, r2_key,
  page sizes, `boxes jsonb`, `acro_map jsonb`, created/updated by/at). Box
  coordinates are stored in **PDF points from the bottom-left of the page**
  (what pdf-lib draws in), converted from screen pixels in the builder, so the
  output does not depend on the admin's screen size or zoom.
- **Versioning.** A template is snapshotted into the form version on publish
  (like the schema), so a submission is always filled with the template that
  was live when it was submitted, and later edits never rewrite old documents.
- **Filling** (forms-worker, pdf-lib, already a dependency): load the template,
  for each box draw text / a check mark / an embedded PNG or JPEG at the box's
  rectangle (wrap or shrink to fit; WinAnsi-sanitise text via
  `sanitizeForWinAnsi`); for the AcroForm map, set field values then flatten.
  Built once per submission and stored at `form-submission-pdfs/...`, reused
  by later email steps, exactly as `attach_warning_notice` does today.
- **Builder.** Render pages with `pdfjs-dist` (lazy-loaded on the Documents tab
  only, like Mermaid / Recharts), boxes as absolutely positioned divs over the
  page canvas, pointer-event drag + corner handles to resize, snap to 4 px, a
  side panel for the selected box. Keyboard nudge for precise placement.
- **Validation.** On publish: every box names a field that exists on the form
  (or a fixed source); a check-mark box names a real option of a choice field;
  a template whose field was deleted fails publish with the box named.
- **Limits.** Template PDF up to 10 MB / 30 pages; up to 300 boxes.

## Phases

1. **Fill engine + storage** -- table, R2, worker fill function, email-step
   `attach_document: template_id`, preview endpoint. Proved on the **Splash
   Rate of Pay Change form** (operator's official PDF) attached to Pay Change.
   The NY pay notice is NOT touched to test this -- it works and stays as is.
2. **Builder: upload, page view, drag/resize boxes, field picker, preview.**
3. **Check marks per option, signatures, photos, formats, shrink-to-fit.**
4. **Optional later:** move hand-coded documents to templates only if one
   needs changing anyway. The NY notices and the warning notice work and stay
   as they are (operator, 2026-11-14).

## Decided (operator, 2026-11-14)

- **First document: the Splash Rate of Pay Change form** (operator's PDF),
  filled from the Pay Change form. The NY pay notice stays hand-coded -- it
  already works and is not to be redone to test a new feature.
- **One template belongs to one form.** Sharing across forms was allowed but
  has no real use (nobody builds several forms to fill one document), so it
  is not built.
- **Admin tier only** uploads and edits templates.
