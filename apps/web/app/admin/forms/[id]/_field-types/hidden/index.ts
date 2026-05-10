import type { HiddenField } from "@splash/forms-schema";

export const type = "hidden" as const;
export const label = "Hidden";
export const defaultConfig: Omit<HiddenField, "id" | "key"> = {
  type: "hidden",
  label: "Hidden field",
  required: false,
  defaultValueFromUrlParam: undefined,
  defaultValue: undefined
};

export { default as Renderer } from "./Renderer";
export { default as Inspector } from "./Inspector";
