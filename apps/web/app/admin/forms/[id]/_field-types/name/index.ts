import type { NameField } from "@splash/forms-schema";

export const type = "name" as const;
export const label = "Name";
export const defaultConfig: Omit<NameField, "id" | "key"> = {
  type: "name",
  label: "Name",
  required: true,
  helpText: undefined,
  maxLength: 120
};

export { default as Renderer } from "./Renderer";
export { default as Inspector } from "./Inspector";
