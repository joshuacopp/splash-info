// @splash/report-kit (Brief 179): one way to build reports.
//
// Declare a report with `defineReport`; the worker uses `parseReportParams`,
// `toCsv` and `exportFilename`, and the apps/web page renders it with
// `app/_components/report/`. Do not hand-roll a date default, an Eastern-time
// helper or a CSV escaper in a report -- use these.
//
// Plain TS with no runtime dependencies; safe in Workers and in Next.
// Individual report definitions live under `@splash/report-kit/reports/*`.

export * from "./time";
export * from "./define";
export * from "./csv";

/**
 * Full admin tier (unscoped visibility). Structural so the kit doesn't depend
 * on @splash/auth; row scoping itself stays in each worker's gate.
 */
export function isAdminTier(s: { role?: string | null; dcRole?: string | null } | null | undefined): boolean {
  return !!s && (s.role === "super_admin" || s.dcRole === "admin" || s.dcRole === "super_admin");
}
