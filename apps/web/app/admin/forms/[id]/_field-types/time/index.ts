import type { TimeField } from "@splash/forms-schema";

export const type = "time" as const;
export const label = "Time";
export const defaultConfig: Omit<TimeField, "id" | "key"> = {
  type: "time",
  label: "Time",
  required: false,
  helpText: undefined,
  minTime: undefined,
  maxTime: undefined
};

export { default as Renderer } from "./Renderer";
export { default as Inspector } from "./Inspector";
