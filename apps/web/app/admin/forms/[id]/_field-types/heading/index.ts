import type { HeadingField } from "@splash/forms-schema";

export const type = "heading" as const;
export const label = "Heading";
export const defaultConfig: Omit<HeadingField, "id" | "key"> = {
  type: "heading",
  label: "Heading",
  required: false,
  level: "h2",
  text: "Section heading"
};

export { default as Renderer } from "./Renderer";
export { default as Inspector } from "./Inspector";
