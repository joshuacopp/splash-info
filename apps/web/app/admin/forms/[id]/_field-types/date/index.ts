import type { DateField } from "@splash/forms-schema";

export const type = "date" as const;
export const label = "Date";
export const defaultConfig: Omit<DateField, "id" | "key"> = {
  type: "date",
  label: "Date",
  required: false,
  helpText: undefined,
  minDate: undefined,
  maxDate: undefined,
  defaultToToday: false
};

export { default as Renderer } from "./Renderer";
export { default as Inspector } from "./Inspector";
