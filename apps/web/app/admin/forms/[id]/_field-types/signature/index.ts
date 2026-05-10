import type { SignatureField } from "@splash/forms-schema";

export const type = "signature" as const;
export const label = "Signature";
export const defaultConfig: Omit<SignatureField, "id" | "key"> = {
  type: "signature",
  label: "Signature",
  required: true,
  helpText: undefined,
  format: "png",
  penColor: "#000000",
  minStrokes: 1
};

export { default as Renderer } from "./Renderer";
export { default as Inspector } from "./Inspector";
