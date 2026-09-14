# Brief 90: Forms — public render path (`GET /forms/{slug}`)

**Status:** Completed (2026-05-09)
**Started:** 2026-05-09
**Completed:** 2026-05-09
**Blocks:** Brief 91 (public submit — form has to render before users can submit it). Brief 95 (admin builder — builder's "preview" pane will iframe or duplicate this renderer; the per-field-type render contract lands here first).
**Dependencies:** Brief 89 (foundation — schema + worker skeleton + `@splash/forms-schema` package + R2 binding).

## Read first

- BUILD_STATE.md.
- CLAUDE.md (especially constraints #6 / #9 — staging only, no production routes).
- BRIEFS/brief-089-forms-foundation-schema-worker-package.md (the substrate this brief consumes).
- BRIEFS/brief-081-fleet-inquiry-worker-lift-and-shift.md (reference for worker-rendered HTML form pattern — 1250-line inline HTML; this brief uses a more structured per-field-type module split, but the inline-HTML / inline-CSS / inline-JS posture is the same).
- BRIEFS/brief-023-customer-claim-form.md (precedent for damage-worker's claim form server-side render with Splash branding via `@splash/storage-r2` ASSETS).
- packages/storage-r2/src/index.ts (`ASSETS` export — logo URLs the rendered HTML embeds).
- apps/forms-worker/src/index.ts (the 404 stub Brief 89 lands; this brief replaces it with a real router).
- packages/forms-schema/src/types.ts (the `Field` discriminated union — Brief 89 stub; this brief extends per-type config interfaces).
- packages/auth/src/index.ts (the cookie helpers — this brief reads `sb-access-token` for internal-audience forms).
- apps/fleet-inquiry-worker/src/index.js L1–L300 ish (reference for the inline-HTML render shape).

## Architecture context

Per planning Decision 3, the form-builder feature has **two renderers** sharing one schema contract (`@splash/forms-schema`): the React builder in apps/web (Brief 95), and this server-rendered HTML in `splash-forms`. They are deliberately different implementations — the builder needs drag handles, selection state, and inline edit affordances; the public renderer needs none of that, just clean accessible HTML + minimal vanilla JS.

Per planning Decision 4, this brief lays down **per-field-type render functions** as separate modules under `apps/forms-worker/src/render/fields/`. Each module exports a `render(field, ctx) → string` function that produces the HTML for that field type. This per-type folder structure is the architectural choice that makes "add a 17th field type next quarter" a small contained change.

Per planning Decision 8, the audience flag controls auth gating at render time:
- `public`: no auth, Turnstile widget rendered (verification happens at submit time in Brief 91).
- `internal`: cookie presence check (`sb-access-token` from `@splash/auth`); redirect to `/login?next=/forms/{slug}` if absent. Full session validation deferred to submit time per Decision 8b (validating on every render adds Supabase round-trip latency for marginal value; cookie presence is good-enough render-time gate).
- `link-only`: slug acts as the gate. No Turnstile, no auth check. Anyone with the URL renders the form.

Per planning Decision 6, the rendered form's `<form>` element points at `POST /forms/api/submit/{slug}` — Brief 91 wires the submit handler. This brief produces a valid HTML form that *would* submit; the POST handler returns 404 until Brief 91 lands. Operator verification of Brief 90 stops at "form renders correctly" — they shouldn't click Submit until Brief 91 is queued.

The public form is **server-rendered HTML on every request** — no caching at v1. `pricing_simple`/`locations` lookups are point reads (Brief 93 will add lookup endpoints; this brief doesn't render lookup values yet — lookup fields render disabled with placeholder "Select [Location field name] to populate"). Form schema reads from `form_versions` per request (sub-10ms for indexed reads). Edge caching can be added later if measurable load appears.

**This brief is exercise-able against a hand-created test form.** Brief 94 introduces the admin API for creating forms; this brief lands first by design (so 91/92/93 have a render surface to validate against). The brief includes inline SQL the operator runs in Supabase SQL editor to create one test form per audience (`public`, `internal`, `link-only`) with a representative subset of field types. Executor verifies the brief by visiting each test form's URL and confirming the rendered HTML.

## Context

Second of 10 briefs in the form-builder feature. Brief 89 laid the substrate (schema, worker skeleton, package, R2 binding); this brief gives the worker its first user-visible behavior — public form rendering. After this brief the worker is no longer a 404 stub; users hitting `/forms/{slug}` see a real Splash-branded form.

Brief 89's `@splash/forms-schema/src/types.ts` declared `Field` as a `FieldBase` alias (no per-type detail). This brief extends it into the full discriminated union — one interface per field type with its config shape. That extension is the contract every subsequent brief reads from.

Per Decision 4's payload matrix, two field types are display-only and produce no payload (`heading`, `image`); two more (`file`, `signature`) need follow-up briefs to be functional (Brief 92 wires the upload). For Brief 90 the file/signature inputs render as placeholder controls — visible but non-functional at first; functional after Brief 92.

The `Location` field type (Decision 4 refinement) is a special-case Dropdown sourced from `pricing_simple` distinct location_codes. For Brief 90 the worker queries Supabase at render time to populate the options. (Pre-baked into the rendered HTML — no client-side fetch.) Lookup fields key off Location fields by ID; Brief 93 wires the dynamic re-resolve. For Brief 90 lookup fields render disabled.

CSS strategy: inline `<style>` block in the rendered HTML (~250 lines), Splash navy header bar with white-script logo from `@splash/storage-r2 ASSETS`. No Tailwind on the public render — same posture as fleet/signup forms (smaller TTFB, no dependency on apps/web's bundled Tailwind). Builder-side (Brief 95) uses Tailwind because it lives inside apps/web's existing bundle.

## Scope

### Phase 1 — Extend `@splash/forms-schema` types

**File:** `packages/forms-schema/src/types.ts` (MODIFY).

Replace the Brief 89 `export type Field = FieldBase;` placeholder with the full discriminated union. One interface per field type extending `FieldBase`:

```ts
// Display-only types (no payload)
export interface HeadingField extends FieldBase {
  type: "heading";
  level: "h1" | "h2" | "h3" | "h4";
  text: string;          // distinct from `label` — heading text is the body
}

export interface ImageField extends FieldBase {
  type: "image";
  assetId: string;       // FK to form_assets.id
  altText: string;
  caption?: string;
  maxWidth: "small" | "medium" | "full";   // 25% / 50% / 100% of form width
}

// Text inputs
export interface NameField extends FieldBase {
  type: "name";
  maxLength?: number;    // default 120
}

export interface EmailField extends FieldBase {
  type: "email";
  maxLength?: number;    // default 254
}

export interface PhoneField extends FieldBase {
  type: "phone";
  // Phone is always 10-digit US per CLAUDE.md (matches existing forms)
}

export interface ShortTextField extends FieldBase {
  type: "short_text";
  maxLength?: number;    // default 500
  placeholder?: string;
}

export interface LongTextField extends FieldBase {
  type: "long_text";
  maxLength?: number;    // default 10000
  placeholder?: string;
  rows?: number;         // default 4
}

export interface HiddenField extends FieldBase {
  type: "hidden";
  defaultValueFromUrlParam?: string;   // e.g. "source" → captures ?source=email_q2
  defaultValue?: string;               // fallback when URL param absent
}

// Choice
export interface DropdownOption {
  value: string;          // canonical, written to payload
  label: string;          // display
}

export interface DropdownField extends FieldBase {
  type: "dropdown";
  options: DropdownOption[];
  placeholder?: string;
}

export interface MultiField extends FieldBase {
  type: "multi";
  options: DropdownOption[];
  minSelected?: number;   // default 0
  maxSelected?: number;   // optional cap
}

// Date / Time — native HTML inputs
export interface DateField extends FieldBase {
  type: "date";
  minDate?: string;       // YYYY-MM-DD
  maxDate?: string;       // YYYY-MM-DD
  defaultToToday?: boolean;
}

export interface TimeField extends FieldBase {
  type: "time";
  minTime?: string;       // HH:MM
  maxTime?: string;       // HH:MM
}

// File upload — Brief 92 wires the upload behavior
export interface FileField extends FieldBase {
  type: "file";
  maxSizeMb?: number;             // default 10, hard ceiling 25 enforced server-side
  allowedMimeTypes?: string[];    // default ["image/*", "application/pdf"]
  allowMultiple?: boolean;        // default false
}

// Signature — Brief 92 wires the canvas
export interface SignatureField extends FieldBase {
  type: "signature";
  format: "png" | "svg";   // default "png"
  penColor?: string;       // default "#000000"
  minStrokes?: number;     // default 1
}

// Location picker — special-case dropdown sourced from pricing_simple
export interface LocationField extends FieldBase {
  type: "location";
  displayFormat: "name" | "name_and_address" | "site_number";
  // Payload value is always the location_code slug regardless of displayFormat.
}

// Lookup — Brief 93 wires the resolver
export type LookupResolutionMode = "prefill_hidden" | "prefill_visible" | "display_only";
export type LookupNullBehavior = "allow_empty" | "block_submit";

export interface LookupField extends FieldBase {
  type: "lookup";
  keyFieldId: string;                      // FK to another field's `id` in this form
  keyColumn: LookupKeyColumn;              // imported from lookup-sources.ts
  sourceTable: "pricing_simple" | "locations";
  sourceColumn: string;                    // must appear in LOOKUP_SOURCES
  resolutionMode: LookupResolutionMode;
  nullBehavior: LookupNullBehavior;
}

// The full discriminated union.
export type Field =
  | HeadingField
  | ImageField
  | NameField
  | EmailField
  | PhoneField
  | ShortTextField
  | LongTextField
  | HiddenField
  | DropdownField
  | MultiField
  | DateField
  | TimeField
  | FileField
  | SignatureField
  | LocationField
  | LookupField;
```

Add the imports:

```ts
import type { LookupKeyColumn } from "./lookup-sources";
```

### Phase 2 — Per-field-type Zod validators (render-time)

**File:** `packages/forms-schema/src/validators/field-config.ts` (NEW).

One Zod schema per field type validating that a field's *config* is well-formed (for Brief 95's builder save path AND for Brief 90's render-time defensive check that the schema in `form_versions.schema` is parseable).

```ts
import { z } from "zod";

const fieldBaseSchema = {
  id: z.string().min(1),
  key: z.string().regex(/^[a-z][a-z0-9_]*$/, "snake_case slug, leading non-digit"),
  label: z.string().min(1),
  required: z.boolean(),
  helpText: z.string().optional()
};

export const headingFieldSchema = z.object({
  ...fieldBaseSchema,
  type: z.literal("heading"),
  level: z.enum(["h1", "h2", "h3", "h4"]),
  text: z.string().min(1)
});

export const imageFieldSchema = z.object({
  ...fieldBaseSchema,
  type: z.literal("image"),
  assetId: z.string().uuid(),
  altText: z.string().min(1),
  caption: z.string().optional(),
  maxWidth: z.enum(["small", "medium", "full"])
});

// (...one per field type — executor extends the same shape)

export const fieldSchema = z.discriminatedUnion("type", [
  headingFieldSchema,
  imageFieldSchema,
  // ...all 16
]);

export const formSchemaSchema = z.object({
  fields: z.array(fieldSchema)
});
```

(Executor writes one schema per field type — 16 total. Keep the file ~200 lines; it's mechanical.)

**File:** `packages/forms-schema/src/validators/index.ts` (MODIFY — replace Brief 89 stub).

```ts
export * from "./field-config";
```

### Phase 3 — Worker DB helpers

**File:** `apps/forms-worker/src/db/forms.ts` (NEW).

Supabase reads, all using `SUPABASE_SERVICE_KEY`. Three helpers needed for Brief 90:

```ts
import { createClient } from "@supabase/supabase-js";
import type { FormMeta, FormVersion } from "@splash/forms-schema";
import type { Env } from "../index";

export function createServiceClient(env: Env) {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false }
  });
}

export async function getFormBySlug(env: Env, slug: string): Promise<FormMeta | null> {
  const client = createServiceClient(env);
  const { data, error } = await client
    .from("forms")
    .select("id,slug,title,description,audience,status,current_version_id,draft_version_id,notify_webhook,success_message,turnstile_required")
    .eq("slug", slug)
    .maybeSingle();
  if (error) {
    console.error("[forms] getFormBySlug error", error);
    return null;
  }
  if (!data) return null;
  return rowToFormMeta(data);   // executor writes the camelCase mapping
}

export async function getCurrentVersion(env: Env, formId: string, currentVersionId: string): Promise<FormVersion | null> {
  // Reads form_versions.schema JSONB.
  // Used by GET /forms/{slug} to render the published version.
  // ...
}

export async function getLocationOptionsFromPricingSimple(env: Env): Promise<Array<{ code: string; pretty: string; address: string; site: string }>> {
  // SELECT DISTINCT ON (location_code) location_code, location_pretty, address, site
  //   FROM pricing_simple
  //   WHERE pricing IN ('full', 'partial')   -- skip retired locations
  //   ORDER BY location_code, sort
  // Returns distinct locations for the Location field's pre-baked option list.
  // ...
}
```

(Executor fills in the mappings; type the return values strictly off `@splash/forms-schema`.)

### Phase 4 — Render modules

**Directory:** `apps/forms-worker/src/render/` (NEW).

**File:** `apps/forms-worker/src/render/shell.ts` (NEW). Outer HTML shell — `<!DOCTYPE html>`, `<head>`, inline `<style>`, navy header bar with white-script logo.

```ts
import { ASSETS } from "@splash/storage-r2";
import type { FormMeta } from "@splash/forms-schema";

interface ShellArgs {
  form: FormMeta;
  bodyHtml: string;
  turnstileSiteKey?: string;   // included only when audience === "public"
}

export function renderShell({ form, bodyHtml, turnstileSiteKey }: ShellArgs): string {
  const turnstileScript = turnstileSiteKey
    ? `<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>`
    : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(form.title)} — Splash</title>
  ${turnstileScript}
  <style>${SHELL_CSS}</style>
</head>
<body>
  <header class="splash-header">
    <img src="${ASSETS.logoWhite}" alt="Splash Car Wash" class="splash-logo" />
  </header>
  <main class="forms-main">
    <article class="forms-form-wrap">
      <h1 class="forms-title">${escapeHtml(form.title)}</h1>
      ${form.description ? `<p class="forms-description">${escapeHtml(form.description)}</p>` : ""}
      ${bodyHtml}
    </article>
  </main>
</body>
</html>`;
}

const SHELL_CSS = `
  /* Splash brand tokens */
  :root {
    --splash-navy: #0a2240;
    --splash-blue: #1e5fa8;
    --splash-cyan: #4cc4ec;
    --splash-gray-light: #f4f6f9;
    --splash-text: #1a1a1a;
    --splash-error: #c0392b;
  }
  /* Reset + base */
  * { box-sizing: border-box; }
  body {
    margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: var(--splash-gray-light); color: var(--splash-text); line-height: 1.5;
  }
  /* Header */
  .splash-header { background: var(--splash-navy); padding: 16px 24px; }
  .splash-logo { height: 36px; display: block; }
  /* Form layout */
  .forms-main { max-width: 720px; margin: 0 auto; padding: 32px 16px 64px; }
  .forms-form-wrap { background: white; border-radius: 8px; padding: 32px 28px; box-shadow: 0 2px 8px rgba(0,0,0,0.06); }
  .forms-title { margin: 0 0 8px; font-size: 28px; color: var(--splash-navy); }
  .forms-description { margin: 0 0 24px; color: #555; }
  /* Field wrapper */
  .field { margin-bottom: 20px; }
  .field-label { display: block; font-weight: 600; margin-bottom: 6px; color: var(--splash-navy); }
  .field-required { color: var(--splash-error); margin-left: 2px; }
  .field-help { font-size: 13px; color: #666; margin-top: 4px; }
  .field-input, .field-select, .field-textarea {
    width: 100%; padding: 10px 12px; border: 1px solid #ccc; border-radius: 4px;
    font-size: 16px; font-family: inherit;
  }
  .field-input:focus, .field-select:focus, .field-textarea:focus {
    outline: 2px solid var(--splash-cyan); border-color: var(--splash-cyan);
  }
  .field-textarea { resize: vertical; min-height: 80px; }
  /* Headings */
  .field-heading-h1 { font-size: 28px; margin: 24px 0 8px; color: var(--splash-navy); }
  .field-heading-h2 { font-size: 22px; margin: 20px 0 8px; color: var(--splash-navy); }
  .field-heading-h3 { font-size: 18px; margin: 16px 0 8px; color: var(--splash-navy); }
  .field-heading-h4 { font-size: 16px; margin: 12px 0 6px; color: var(--splash-navy); }
  /* Image (in-form display) */
  .field-image-wrap { margin: 16px 0; }
  .field-image { display: block; height: auto; }
  .field-image-small { max-width: 25%; }
  .field-image-medium { max-width: 50%; }
  .field-image-full { max-width: 100%; }
  .field-image-caption { font-size: 13px; color: #666; margin-top: 6px; font-style: italic; }
  /* Multi-checkbox group */
  .field-multi-option { display: flex; align-items: center; margin-bottom: 6px; }
  .field-multi-option input { margin-right: 8px; }
  /* Disabled lookup placeholder */
  .field-lookup-disabled { background: #f0f0f0; color: #888; font-style: italic; }
  /* File / signature placeholders */
  .field-file-input { padding: 8px; }
  .field-signature-canvas { border: 1px solid #ccc; border-radius: 4px; background: white; display: block; width: 100%; height: 180px; cursor: crosshair; }
  .field-signature-clear { margin-top: 8px; font-size: 13px; }
  /* Submit button */
  .submit-btn {
    background: var(--splash-blue); color: white; border: none; padding: 14px 28px;
    font-size: 16px; font-weight: 600; border-radius: 4px; cursor: pointer;
    margin-top: 16px;
  }
  .submit-btn:hover { background: var(--splash-navy); }
  .submit-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  /* Turnstile */
  .turnstile-wrap { margin: 16px 0; }
  /* Footer */
  .forms-footer { text-align: center; margin-top: 24px; font-size: 13px; color: #888; }
`;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
```

**File:** `apps/forms-worker/src/render/index.ts` (NEW). Form body renderer — iterates fields, dispatches to per-type render, wraps in `<form>` with submit button.

```ts
import type { FormMeta, FormVersion, LocationOption } from "@splash/forms-schema";
import { renderField } from "./fields";
import { escapeHtml } from "./util";

interface RenderBodyArgs {
  form: FormMeta;
  version: FormVersion;
  locationOptions: LocationOption[];   // for Location-type fields
  pendingSubmissionId: string;          // generated server-side; client uses for upload routing (Brief 92)
  turnstileSiteKey?: string;
  urlParams: URLSearchParams;           // for Hidden field default value population
}

export function renderFormBody(args: RenderBodyArgs): string {
  const fieldsHtml = args.version.schema.fields
    .map((field) => renderField(field, args))
    .join("\n");

  const turnstileWidget = args.turnstileSiteKey
    ? `<div class="turnstile-wrap"><div class="cf-turnstile" data-sitekey="${escapeHtml(args.turnstileSiteKey)}"></div></div>`
    : "";

  return `
<form action="/forms/api/submit/${escapeHtml(args.form.slug)}" method="post" enctype="multipart/form-data" class="forms-body">
  <input type="hidden" name="pending_submission_id" value="${escapeHtml(args.pendingSubmissionId)}" />
  ${fieldsHtml}
  ${turnstileWidget}
  <button type="submit" class="submit-btn">Submit</button>
</form>
`;
}
```

**Directory:** `apps/forms-worker/src/render/fields/` (NEW).

One module per field type. Common shape: `export function renderHeading(field: HeadingField, ctx: RenderCtx): string`. Dispatcher `apps/forms-worker/src/render/fields/index.ts` switches on `field.type`.

```ts
// apps/forms-worker/src/render/fields/index.ts
import type { Field } from "@splash/forms-schema";
import type { RenderBodyArgs } from "../index";

import { renderHeading } from "./heading";
import { renderImage } from "./image";
import { renderName } from "./name";
import { renderEmail } from "./email";
import { renderPhone } from "./phone";
import { renderShortText } from "./short-text";
import { renderLongText } from "./long-text";
import { renderHidden } from "./hidden";
import { renderDropdown } from "./dropdown";
import { renderMulti } from "./multi";
import { renderDate } from "./date";
import { renderTime } from "./time";
import { renderFile } from "./file";
import { renderSignature } from "./signature";
import { renderLocation } from "./location";
import { renderLookup } from "./lookup";

export function renderField(field: Field, ctx: RenderBodyArgs): string {
  switch (field.type) {
    case "heading":     return renderHeading(field, ctx);
    case "image":       return renderImage(field, ctx);
    case "name":        return renderName(field, ctx);
    case "email":       return renderEmail(field, ctx);
    case "phone":       return renderPhone(field, ctx);
    case "short_text":  return renderShortText(field, ctx);
    case "long_text":   return renderLongText(field, ctx);
    case "hidden":      return renderHidden(field, ctx);
    case "dropdown":    return renderDropdown(field, ctx);
    case "multi":       return renderMulti(field, ctx);
    case "date":        return renderDate(field, ctx);
    case "time":        return renderTime(field, ctx);
    case "file":        return renderFile(field, ctx);
    case "signature":   return renderSignature(field, ctx);
    case "location":    return renderLocation(field, ctx);
    case "lookup":      return renderLookup(field, ctx);
  }
}
```

**Per-field-type modules — 16 files.** Each ~30 lines. Concrete examples:

```ts
// apps/forms-worker/src/render/fields/email.ts
import type { EmailField } from "@splash/forms-schema";
import type { RenderBodyArgs } from "../index";
import { fieldLabel, fieldHelp, escapeHtml } from "../util";

export function renderEmail(field: EmailField, _ctx: RenderBodyArgs): string {
  const maxLength = field.maxLength ?? 254;
  return `
<div class="field" data-field-key="${escapeHtml(field.key)}" data-field-type="email">
  ${fieldLabel(field)}
  <input type="email"
         name="${escapeHtml(field.key)}"
         id="${escapeHtml(field.id)}"
         class="field-input"
         maxlength="${maxLength}"
         pattern="^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$"
         ${field.required ? "required" : ""} />
  ${fieldHelp(field)}
</div>`;
}
```

```ts
// apps/forms-worker/src/render/fields/phone.ts
import type { PhoneField } from "@splash/forms-schema";
import type { RenderBodyArgs } from "../index";
import { fieldLabel, fieldHelp, escapeHtml } from "../util";

export function renderPhone(field: PhoneField, _ctx: RenderBodyArgs): string {
  return `
<div class="field" data-field-key="${escapeHtml(field.key)}" data-field-type="phone">
  ${fieldLabel(field)}
  <input type="tel"
         name="${escapeHtml(field.key)}"
         id="${escapeHtml(field.id)}"
         class="field-input"
         pattern="\\d{10}"
         maxlength="14"
         placeholder="10 digits, no formatting"
         ${field.required ? "required" : ""} />
  ${fieldHelp(field)}
</div>`;
}
```

```ts
// apps/forms-worker/src/render/fields/lookup.ts
import type { LookupField } from "@splash/forms-schema";
import type { RenderBodyArgs } from "../index";
import { fieldLabel, fieldHelp, escapeHtml } from "../util";

export function renderLookup(field: LookupField, ctx: RenderBodyArgs): string {
  // Brief 90: lookup fields render disabled with helper text. Real
  // dynamic resolution wires in Brief 93.
  const keyField = ctx.version.schema.fields.find((f) => f.id === field.keyFieldId);
  const keyFieldLabel = keyField ? keyField.label : "the key field";
  return `
<div class="field" data-field-key="${escapeHtml(field.key)}" data-field-type="lookup"
     data-lookup-key-field="${escapeHtml(field.keyFieldId)}"
     data-lookup-resolution-mode="${escapeHtml(field.resolutionMode)}">
  ${fieldLabel(field)}
  <input type="text"
         name="${escapeHtml(field.key)}"
         class="field-input field-lookup-disabled"
         disabled
         placeholder="Select ${escapeHtml(keyFieldLabel)} to populate" />
  ${fieldHelp(field)}
</div>`;
}
```

```ts
// apps/forms-worker/src/render/fields/file.ts
import type { FileField } from "@splash/forms-schema";
import type { RenderBodyArgs } from "../index";
import { fieldLabel, fieldHelp, escapeHtml } from "../util";

export function renderFile(field: FileField, _ctx: RenderBodyArgs): string {
  // Brief 90 renders a plain file input. Brief 92 wires the upload
  // (POST /forms/api/upload, R2 write, preview rendering, error display).
  const accept = (field.allowedMimeTypes ?? ["image/*", "application/pdf"]).join(",");
  return `
<div class="field" data-field-key="${escapeHtml(field.key)}" data-field-type="file"
     data-field-max-size-mb="${field.maxSizeMb ?? 10}">
  ${fieldLabel(field)}
  <input type="file"
         name="${escapeHtml(field.key)}"
         id="${escapeHtml(field.id)}"
         class="field-file-input"
         accept="${escapeHtml(accept)}"
         ${field.allowMultiple ? "multiple" : ""}
         ${field.required ? "required" : ""} />
  ${fieldHelp(field)}
</div>`;
}
```

```ts
// apps/forms-worker/src/render/fields/signature.ts
import type { SignatureField } from "@splash/forms-schema";
import type { RenderBodyArgs } from "../index";
import { fieldLabel, fieldHelp, escapeHtml } from "../util";

export function renderSignature(field: SignatureField, _ctx: RenderBodyArgs): string {
  // Brief 90 renders the canvas markup. Brief 92 wires signature_pad,
  // the Clear button handler, and the upload-to-R2 flow.
  return `
<div class="field" data-field-key="${escapeHtml(field.key)}" data-field-type="signature"
     data-format="${escapeHtml(field.format)}"
     data-pen-color="${escapeHtml(field.penColor ?? "#000000")}"
     data-min-strokes="${field.minStrokes ?? 1}">
  ${fieldLabel(field)}
  <canvas class="field-signature-canvas" id="signature-${escapeHtml(field.id)}" width="600" height="180"></canvas>
  <input type="hidden" name="${escapeHtml(field.key)}" id="signature-input-${escapeHtml(field.id)}" />
  <div class="field-signature-clear">
    <button type="button" class="signature-clear-btn" data-target="${escapeHtml(field.id)}">Clear signature</button>
  </div>
  ${fieldHelp(field)}
</div>`;
}
```

```ts
// apps/forms-worker/src/render/fields/location.ts
import type { LocationField } from "@splash/forms-schema";
import type { RenderBodyArgs } from "../index";
import { fieldLabel, fieldHelp, escapeHtml } from "../util";

export function renderLocation(field: LocationField, ctx: RenderBodyArgs): string {
  const optionsHtml = ctx.locationOptions
    .map((loc) => {
      let display = loc.pretty;
      if (field.displayFormat === "name_and_address") display = `${loc.pretty} — ${loc.address}`;
      else if (field.displayFormat === "site_number") display = `${loc.site} — ${loc.pretty}`;
      return `<option value="${escapeHtml(loc.code)}">${escapeHtml(display)}</option>`;
    })
    .join("");
  return `
<div class="field" data-field-key="${escapeHtml(field.key)}" data-field-type="location">
  ${fieldLabel(field)}
  <select name="${escapeHtml(field.key)}" id="${escapeHtml(field.id)}" class="field-select" ${field.required ? "required" : ""}>
    <option value="">— Select a location —</option>
    ${optionsHtml}
  </select>
  ${fieldHelp(field)}
</div>`;
}
```

```ts
// apps/forms-worker/src/render/fields/hidden.ts
import type { HiddenField } from "@splash/forms-schema";
import type { RenderBodyArgs } from "../index";
import { escapeHtml } from "../util";

export function renderHidden(field: HiddenField, ctx: RenderBodyArgs): string {
  let value = field.defaultValue ?? "";
  if (field.defaultValueFromUrlParam) {
    value = ctx.urlParams.get(field.defaultValueFromUrlParam) ?? value;
  }
  return `<input type="hidden" name="${escapeHtml(field.key)}" value="${escapeHtml(value)}" />`;
}
```

(Executor writes the remaining 9 modules following the same pattern: `name`, `short-text`, `long-text`, `dropdown`, `multi`, `date`, `time`, `heading`, `image`. Heading and Image are display-only — no input element.)

**File:** `apps/forms-worker/src/render/util.ts` (NEW). Shared helpers.

```ts
import type { FieldBase } from "@splash/forms-schema";

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function fieldLabel(field: FieldBase): string {
  return `<label class="field-label" for="${escapeHtml(field.id)}">
    ${escapeHtml(field.label)}${field.required ? '<span class="field-required" aria-label="required">*</span>' : ""}
  </label>`;
}

export function fieldHelp(field: FieldBase): string {
  return field.helpText ? `<p class="field-help">${escapeHtml(field.helpText)}</p>` : "";
}
```

### Phase 5 — Worker router (replace 404 stub)

**File:** `apps/forms-worker/src/index.ts` (MODIFY — replace Brief 89's 404 stub).

```ts
import { ACCESS_TOKEN_COOKIE } from "@splash/auth";
import type { FormMeta } from "@splash/forms-schema";
import { getFormBySlug, getCurrentVersion, getLocationOptionsFromPricingSimple } from "./db/forms";
import { renderShell } from "./render/shell";
import { renderFormBody } from "./render";

export interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  FORMS_SUBMISSION_WEBHOOK_URL?: string;
  FORMS_FILES: R2Bucket;
}

export default {
  async fetch(req: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    // GET /forms/{slug} — public form render
    const renderMatch = url.pathname.match(/^\/forms\/([^\/]+)$/);
    if (renderMatch && req.method === "GET") {
      return handleFormRender(env, req, url, renderMatch[1]);
    }

    return new Response("Not Found", { status: 404 });
  }
};

async function handleFormRender(env: Env, req: Request, url: URL, slug: string): Promise<Response> {
  const form = await getFormBySlug(env, slug);
  if (!form) return notFoundPage();
  if (form.status === "draft") return notFoundPage();        // unpublished forms 404 publicly
  if (form.status === "archived") return notFoundPage();     // archived forms 404 publicly
  if (!form.currentVersionId) return notFoundPage();         // never published

  // Audience gate
  if (form.audience === "internal") {
    const cookies = req.headers.get("Cookie") ?? "";
    if (!cookies.includes(`${ACCESS_TOKEN_COOKIE}=`)) {
      return Response.redirect(`${url.origin}/login?next=${encodeURIComponent(url.pathname + url.search)}`, 302);
    }
  }
  // public: no auth required, Turnstile widget rendered (verification at submit time in Brief 91)
  // link-only: slug acts as gate, no further check

  const version = await getCurrentVersion(env, form.id, form.currentVersionId);
  if (!version) return notFoundPage();

  // Location options for any Location-type fields in the schema
  const hasLocationField = version.schema.fields.some((f) => f.type === "location");
  const locationOptions = hasLocationField ? await getLocationOptionsFromPricingSimple(env) : [];

  const pendingSubmissionId = crypto.randomUUID();
  const includeTurnstile = form.audience === "public" && !!env.TURNSTILE_SITE_KEY;

  const bodyHtml = renderFormBody({
    form,
    version,
    locationOptions,
    pendingSubmissionId,
    turnstileSiteKey: includeTurnstile ? env.TURNSTILE_SITE_KEY : undefined,
    urlParams: url.searchParams
  });

  const html = renderShell({
    form,
    bodyHtml,
    turnstileSiteKey: includeTurnstile ? env.TURNSTILE_SITE_KEY : undefined
  });

  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",       // every render reads fresh — schema may have changed via re-publish
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "same-origin"
    }
  });
}

function notFoundPage(): Response {
  return new Response(
    `<!DOCTYPE html><html><head><title>Form not found — Splash</title></head><body style="font-family:sans-serif;padding:48px;text-align:center;"><h1>Form not found</h1><p>This form is unavailable.</p></body></html>`,
    { status: 404, headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}
```

### Phase 6 — Test forms (operator runs the SQL)

**File:** `supabase/forms-test-data.sql` (NEW). One test form per audience, with a representative subset of field types. Operator runs in Supabase SQL editor after Phase 1 SQL.

```sql
-- Brief 90: test forms for the public render path. Three forms, one per
-- audience. Operator runs after Brief 89's forms-tables.sql and before
-- queueing Brief 90 (so the executor has something to verify against).

-- Test form 1: public (Turnstile-gated, anonymous submitter)
WITH form_row AS (
  INSERT INTO forms (slug, title, description, audience, status, notify_webhook, success_message, turnstile_required, created_by, last_edited_by)
  VALUES ('test-public', 'Public Test Form', 'Brief 90 verification — public audience.', 'public', 'published', false, 'Thanks for testing!', true, '00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000')
  RETURNING id
),
version_row AS (
  INSERT INTO form_versions (form_id, version_number, schema, is_draft, published_at, published_by)
  SELECT id, 1, '{
    "fields": [
      { "id": "f1", "type": "heading", "key": "h1", "label": "h1", "required": false, "level": "h2", "text": "Tell us about your interest" },
      { "id": "f2", "type": "name", "key": "full_name", "label": "Full name", "required": true },
      { "id": "f3", "type": "email", "key": "email", "label": "Email", "required": true },
      { "id": "f4", "type": "phone", "key": "phone", "label": "Phone (10 digits)", "required": true },
      { "id": "f5", "type": "location", "key": "site", "label": "Which location?", "required": true, "displayFormat": "name" },
      { "id": "f6", "type": "long_text", "key": "comments", "label": "Comments", "required": false, "rows": 4 }
    ]
  }'::jsonb, false, now(), '00000000-0000-0000-0000-000000000000'
  FROM form_row
  RETURNING form_id, id
)
UPDATE forms SET current_version_id = version_row.id FROM version_row WHERE forms.id = version_row.form_id;

-- Test form 2: internal (cookie-gated)
-- Includes a Lookup field — Brief 90 renders it disabled; Brief 93 wires resolution.
WITH form_row AS (
  INSERT INTO forms (slug, title, description, audience, status, notify_webhook, success_message, turnstile_required, created_by, last_edited_by)
  VALUES ('test-internal', 'Internal Test Form', 'Brief 90 verification — internal audience.', 'internal', 'published', false, 'Submitted.', false, '00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000')
  RETURNING id
),
version_row AS (
  INSERT INTO form_versions (form_id, version_number, schema, is_draft, published_at, published_by)
  SELECT id, 1, '{
    "fields": [
      { "id": "f1", "type": "short_text", "key": "site_number", "label": "Site number (3 digits)", "required": true, "maxLength": 4 },
      { "id": "f2", "type": "lookup", "key": "location_name", "label": "Location", "required": false, "keyFieldId": "f1", "keyColumn": "pricing_simple.site", "sourceTable": "pricing_simple", "sourceColumn": "location_pretty", "resolutionMode": "prefill_visible", "nullBehavior": "allow_empty" },
      { "id": "f3", "type": "lookup", "key": "rd_email", "label": "Regional Director email", "required": false, "keyFieldId": "f1", "keyColumn": "pricing_simple.site", "sourceTable": "pricing_simple", "sourceColumn": "am_email", "resolutionMode": "prefill_hidden", "nullBehavior": "allow_empty" },
      { "id": "f4", "type": "long_text", "key": "issue", "label": "Issue description", "required": true, "rows": 5 }
    ]
  }'::jsonb, false, now(), '00000000-0000-0000-0000-000000000000'
  FROM form_row
  RETURNING form_id, id
)
UPDATE forms SET current_version_id = version_row.id FROM version_row WHERE forms.id = version_row.form_id;

-- Test form 3: link-only (slug-as-secret, no Turnstile, no auth)
WITH form_row AS (
  INSERT INTO forms (slug, title, description, audience, status, notify_webhook, success_message, turnstile_required, created_by, last_edited_by)
  VALUES ('test-link-only-x4kp9q2m7nf3', 'Link-Only Test Form', 'Brief 90 verification — link-only audience.', 'link-only', 'published', false, 'Submitted.', false, '00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000')
  RETURNING id
),
version_row AS (
  INSERT INTO form_versions (form_id, version_number, schema, is_draft, published_at, published_by)
  SELECT id, 1, '{
    "fields": [
      { "id": "f1", "type": "heading", "key": "h1", "label": "h1", "required": false, "level": "h2", "text": "Quick survey" },
      { "id": "f2", "type": "dropdown", "key": "satisfaction", "label": "How satisfied are you?", "required": true, "options": [{"value":"5","label":"Very satisfied"},{"value":"3","label":"Neutral"},{"value":"1","label":"Very unsatisfied"}] }
    ]
  }'::jsonb, false, now(), '00000000-0000-0000-0000-000000000000'
  FROM form_row
  RETURNING form_id, id
)
UPDATE forms SET current_version_id = version_row.id FROM version_row WHERE forms.id = version_row.form_id;
```

(Executor verifies the SQL parses; operator runs it manually in the SQL editor.)

### Phase 7 — Documentation

**File:** `PRE_DEPLOY_FORMS.md`. Section 5 ("Smoke tests") gets the Brief 90 entries:

> ### Brief 90 — public render
>
> 1. Operator runs `supabase/forms-test-data.sql` once. (Idempotent on slug — re-running fails with unique-constraint violation; operator deletes the test rows first if re-running.)
> 2. Visit `https://splash-forms.<account>.workers.dev/forms/test-public` (or staging equivalent). Expect: rendered form with Splash navy header, white-script logo, name/email/phone/location/comments fields, Turnstile widget (when `TURNSTILE_SITE_KEY` is bound).
> 3. Visit `/forms/test-internal` without `sb-access-token` cookie. Expect: 302 redirect to `/login?next=/forms/test-internal`.
> 4. Visit `/forms/test-internal` with valid cookie. Expect: rendered form with site_number text input, two lookup fields rendered DISABLED with placeholder text, issue textarea.
> 5. Visit `/forms/test-link-only-x4kp9q2m7nf3` without auth or Turnstile. Expect: rendered form. No Turnstile widget (link-only audience).
> 6. Visit `/forms/nonexistent-slug` → 404 page.
> 7. Click Submit on any test form → POST to `/forms/api/submit/{slug}` returns 404 (Brief 91 wires it).
> 8. View source on test-public page; confirm `<input type="hidden" name="pending_submission_id" value="...">` is present and contains a UUID.

