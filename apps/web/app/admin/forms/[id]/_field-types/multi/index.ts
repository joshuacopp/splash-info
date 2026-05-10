import type { MultiField } from "@splash/forms-schema";

export const type = "multi" as const;
export const label = "Multi-select";
export const defaultConfig: Omit<MultiField, "id" | "key"> = {
  type: "multi",
  label: "Choose any",
  required: false,
  helpText: undefined,
  options: [
    { value: "option_1", label: "Option 1" },
    { value: "option_2", label: "Option 2" }
  ],
  minSelected: 0,
  maxSelected: undefined
};

export { default as Renderer } from "./Renderer";
export { default as Inspector } from "./Inspector";
