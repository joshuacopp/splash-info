import type { DropdownField } from "@splash/forms-schema";

export const type = "dropdown" as const;
export const label = "Dropdown";
export const defaultConfig: Omit<DropdownField, "id" | "key"> = {
  type: "dropdown",
  label: "Choose one",
  required: false,
  helpText: undefined,
  options: [
    { value: "option_1", label: "Option 1" },
    { value: "option_2", label: "Option 2" }
  ],
  placeholder: undefined
};

export { default as Renderer } from "./Renderer";
export { default as Inspector } from "./Inspector";