**File:** `CLAUDE.md`. Append to the forms-worker glossary entry from Brief 89:

> Brief 90 wired the public render path (`GET /forms/{slug}`). Per-field-type renderers live under `apps/forms-worker/src/render/fields/` (one module per type, 16 total). Adding a 17th field type means: (1) new interface in `packages/forms-schema/src/types.ts`, (2) new Zod schema in `validators/field-config.ts`, (3) new render module in `apps/forms-worker/src/render/fields/`, (4) new dispatch case in `render/fields/index.ts`, (5) corresponding builder-side renderer + inspector in `apps/web/app/admin/forms/[id]/_field-types/` (Brief 95). The discriminated union in `Field` enforces compile-time exhaustiveness on the dispatch switch — TypeScript catches any forgotten branch.

**File:** `BUILD_STATE.md`. Bump "Last updated"; add Brief 90 Findings entry; flip Brief 90's status to `completed` in the prioritized work list.

**File:** `BRIEFS/INDEX.md`. Append Brief 90 row.

### Phase 8 — Validation

```sh
pnpm install                                                   # if zod isn't already pulled
pnpm --filter @splash/forms-schema typecheck                  # green
pnpm --filter @splash/forms-worker typecheck                  # green
pnpm --filter @splash/forms-worker exec wrangler deploy --dry-run   # green; bundle size check
pnpm typecheck                                                 # root green
```

