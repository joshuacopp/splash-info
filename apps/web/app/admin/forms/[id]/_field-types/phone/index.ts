import type { PhoneField } from "@splash/forms-schema";

export const type = "phone" as const;
export const label = "Phone";
export const defaultConfig: Omit<PhoneField, "id" | "key"> = {
  type: "phone",
  label: "Phone",
  required: true,
  helpText: undefined
};

export { default as Renderer } from "./Renderer";
export { default as Inspector } from "./Inspector";
