// Employee field -- payload shape and the ONE formatter every surface uses
// (detail page, wide table, CSV, PDF, workflow emails). Same reasoning as
// package-price.ts: several renderings of one value drift; one function does
// not.

/**
 * Who a form is about, as stored on the submission.
 *
 * - Picked from the roster: `id` is the Beekeeper user id, and `name` /
 *   `title` / `site` are copied from the roster AT SUBMIT TIME, so a later
 *   rename or transfer does not rewrite what the form said.
 * - Typed (no roster match): `id` is null and `unverified` is true. The name
 *   is whatever the filler typed; the worker has already refused it if it
 *   closely matched a real employee.
 */
export interface EmployeeValue {
  id: string | null;
  name: string;
  title: string | null;
  /** "Greenwich (040)" etc., or the office group, or null if unknown. */
  site: string | null;
  unverified: boolean;
}

export function isEmployeeValue(v: unknown): v is EmployeeValue {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.name === "string" &&
    (o.id === null || typeof o.id === "string") &&
    typeof o.unverified === "boolean"
  );
}

/** "Jane Smith (General Manager, Greenwich (040))" or
 *  "Jane Smith (typed; not matched to an employee)". */
export function formatEmployeeValue(v: EmployeeValue): string {
  if (v.unverified) return `${v.name} (typed; not matched to an employee)`;
  const extra = [v.title, v.site].filter((s): s is string => !!s && s.trim() !== "");
  return extra.length ? `${v.name} (${extra.join(", ")})` : v.name;
}