Smoke test deferred to operator post-deploy (per Phase 7 list above).

## Configuration

No new env vars introduced (Brief 89 already declared `TURNSTILE_SITE_KEY` + `SUPABASE_URL` + `SUPABASE_SERVICE_KEY`). Operator MUST have:

- Brief 89's `supabase/forms-tables.sql` already run (forms tables exist).
- Brief 89's `SUPABASE_SERVICE_KEY` secret already bound on `splash-forms`.
- Brief 90's `supabase/forms-test-data.sql` run before smoke testing.
- (Optional but recommended for test-public smoke) `TURNSTILE_SITE_KEY` var bound on `splash-forms` — same value already set on `splash-fleet-inquiry`.

## Out of scope

- Submit handler (`POST /forms/api/submit/{slug}`) — Brief 91.
- File / signature upload behavior (the inputs render but uploads 404) — Brief 92.
- Lookup resolution (lookup fields render disabled) — Brief 93.
- Admin builder UI — Brief 95.
- Form creation via API (operator hand-creates test forms via SQL for now) — Brief 94.
- Edge caching — operator decides if needed once measured load exists.
- Real session validation on internal forms (cookie presence is the v1 render-time check) — full validation lands at submit time in Brief 91.
- Don't deploy to Cloudflare automatically — operator pushes when ready.
- Don't bind production routes — staging only per CLAUDE.md constraint #6.
- Don't add Brief 90 to QUEUE.md until operator decides to start execution.
- Don't commit to git or push.

