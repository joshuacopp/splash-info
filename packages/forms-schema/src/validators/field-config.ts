// Per-field-type Zod validators (Brief 90 — render-time + builder-save-time
// configuration validation). Brief 91 will add the submit-time PAYLOAD
// validators in a sibling file (`payload.ts`). This file validates that a
// field's CONFIG (the object stored under `form_versions.schema.fields[i]`)
// is well-formed.
//
// Why both compile-time TypeScript types AND runtime Zod: the typed
// `Field` discriminated union in `types.ts` enforces shape inside the
// monorepo, but `form_versions.schema` is JSONB read at request time —
// nothing prevents a hand-edited row from breaking the contract. The
// `formSchemaSchema` parse in the worker's render path is the boundary
// check; if it fails, the worker can 500 with a precise error rather
// than render half a form.

import { z } from "zod";

// Common base every field-config schema spreads in.
const fieldBaseSchema = {
  id: z.string().min(1),
  key: z.string().regex(/^[a-z][a-z0-9_]*$/, "snake_case slug, leading non-digit"),
  label: z.string().min(1),
  required: z.boolean(),
  helpText: z.string().optional()
};

const dropdownOptionSchema = z.object({
  value: z.string(),
  label: z.string()
});

// -----------------------------------------------------------------------------
// Display-only types (no payload)
// -----------------------------------------------------------------------------

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

// -----------------------------------------------------------------------------
// Text inputs
// -----------------------------------------------------------------------------

export const nameFieldSchema = z.object({
  ...fieldBaseSchema,
  type: z.literal("name"),
  maxLength: z.number().int().positive().optional()
});

export const emailFieldSchema = z.object({
  ...fieldBaseSchema,
  type: z.literal("email"),
  maxLength: z.number().int().positive().optional()
});

export const phoneFieldSchema = z.object({
  ...fieldBaseSchema,
  type: z.literal("phone")
});

export const shortTextFieldSchema = z.object({
  ...fieldBaseSchema,
  type: z.literal("short_text"),
  maxLength: z.number().int().positive().optional(),
  placeholder: z.string().optional()
});

export const longTextFieldSchema = z.object({
  ...fieldBaseSchema,
  type: z.literal("long_text"),
  maxLength: z.number().int().positive().optional(),
  placeholder: z.string().optional(),
  rows: z.number().int().positive().optional()
});

export const hiddenFieldSchema = z.object({
  ...fieldBaseSchema,
  type: z.literal("hidden"),
  defaultValueFromUrlParam: z.string().optional(),
  defaultValue: z.string().optional()
});

// -----------------------------------------------------------------------------
// Choice
// -----------------------------------------------------------------------------

export const dropdownFieldSchema = z.object({
  ...fieldBaseSchema,
  type: z.literal("dropdown"),
  options: z.array(dropdownOptionSchema),
  placeholder: z.string().optional()
});

export const multiFieldSchema = z.object({
  ...fieldBaseSchema,
  type: z.literal("multi"),
  options: z.array(dropdownOptionSchema),
  minSelected: z.number().int().nonnegative().optional(),
  maxSelected: z.number().int().positive().optional()
});

// -----------------------------------------------------------------------------
// Date / Time
// -----------------------------------------------------------------------------

export const dateFieldSchema = z.object({
  ...fieldBaseSchema,
  type: z.literal("date"),
  minDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  maxDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  defaultToToday: z.boolean().optional()
});

export const timeFieldSchema = z.object({
  ...fieldBaseSchema,
  type: z.literal("time"),
  minTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  maxTime: z.string().regex(/^\d{2}:\d{2}$/).optional()
});

// -----------------------------------------------------------------------------
// File / signature — Brief 92 wires functional behavior; Brief 90 just
// validates the config shape so the render-time defensive check passes.
// -----------------------------------------------------------------------------

export const fileFieldSchema = z.object({
  ...fieldBaseSchema,
  type: z.literal("file"),
  maxSizeMb: z.number().int().positive().optional(),
  allowedMimeTypes: z.array(z.string()).optional(),
  allowMultiple: z.boolean().optional()
});

