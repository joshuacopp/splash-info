// Field type discriminator. Order intentional — display-only types last.
import type { LookupKeyColumn } from "./lookup-sources.js";

export type FieldType =
  | "name"
  | "email"
  | "phone"
  | "short_text"
  | "long_text"
  | "dropdown"
  | "multi"
  | "file"
  | "date"
  | "time"
  | "signature"
  | "lookup"
  | "location"
  | "hidden"
  | "heading"      // display-only, no payload
  | "image";       // display-only, no payload

// Common base every field type extends.
export interface FieldBase {
  id: string;          // UUID, stable for the field's lifetime within draft
  type: FieldType;
  key: string;         // stable slug, operator-editable, snake_case, unique within form
  label: string;
  required: boolean;   // ignored on display-only types (heading, image)
  helpText?: string;
}

// -----------------------------------------------------------------------------
// Display-only types (no payload)
// -----------------------------------------------------------------------------

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

// -----------------------------------------------------------------------------
// Text inputs
// -----------------------------------------------------------------------------

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

// -----------------------------------------------------------------------------
// Choice
// -----------------------------------------------------------------------------

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

// -----------------------------------------------------------------------------
// Date / Time — native HTML inputs
// -----------------------------------------------------------------------------

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

// -----------------------------------------------------------------------------
// File upload — Brief 92 wires the upload behavior
// -----------------------------------------------------------------------------

export interface FileField extends FieldBase {
  type: "file";
  maxSizeMb?: number;             // default 10, hard ceiling 25 enforced server-side
  allowedMimeTypes?: string[];    // default ["image/*", "application/pdf"]
  allowMultiple?: boolean;        // default false
}

// -----------------------------------------------------------------------------
// Signature — Brief 92 wires the canvas
// -----------------------------------------------------------------------------

export interface SignatureField extends FieldBase {
  type: "signature";
  format: "png" | "svg";   // default "png"
  penColor?: string;       // default "#000000"
  minStrokes?: number;     // default 1
}

// -----------------------------------------------------------------------------
// Location picker — special-case dropdown sourced from pricing_simple
// -----------------------------------------------------------------------------

export interface LocationField extends FieldBase {
  type: "location";
  displayFormat: "name" | "name_and_address" | "site_number";
  // Payload value is always the location_code slug regardless of displayFormat.
}

// -----------------------------------------------------------------------------
// Lookup — Brief 93 wires the resolver
// -----------------------------------------------------------------------------

export type LookupResolutionMode = "prefill_hidden" | "prefill_visible" | "display_only";
export type LookupNullBehavior = "allow_empty" | "block_submit";

export interface LookupField extends FieldBase {
  type: "lookup";
  keyFieldId: string;                      // FK to another field's `id` in this form
  keyColumn: LookupKeyColumn;              // imported from lookup-sources
  sourceTable: "pricing_simple" | "locations";
  sourceColumn: string;                    // must appear in LOOKUP_SOURCES
  resolutionMode: LookupResolutionMode;
  nullBehavior: LookupNullBehavior;
}

// -----------------------------------------------------------------------------
// The full discriminated union.
// -----------------------------------------------------------------------------

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

// Form schema = ordered list of fields. Order is implicit (array index).
export interface FormSchema {
  fields: Field[];
}

export interface FormVersion {
  id: string;
  formId: string;
  versionNumber: number;
  schema: FormSchema;
  isDraft: boolean;
  publishedAt: string | null;
  publishedBy: string | null;
}

export interface FormMeta {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  audience: "public" | "internal" | "link-only";
  status: "draft" | "published" | "archived";
  currentVersionId: string | null;
  draftVersionId: string | null;
  notifyWebhook: boolean;
  successMessage: string | null;
  turnstileRequired: boolean;
}

// Submission payload is keyed by field.key. Per-field value shape varies
// by field type (string for text fields, string[] for multi, object for
// file/signature, etc. — Brief 91 narrows these via Zod).
export type SubmissionPayload = Record<string, unknown>;

export interface FormSubmission {
  id: string;
  formId: string;
  formVersionId: string;
  payload: SubmissionPayload;
  submitterKind: "authenticated" | "anonymous";
  submitterUserId: string | null;
  submitterEmail: string | null;
  submitterIp: string | null;
  submittedAt: string;
  status: "new" | "in_progress" | "closed";
  splashNotes: string | null;
}

// Location options pre-baked into the Location field's <select> at render time.
// Sourced from pricing_simple via the worker's `getLocationOptionsFromPricingSimple`
// helper. Brief 90 inlines these into the rendered HTML — no client-side fetch.
export interface LocationOption {
  code: string;     // pricing_simple.location_code (slug)
  pretty: string;   // pricing_simple.location_pretty
  address: string;  // pricing_simple.address
  site: string;     // pricing_simple.site (3-digit text)
}
