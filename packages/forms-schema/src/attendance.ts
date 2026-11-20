// Attendance field (2026-11-18, Monthly Safety Meeting) -- payload shape and
// the ONE formatter every surface uses (detail page, wide table, CSV, PDF,
// workflow emails), same reasoning as employee.ts / package-price.ts.

// Type-only import: apps/web imports this file through the
// `@splash/forms-schema/attendance` subpath, and Next's webpack cannot resolve
// a runtime `.js` specifier there (see CLAUDE.md, package_price_grid).
import type { EmployeeValue } from "./employee.js";

function isEmployeeLike(v: unknown): v is EmployeeValue {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return typeof o.name === "string" && (o.id === null || typeof o.id === "string") && typeof o.unverified === "boolean";
}

/** One person who attended and signed. */
export interface AttendanceRow {
  employee: EmployeeValue;
  signature: { r2_key: string; format: "png" | "svg" };
}

/** Hard ceiling on rows, client and server. The JotForm this replaced had 43. */
export const ATTENDANCE_MAX_ROWS = 80;

/**
 * Each row's signature is uploaded under its OWN field key so the R2 objects
 * cannot overwrite one another (the signature upload writes a fixed filename
 * per field key): `${fieldKey}__sig_${row}`. The upload endpoint and the
 * submit handler both go through these two helpers.
 */
export function attendanceSignatureKey(fieldKey: string, row: number): string {
  return `${fieldKey}__sig_${row}`;
}

export function parseAttendanceSignatureKey(
  key: string
): { fieldKey: string; row: number } | null {
  const m = /^([a-z][a-z0-9_]*)__sig_(\d{1,3})$/.exec(key);
  if (!m) return null;
  const row = Number(m[2]);
  if (!Number.isInteger(row) || row < 0 || row >= ATTENDANCE_MAX_ROWS) return null;
  return { fieldKey: m[1]!, row };
}

export function isAttendanceValue(v: unknown): v is AttendanceRow[] {
  if (!Array.isArray(v)) return false;
  return v.every(
    (r) =>
      !!r &&
      typeof r === "object" &&
      isEmployeeLike((r as AttendanceRow).employee) &&
      !!(r as AttendanceRow).signature &&
      typeof (r as AttendanceRow).signature.r2_key === "string"
  );
}

/** "3 signed: Jane Smith, Bob Jones, Ann Lee (typed)". */
export function formatAttendanceValue(rows: AttendanceRow[]): string {
  if (rows.length === 0) return "No one signed";
  const names = rows.map((r) => (r.employee.unverified ? `${r.employee.name} (typed)` : r.employee.name));
  return `${rows.length} signed: ${names.join(", ")}`;
}