export const signatureFieldSchema = z.object({
  ...fieldBaseSchema,
  type: z.literal("signature"),
  format: z.enum(["png", "svg"]),
  penColor: z.string().optional(),
  minStrokes: z.number().int().positive().optional()
});

// -----------------------------------------------------------------------------
// Location / Lookup
// -----------------------------------------------------------------------------

export const locationFieldSchema = z.object({
  ...fieldBaseSchema,
  type: z.literal("location"),
  displayFormat: z.enum(["name", "name_and_address", "site_number"])
});

export const lookupFieldSchema = z.object({
  ...fieldBaseSchema,
  type: z.literal("lookup"),
  keyFieldId: z.string().min(1),
  keyColumn: z.enum(["pricing_simple.location_code", "pricing_simple.site"]),
  sourceTable: z.enum(["pricing_simple", "locations"]),
  sourceColumn: z.string().min(1),
  resolutionMode: z.enum(["prefill_hidden", "prefill_visible", "display_only"]),
  nullBehavior: z.enum(["allow_empty", "block_submit"])
});

// -----------------------------------------------------------------------------
// Discriminated union + form schema
// -----------------------------------------------------------------------------

export const fieldSchema = z.discriminatedUnion("type", [
  headingFieldSchema,
  imageFieldSchema,
  nameFieldSchema,
  emailFieldSchema,
  phoneFieldSchema,
  shortTextFieldSchema,
  longTextFieldSchema,
  hiddenFieldSchema,
  dropdownFieldSchema,
  multiFieldSchema,
  dateFieldSchema,
  timeFieldSchema,
  fileFieldSchema,
  signatureFieldSchema,
  locationFieldSchema,
  lookupFieldSchema
]);

export const formSchemaSchema = z.object({
  fields: z.array(fieldSchema)
});

// -----------------------------------------------------------------------------
// Draft schema — lenient variant for save-draft
// -----------------------------------------------------------------------------
//
// Drafts are work-in-progress: the operator may add a Lookup field and click
// Save Draft before they've picked a key field or source column. The strict
// `formSchemaSchema` above (used at render time + at publish time) requires
// those user-config fields to be non-empty / well-formed. The default config
// for `lookup` / `image` fields seeds them with empty strings, so a strict
// validation would 422 the moment the field hits the canvas.
//
// This draft variant relaxes ONLY the user-config strings that have no
// sensible default (keyFieldId, sourceColumn, assetId, altText, label, text)
// to plain `z.string()`. Discriminator literals, enum-typed config, and
// structural invariants (id, key regex) stay strict — those errors point at
// builder bugs, not work-in-progress.
//
// Publish re-validates against `formSchemaSchema` before promoting the draft,
// so anything that's draft-only-valid will surface a 422 at publish time
// instead of letting a half-configured field reach public render.

const fieldBaseSchemaDraft = {
  id: z.string().min(1),
  key: z.string().regex(/^[a-z][a-z0-9_]*$/, "snake_case slug, leading non-digit"),
  label: z.string(),
  required: z.boolean(),
  helpText: z.string().optional()
};

const headingFieldSchemaDraft = z.object({
  ...fieldBaseSchemaDraft,
  type: z.literal("heading"),
  level: z.enum(["h1", "h2", "h3", "h4"]),
  text: z.string()
});

const imageFieldSchemaDraft = z.object({
  ...fieldBaseSchemaDraft,
  type: z.literal("image"),
  assetId: z.string(),
  altText: z.string(),
  caption: z.string().optional(),
  maxWidth: z.enum(["small", "medium", "full"])
});

const nameFieldSchemaDraft = z.object({
  ...fieldBaseSchemaDraft,
  type: z.literal("name"),
  maxLength: z.number().int().positive().optional()
});

const emailFieldSchemaDraft = z.object({
  ...fieldBaseSchemaDraft,
  type: z.literal("email"),
  maxLength: z.number().int().positive().optional()
});

