import type { LocationField } from "@splash/forms-schema";

export const type = "location" as const;
export const label = "Location picker";
export const defaultConfig: Omit<LocationField, "id" | "key"> = {
  type: "location",
  label: "Location",
  required: true,
  helpText: undefined,
  displayFormat: "name"
};

export { default as Renderer } from "./Renderer";
export { default as Inspector } from "./Inspector";
