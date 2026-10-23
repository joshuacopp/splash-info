import type { PackagePriceGridField } from "@splash/forms-schema";

export const type = "package_price_grid" as const;
export const label = "Package price grid";
export const defaultConfig: Omit<PackagePriceGridField, "id" | "key"> = {
  type: "package_price_grid",
  label: "Packages affected",
  required: true,
  helpText: undefined,
  keyFieldKey: "",
  keyColumn: "pricing_simple.site"
};

export { default as Renderer } from "./Renderer";
export { default as Inspector } from "./Inspector";