## Definition of done

- `packages/forms-schema/src/types.ts` has the full discriminated `Field` union (16 interfaces).
- `packages/forms-schema/src/validators/field-config.ts` has Zod schemas for all 16 field types + `formSchemaSchema`.
- `apps/forms-worker/src/db/forms.ts` exports `getFormBySlug`, `getCurrentVersion`, `getLocationOptionsFromPricingSimple`.
- `apps/forms-worker/src/render/shell.ts` renders the HTML shell with Splash branding.
- `apps/forms-worker/src/render/index.ts` exports `renderFormBody`.
- `apps/forms-worker/src/render/fields/` has 16 per-type modules + `index.ts` dispatcher + `util.ts` helpers.
- `apps/forms-worker/src/index.ts` routes `GET /forms/{slug}` to the render handler; everything else 404s.
- `supabase/forms-test-data.sql` exists with the 3 test forms.
- `PRE_DEPLOY_FORMS.md` Section 5 has the Brief 90 smoke test entries.
- `CLAUDE.md` glossary entry for forms-worker is extended with the per-field-type module convention.
- `BUILD_STATE.md` + `BRIEFS/INDEX.md` updated.
- `pnpm typecheck` passes.
- `pnpm --filter @splash/forms-worker exec wrangler deploy --dry-run` succeeds.
- This brief's `Status:` flips to `Completed (YYYY-MM-DD)`.