const phoneFieldSchemaDraft = z.object({
  ...fieldBaseSchemaDraft,
  type: z.literal("phone")
});

const shortTextFieldSchemaDraft = z.object({
  ...fieldBaseSchemaDraft,
  type: z.literal("short_text"),
  maxLength: z.number().int().positive().optional(),
  placeholder: z.string().optional()
});

const longTextFieldSchemaDraft = z.object({
  ...fieldBaseSchemaDraft,
  type: z.literal("long_text"),
  maxLength: z.number().int().positive().optional(),
  placeholder: z.string().optional(),
  rows: z.number().int().positive().optional()
});

const hiddenFieldSchemaDraft = z.object({
  ...fieldBaseSchemaDraft,
  type: z.literal("hidden"),
  defaultValueFromUrlParam: z.string().optional(),
  defaultValue: z.string().optional()
});

const dropdownFieldSchemaDraft = z.object({
  ...fieldBaseSchemaDraft,
  type: z.literal("dropdown"),
  options: z.array(dropdownOptionSchema),
  placeholder: z.string().optional()
});

const multiFieldSchemaDraft = z.object({
  ...fieldBaseSchemaDraft,
  type: z.literal("multi"),
  options: z.array(dropdownOptionSchema),
  minSelected: z.number().int().nonnegative().optional(),
  maxSelected: z.number().int().positive().optional()
});

const dateFieldSchemaDraft = z.object({
  ...fieldBaseSchemaDraft,
  type: z.literal("date"),
  minDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  maxDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  defaultToToday: z.boolean().optional()
});

const timeFieldSchemaDraft = z.object({
  ...fieldBaseSchemaDraft,
  type: z.literal("time"),
  minTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  maxTime: z.string().regex(/^\d{2}:\d{2}$/).optional()
});

const fileFieldSchemaDraft = z.object({
  ...fieldBaseSchemaDraft,
  type: z.literal("file"),
  maxSizeMb: z.number().int().positive().optional(),
  allowedMimeTypes: z.array(z.string()).optional(),
  allowMultiple: z.boolean().optional()
});

const signatureFieldSchemaDraft = z.object({
  ...fieldBaseSchemaDraft,
  type: z.literal("signature"),
  format: z.enum(["png", "svg"]),
  penColor: z.string().optional(),
  minStrokes: z.number().int().positive().optional()
});

const locationFieldSchemaDraft = z.object({
  ...fieldBaseSchemaDraft,
  type: z.literal("location"),
  displayFormat: z.enum(["name", "name_and_address", "site_number"])
});

const lookupFieldSchemaDraft = z.object({
  ...fieldBaseSchemaDraft,
  type: z.literal("lookup"),
  keyFieldId: z.string(),
  keyColumn: z.enum(["pricing_simple.location_code", "pricing_simple.site"]),
  sourceTable: z.enum(["pricing_simple", "locations"]),
  sourceColumn: z.string(),
  resolutionMode: z.enum(["prefill_hidden", "prefill_visible", "display_only"]),
  nullBehavior: z.enum(["allow_empty", "block_submit"])
});

export const fieldSchemaDraft = z.discriminatedUnion("type", [
  headingFieldSchemaDraft,
  imageFieldSchemaDraft,
  nameFieldSchemaDraft,
  emailFieldSchemaDraft,
  phoneFieldSchemaDraft,
  shortTextFieldSchemaDraft,
  longTextFieldSchemaDraft,
  hiddenFieldSchemaDraft,
  dropdownFieldSchemaDraft,
  multiFieldSchemaDraft,
  dateFieldSchemaDraft,
  timeFieldSchemaDraft,
  fileFieldSchemaDraft,
  signatureFieldSchemaDraft,
  locationFieldSchemaDraft,
  lookupFieldSchemaDraft
]);

export const draftFormSchemaSchema = z.object({
  fields: z.array(fieldSchemaDraft)
});
