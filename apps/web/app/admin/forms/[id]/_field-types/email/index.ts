import type { EmailField } from "@splash/forms-schema";

export const type = "email" as const;
export const label = "Email";
export const defaultConfig: Omit<EmailField, "id" | "key"> = {
  type: "email",
  label: "Email",
  required: true,
  helpText: undefined,
  maxLength: 254
};

export { default as Renderer } from "./Renderer";
export { default as Inspector } from "./Inspector";
