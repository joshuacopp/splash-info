import type { LookupField } from "@splash/forms-schema";

export const type = "lookup" as const;
export const label = "Lookup";
export const defaultConfig: Omit<LookupField, "id" | "key"> = {
  type: "lookup",
  label: "Lookup",
  required: false,
  helpText: undefined,
  keyFieldId: "",
  keyColumn: "pricing_simple.location_code",
  sourceTable: "pricing_simple",
  sourceColumn: "",
  resolutionMode: "prefill_visible",
  nullBehavior: "allow_empty"
};

export { default as Renderer } from "./Renderer";
export { default as Inspector } from "./Inspector";
