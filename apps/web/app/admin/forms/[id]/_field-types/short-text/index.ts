import type { ShortTextField } from "@splash/forms-schema";

export const type = "short_text" as const;
export const label = "Short text";
export const defaultConfig: Omit<ShortTextField, "id" | "key"> = {
  type: "short_text",
  label: "Short text",
  required: false,
  helpText: undefined,
  maxLength: 500,
  placeholder: undefined
};

export { default as Renderer } from "./Renderer";
export { default as Inspector } from "./Inspector";
