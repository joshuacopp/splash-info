import type { LongTextField } from "@splash/forms-schema";

export const type = "long_text" as const;
export const label = "Long text";
export const defaultConfig: Omit<LongTextField, "id" | "key"> = {
  type: "long_text",
  label: "Long text",
  required: false,
  helpText: undefined,
  maxLength: 10000,
  placeholder: undefined,
  rows: 4
};

export { default as Renderer } from "./Renderer";
export { default as Inspector } from "./Inspector";
