import type { AttendanceField } from "@splash/forms-schema";

export const type = "attendance" as const;
export const label = "Attendance sheet";
export const defaultConfig: Omit<AttendanceField, "id" | "key"> = {
  type: "attendance",
  label: "Employees in attendance",
  required: true,
  helpText: undefined,
  keyFieldKey: "",
  keyColumn: "pricing_simple.site",
  allowTyped: true,
  initialRows: 5
};

export { default as Renderer } from "./Renderer";
export { default as Inspector } from "./Inspector";
