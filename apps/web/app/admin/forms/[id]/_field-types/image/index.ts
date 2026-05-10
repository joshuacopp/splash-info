import type { ImageField } from "@splash/forms-schema";

export const type = "image" as const;
export const label = "Image";
export const defaultConfig: Omit<ImageField, "id" | "key"> = {
  type: "image",
  label: "Image",
  required: false,
  assetId: "",
  altText: "",
  caption: undefined,
  maxWidth: "medium"
};

export { default as Renderer } from "./Renderer";
export { default as Inspector } from "./Inspector";
