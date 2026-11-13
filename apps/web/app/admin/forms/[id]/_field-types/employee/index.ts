import type { EmployeeField } from "@splash/forms-schema";

export const type = "employee" as const;
export const label = "Employee";
export const defaultConfig: Omit<EmployeeField, "id" | "key"> = {
  type: "employee",
  label: "Employee",
  required: true,
  helpText: undefined,
  keyFieldKey: "",
  keyColumn: "pricing_simple.site",
  allowTyped: true
};

export { default as Renderer } from "./Renderer";
export { default as Inspector } from "./Inspector";
