// Maintenance tracker section nav.
//
// The page had grown to five full-length sections stacked vertically and was,
// in the operator's words, "borderline unusable because it's just a giant
// list". These split it.
//
// URL-driven (`?tab=`) rather than client state, matching the forms builder
// (Brief 125) and SignupAdminTabs (Brief 56): the page is a server component
// doing one fetch, so a tab flip is a cheap re-render with no JS shipped, and
// a tab is linkable — "look at the day detail" can be pasted to someone.
//
// Every tab reads the SAME already-fetched payload. Tabs are a rendering
// choice, not a data-loading one; do not turn these into per-tab fetches
// without checking that the summary endpoint is still one round trip.

import Link from "next/link";

export const MAINTENANCE_TABS = [
  { id: "overview", label: "Overview" },
  { id: "sites", label: "Sites" },
  { id: "mechanics", label: "Mechanics" },
  { id: "days", label: "Day detail" },
  { id: "evidence", label: "Evidence" }
] as const;

export type MaintenanceTab = (typeof MAINTENANCE_TABS)[number]["id"];

/** Unknown or absent ?tab= falls back to overview rather than 404ing. */
export function resolveTab(raw: string | string[] | undefined): MaintenanceTab {
  const v = Array.isArray(raw) ? raw[0] : raw;
  const hit = MAINTENANCE_TABS.find((t) => t.id === v);
  return hit ? hit.id : "overview";
}

export function MaintenanceTabs({ active }: { active: MaintenanceTab }) {
  return (
    <nav aria-label="Maintenance tracker sections" className="mb-6 flex flex-wrap gap-2">
      {MAINTENANCE_TABS.map((t) => {
        const on = t.id === active;
        return (
          <Link
            key={t.id}
            href={`/admin/maintenance?tab=${t.id}`}
            aria-current={on ? "page" : undefined}
            className={
              on
                ? "inline-flex items-center rounded-full border border-splash-blue bg-splash-blue px-4 py-1.5 text-sm font-bold text-white shadow-splash-btn"
                : "inline-flex items-center rounded-full border border-splash-blue bg-white px-4 py-1.5 text-sm font-bold text-splash-blue hover:bg-splash-blue/5"
            }
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
