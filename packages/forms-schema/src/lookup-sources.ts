// LOOKUP_SOURCES — the registry of columns operators can configure as
// the source of a Lookup field's resolved value. Hardcoded (NOT
// information_schema-derived) per planning Decision 5c so we control:
//   1. exclusion of system fields (id, created_at, internal join keys)
//   2. exclusion of columns that don't make sense as form-builder lookups
//      (mla_location boolean, etc.)
//   3. labels matching operator vocabulary, not column vocabulary —
//      `am_email` is "Regional Director email" per the Brief 59 RD/RM
//      label convention; `rm_email` is "Regional Manager email"; column
//      names stay as-is because trg_sync_pricing_simple +
//      trg_sync_user_permissions depend on them.
//
// Per planning Decision 5 (corrected): the keyColumn is configurable —
// operators can join on `pricing_simple.location_code` (slug) OR
// `pricing_simple.site` (3-digit text, equivalent to
// `locations.site_number`). The resolver helper hides the two-hop join
// when the source table is `locations`.
//
// `column` is the literal Postgres column name (kept verbatim so SQL
// resolution doesn't need a column-name translation table).
// `label` is what operators see in the inspector dropdown.
// `description` (optional) shows as inspector hint text.

export interface LookupSource {
  table: "pricing_simple" | "locations";
  column: string;
  label: string;
  description?: string;
  type: "string" | "boolean";
}

export const LOOKUP_SOURCES: readonly LookupSource[] = [
  // pricing_simple
  { table: "pricing_simple", column: "location_pretty",  label: "Location display name",            type: "string" },
  { table: "pricing_simple", column: "site",             label: "Location name (e.g. \"Oswego\")",  type: "string" },
  { table: "pricing_simple", column: "address",          label: "Location postal address",          type: "string" },
  { table: "pricing_simple", column: "am_email",         label: "Regional Director email",          type: "string", description: "Per Brief 59 label convention; column name remains am_email." },
  { table: "pricing_simple", column: "rm_email",         label: "Regional Manager email",           type: "string", description: "Per Brief 59 label convention; column name remains rm_email." },
  { table: "pricing_simple", column: "site_email",       label: "Site contact email",               type: "string" },
  { table: "pricing_simple", column: "area_manager",     label: "Regional Director name",           type: "string", description: "Per Brief 59 label convention." },
  { table: "pricing_simple", column: "regional_manager", label: "Regional Manager name",            type: "string", description: "Per Brief 59 label convention." },
  // locations (joined via pricing_simple.location_code → pricing_simple.site → locations.site_number)
  { table: "locations",      column: "hrt_email",        label: "HRT email",                        type: "string" },
  { table: "locations",      column: "rm_group",         label: "RM group",                         type: "string" },
  { table: "locations",      column: "mla_location",     label: "MLA location flag",                type: "boolean" }
] as const;

// keyColumn options — operator picks which DB column to join on.
// `pricing_simple.site` and `locations.site_number` are the same value
// (3-digit string text), so operators can use either depending on which
// table they're sourcing from. `pricing_simple.location_code` is the
// canonical slug (e.g. "oswego").
export type LookupKeyColumn =
  | "pricing_simple.location_code"
  | "pricing_simple.site";       // = locations.site_number
