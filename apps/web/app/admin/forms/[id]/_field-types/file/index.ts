import type { FileField } from "@splash/forms-schema";

export const type = "file" as const;
export const label = "File upload";
export const defaultConfig: Omit<FileField, "id" | "key"> = {
  type: "file",
  label: "Upload a file",
  required: false,
  helpText: undefined,
  maxSizeMb: 10,
  allowedMimeTypes: ["image/*", "application/pdf"],
  allowMultiple: false
};

export { default as Renderer } from "./Renderer";
export { default as Inspector } from "./Inspector";
