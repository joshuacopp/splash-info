import type { RadioField } from "@splash/forms-schema";

export const type = "radio" as const;
export const label = "Radio group";
export const defaultConfig: Omit<RadioField, "id" | "key"> = {
  type: "radio",
  label: "Choose one",
  required: false,
  helpText: undefined,
  options: [
    { value: "option_1", label: "Option 1" },
    { value: "option_2", label: "Option 2" }
  ],
  // Vertical by default: inline only reads well with short labels and few
  // options. The operator opts into inline for Pass/Fail/NA-shaped questions.
  layout: "vertical"
};

export { default as Renderer } from "./Renderer";
export { default as Inspector } from "./Inspector";
