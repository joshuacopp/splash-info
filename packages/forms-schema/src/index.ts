// @splash/forms-schema — shared schema contract for the form-builder feature.
//
// Both apps/web (builder, React) and `splash-forms` (public renderer,
// server-rendered HTML + per-field-type vanilla JS) consume this package.
// Two renderers, one schema contract — this package prevents drift between
// preview and production.
//
// Brief 89 (this brief) lays down the type skeleton + LOOKUP_SOURCES const +
// stub Zod validators. Subsequent briefs extend per-field-type validation:
//   Brief 90 — adds runtime Zod for the 14 field types' render-time validation.
//   Brief 91 — adds payload-validation Zod for submit-time enforcement.
//   Brief 93 — adds the lookup-source-aware schemas.
//
// Field types per planning Decision 4 + refinements (16 total):
//   name, email, phone, short_text, long_text, heading, dropdown, multi,
//   image, file, date, time, signature, lookup, location, hidden
// ("image" + "heading" are display-only and produce no payload;
//  "lookup" + "location" + "hidden" were added in planning conversation
//  refinements to the original 12 — see Architecture context above.)

export * from "./types.js";
export * from "./lookup-sources.js";
export * from "./validators/index.js";
