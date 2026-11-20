import type { RequiredTopicsField } from "@splash/forms-schema";

export const type = "required_topics" as const;
export const label = "Required topics (monthly)";
export const defaultConfig: Omit<RequiredTopicsField, "id" | "key"> = {
  type: "required_topics",
  label: "Required topics this month",
  required: true,
  helpText: undefined,
  listKey: "safety_meeting",
  dateFieldKey: ""
};

export { default as Renderer } from "./Renderer";
export { default as Inspector } from "./Inspector";