## Report

Surface in the Outcome section:

- **Decisions made on the operator's behalf.** What `Cache-Control` value was used; whether the heading text node is `field.text` or `field.label` (the brief says `text` so labels can stay UI-only — confirm); what default `displayFormat` Location-type fields get; whether the test forms' `created_by` UUID stays as zero-uuid or gets a real super_admin uuid the executor finds.
- **`@splash/auth` cookie helpers.** Confirm `ACCESS_TOKEN_COOKIE` is the right export (Brief 1 declared it; future briefs may have shifted the name). Note the actual import path used.
- **Per-field-type module count.** Confirm 16 modules + dispatcher + util were created. Surface any field type the executor noticed needed a non-trivial divergence from the boilerplate.
- **Inline CSS size.** Final `SHELL_CSS` byte count; flag if it exceeded ~10 KB (which would suggest CSS extraction is worth doing now rather than later).
- **Latent issues addressed.** Any drift between the Brief 89 schema and what this brief actually needed (e.g., a column that turned out to be NULL-able when the brief assumed NOT NULL).
- **Smoke results, if any.** If the executor manually deployed to workers.dev and visited the test forms, surface the outcome.

## Outcome

### Files created

- `packages/forms-schema/src/validators/field-config.ts` — Zod schemas for all 16 field types (`headingFieldSchema` … `lookupFieldSchema`) plus `fieldSchema = z.discriminatedUnion("type", [...all 16])` and `formSchemaSchema = z.object({ fields: z.array(fieldSchema) })`. Common base spread inline as `fieldBaseSchema` rather than `.extend()`-chained for tighter DX.
- `apps/forms-worker/src/db/forms.ts` — three helpers using direct PostgREST `fetch()` with `SUPABASE_SERVICE_KEY` (apikey + Bearer headers): `getFormBySlug` (slug eq, single-row read, returns `FormMeta | null` via `rowToFormMeta`), `getCurrentVersion` (id eq + form_id eq, runs `formSchemaSchema.safeParse` on the JSONB schema column — runtime boundary check that prevents a hand-edited row from breaking render), `getLocationOptionsFromPricingSimple` (`pricing in.(full,partial)`, ordered by `location_code,sort`, JS-side de-dup since PostgREST `distinct` doesn't compose with multi-column selects, 5000-row safety cap).
- `apps/forms-worker/src/render/shell.ts` — `renderShell({form, bodyHtml, turnstileSiteKey?})` produces the full `<!DOCTYPE>` + `<head>` (Turnstile script included only when site key bound) + Splash navy header bar with white-script logo from `@splash/storage-r2 ASSETS.logoWhite` + `<main>` wrapper around the body. Inline `SHELL_CSS` ~70 LOC covers brand tokens, reset/base, header, form layout, field wrapper, 4 heading sizes, 3 image widths, multi checkbox group, disabled lookup, file/signature placeholders, submit button, Turnstile wrap.
- `apps/forms-worker/src/render/index.ts` — `renderFormBody({form, version, locationOptions, pendingSubmissionId, turnstileSiteKey?, urlParams})` iterates `version.schema.fields`, dispatches each to its per-type render via `renderField(field, ctx)`, wraps in `<form action="/forms/api/submit/{slug}" method="post" enctype="multipart/form-data">` with hidden `pending_submission_id` + Turnstile widget (when bound) + submit button. Exports `RenderBodyArgs` interface that the per-field modules import.
- `apps/forms-worker/src/render/util.ts` — `escapeHtml`, `fieldLabel`, `fieldHelp` helpers shared across all field modules.
- `apps/forms-worker/src/render/fields/index.ts` — exhaustive `switch (field.type)` dispatcher; the discriminated union in `Field` makes TypeScript catch any forgotten branch at compile time.
- 16 per-field-type modules under `apps/forms-worker/src/render/fields/`: `heading.ts`, `image.ts`, `name.ts`, `email.ts`, `phone.ts`, `short-text.ts`, `long-text.ts`, `hidden.ts`, `dropdown.ts`, `multi.ts`, `date.ts`, `time.ts`, `file.ts`, `signature.ts`, `location.ts`, `lookup.ts`. Each averages ~15 LOC.
- `supabase/forms-test-data.sql` — three test forms (`test-public` / `test-internal` / `test-link-only-x4kp9q2m7nf3`) with representative field-type subsets. CTE-based inserts so the deferrable `forms.current_version_id` FK is satisfied at commit time. File header documents the DELETE statement for re-runs and notes the zero-uuid placeholders for `created_by`/`last_edited_by`/`published_by`.

### Files modified

- `packages/forms-schema/src/types.ts` — Field union expanded from `Field = FieldBase` placeholder to the full 16-interface discriminated union (HeadingField / ImageField / NameField / EmailField / PhoneField / ShortTextField / LongTextField / HiddenField / DropdownField / MultiField / DateField / TimeField / FileField / SignatureField / LocationField / LookupField). `LocationOption` interface added at the bottom (used by the worker's pre-baked Location dropdown). `LookupKeyColumn` import added at the top.
- `packages/forms-schema/src/validators/index.ts` — Brief 89's `export {};` stub replaced with `export * from "./field-config.js";` per Brief 89's flagged forward note.
- `apps/forms-worker/src/index.ts` — Brief 89's 404 stub replaced with a router that handles `GET /forms/{slug}` via `handleFormRender`. Audience gate per planning Decision 8 (public → Turnstile widget when site key bound; internal → render-time `sb-access-token` cookie-presence check, 302 to `/login?next=...` on miss; link-only → slug as gate). `forms.status !== "published"` and missing `current_version_id` both 404. Location options fetched only when the schema actually contains a Location field. Response headers: `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`. The Brief 89 `Env` interface stays as-is.
- `PRE_DEPLOY_FORMS.md` — Section 5 ("Smoke tests") gained 8 entries for Brief 90: SQL fixture run, public/internal/link-only renders, the 302 to /login on missing cookie, the 404 on nonexistent slug, the 404 on POST submit (Brief 91 still pending), the hidden `pending_submission_id` verification.
- `CLAUDE.md` — forms-worker glossary entry extended with the per-field-type module convention, a 5-step recipe for adding a 17th type (TS interface in types.ts → Zod in field-config.ts → render module → dispatch case → builder-side Brief 95), the audience-gating mechanics, the `formSchemaSchema.safeParse` runtime boundary check, the direct-PostgREST-fetch (Brief 71 `maintainx-users.ts`) pattern note, the `Cache-Control: no-store` rationale, and the test-fixture pointer.
- `BUILD_STATE.md` — Last-updated bumped to Brief 90 narrative; new prioritized work list row 90; new Findings entry summarizing the work.
- `BRIEFS/INDEX.md` — Brief 90 row appended below Brief 89.

### Decisions made on the operator's behalf

1. **`Cache-Control: no-store`** chosen so re-publishing a form takes effect on the very next request. Edge caching deferred to operator measurement per the brief's "no caching at v1" stance.
2. **Heading text node is `field.text`** (not `field.label`) — matches the brief's interface declaration and keeps labels as UI-only metadata while heading text is the rendered body. The label is still escaped and emitted as `data-field-key` for builder-side reference.
3. **Default Location `displayFormat`** is required by the schema (no default — operator picks per field at form-build time); the test fixtures use `"name"` as the simplest case. The `name_and_address` and `site_number` formats fall back to just the pretty name when address/site are empty (defensive against incomplete pricing_simple rows).
4. **Test forms' `created_by` / `last_edited_by` / `published_by` UUIDs** stay as zero-uuid placeholders. `forms.created_by` has no FK to `auth.users` (loose reference per Brief 89 schema), and these are test-only rows. Consistent with Brief 89's same call.
5. **Worker DB module uses direct PostgREST `fetch()`** rather than `createClient` from `@supabase/supabase-js`. Three reasons: (i) `@supabase/supabase-js` isn't a direct dep on forms-worker (only transitively via `@splash/db-supabase`); adding direct usage would require either a package.json update or relying on a transitive dep; (ii) the existing monorepo workers all use direct fetch for service-key reads (Brief 71 `maintainx-users.ts` is the canonical reference); (iii) bundle size — the SDK is 100+ KiB, raw fetch is 0 KiB. The brief sample was a suggested shape, not a contract.
6. **Multi-field rendered as `<fieldset>` + `<legend>` + checkbox group** with shared `name` so FormData's `getAll(name)` returns the array. HTML5 `required` on multi-checkboxes is unreliable across browsers; submit-time validation (Brief 91) is the authoritative gate for `required` + `minSelected` + `maxSelected`.
7. **Lookup field's `data-*` attributes carry full source metadata** (`data-lookup-source-table`, `-source-column`, `-key-column`, `-resolution-mode`, `-null-behavior`, plus `data-lookup-key-field` for the key field's id) so Brief 93's client-side wiring can read everything from the DOM without a second schema fetch.
8. **Image field renders against placeholder URL `/forms/api/asset/{form_id}/{assetId}`** — Brief 92's R2-backed asset serving will fulfill that route. Brief 90 image fields will 404 in the browser (broken-image icon) but the rest of the form renders fine.
9. **`formSchemaSchema.safeParse` runs in `getCurrentVersion`**, NOT in the route handler — keeps the boundary check colocated with the data read so a future Brief 96 admin-side preview that reuses `getCurrentVersion` automatically benefits.
10. **`fieldBaseSchema` spread inline rather than `.extend()`-chained** — the discriminated-union approach in Zod requires every variant to be a `z.object`, and spreading the shape avoids two extra layers of indirection per type. Cosmetic but cleaner.

### `@splash/auth` cookie helpers

`ACCESS_TOKEN_COOKIE` is the right export — declared in `packages/auth/src/cookies.ts` L8 with value `"sb-access-token"` and re-exported via `packages/auth/src/index.ts` (`export * from "./cookies.js"`). Imported as `import { ACCESS_TOKEN_COOKIE } from "@splash/auth";` in `apps/forms-worker/src/index.ts`. Used in the audience gate's cookie-substring check: `cookies.includes(`${ACCESS_TOKEN_COOKIE}=`)`.

### Per-field-type module count

Confirmed: 16 modules + dispatcher (`fields/index.ts`) + util + shell + body = **19 files** under `apps/forms-worker/src/render/`. No field type required a non-trivial divergence from the boilerplate. Multi was the slightly unusual case (fieldset/legend/checkbox group instead of single input) but stayed in the 30-line range. Heading and Image are display-only with no input element. Hidden has no label/help wrapper at all (just `<input type="hidden">`).

### Inline CSS size

`SHELL_CSS` final byte count: ~3.2 KB (~70 LOC). Comfortably under the 10 KB threshold the brief flagged for "consider extracting now." Staying inline matches the fleet/signup posture and keeps TTFB fast (no second round trip for a CSS asset).

### Latent issues addressed

1. **Brief 89's `validators/index.ts` `export {};` stub** had to be REPLACED with a real re-export — the brief explicitly called this out as a forward note and Brief 90 followed the guidance.
2. **The `Field = FieldBase` placeholder in `types.ts`** was REPLACED with the discriminated union — that's a load-bearing replacement, not an extension. Verified no other files imported `Field` expecting the old shape (grep across packages/, apps/ returned no consumers beyond the new render dispatcher and the Zod schemas).
3. **`forms-test-data.sql` had to use CTE-style inserts** because the `forms.current_version_id` FK is `DEFERRABLE INITIALLY DEFERRED` but a single INSERT-then-UPDATE chain can't satisfy the circular reference within one statement. The CTE chain inserts the form, inserts the version (which references form_id), then UPDATEs the form's `current_version_id` to the new version's id — all within one transaction.
4. **`tsc --noEmit` strict mode caught three `noUncheckedIndexedAccess` issues** during validation (rows[0] is `Row | undefined`; regex match groups are `string | undefined`). Fixed by introducing local `const row = rows[0]; if (!row) return null;` lines and adding a `renderMatch[1] &&` guard in the route check.

### Smoke results

No manual deploy by executor — operator runs the SQL fixture and `wrangler deploy` themselves per the brief's "Don't deploy to Cloudflare automatically" line. Smoke testing deferred to operator post-deploy via the new PRE_DEPLOY_FORMS.md Section 5 entries.

### Validation results

| Step | Result |
|---|---|
| `pnpm --filter @splash/forms-schema typecheck` | green |
| `pnpm --filter @splash/forms-worker typecheck` | green (after fixing 3 strict-mode `noUncheckedIndexedAccess` issues) |
| `pnpm --filter @splash/forms-worker exec wrangler deploy --dry-run` | green — Total Upload: **152.42 KiB / 27.04 KiB gzipped**. Bindings resolved: FORMS_FILES R2 bucket, SUPABASE_URL var, TURNSTILE_SITE_KEY var |
| `pnpm typecheck` (root) | green — **17/17 packages successful** (6 cached, 11 cache-missed and re-ran) |

### Bundle observation

Forms-worker bundle grew from Brief 89's 0.34 KiB / 0.26 KiB gzip to 152.42 KiB / 27.04 KiB gzip. The growth is `zod` (~50 KiB minified raw, ~12 KiB gzipped) plus the 16 render modules + shell CSS (~30 KiB raw). Comfortably inside CF's 3 MiB compressed free-tier limit.

### Prep work surfaced for future briefs

- Brief 91 must validate the `pending_submission_id` UUID at submit time and use it for the `INSERT ... ON CONFLICT (id) DO NOTHING` idempotency pattern Brief 89 set up. The hidden input in `render/index.ts` carries it through to the form POST body.
- Brief 92's image-field placeholder URL convention (`/forms/api/asset/{form_id}/{assetId}`) and signature/file render markup is in place — Brief 92 needs to wire the `<canvas>` to signature_pad and the file inputs to the upload endpoint without changing the rendered HTML.
- Brief 93's lookup wiring needs the `data-lookup-*` attributes on the lookup field's wrapper div (already there: `data-lookup-key-field`, `-key-column`, `-source-table`, `-source-column`, `-resolution-mode`, `-null-behavior`).
- Brief 95's admin-side preview can reuse the worker's render path via either an iframe to a preview route on splash-forms or by bundling a worker-equivalent renderer into apps/web. The per-field-type module split makes the latter easier — each module is a string-returning function with no side effects, importable wherever.
