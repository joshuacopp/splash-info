// Admin landing page (/admin/dashboard).
//
// Brief 117 — two-level drill-down. The top page renders three group tiles
// (Submissions / Operations / Admin); each group tile links to
// /admin/dashboard/{groupId} where the actual sub-tiles render. Group tile
// visibility is driven by the per-tile `visibleTo` predicates from Brief
// 116's registry — a group tile shows iff at least one of its sub-tiles is
// visible to the current session.
//
// Same per-tile access posture as Brief 116: visibleTo is a UX hint; the
// destination pages re-check session / dcRole / email-on-locations at the
// server layer.
//
// Server component. getMe() is best-effort: when the dashboard-worker
// /api/me lookup fails, predicates evaluate against `null` and only the
// `anySession` tiles count, so a sessionless caller still sees the groups
// that have any-session sub-tiles.
//
// Empty state: if zero groups have any visible sub-tile (theoretical — a
// user with no accessible tools at all), the page renders a "No tools
// available — contact a super_admin" message instead of empty space.

import Link from "next/link";
import { getMe } from "../../_lib/me";
import { GROUPS, TILES } from "./_lib/tiles";

const GROUP_DESCRIPTIONS: Record<string, string> = {
  submissions: "View signups, fleet inquiries, JotForm, and form submissions.",
  operations: "Damage claims, work orders, and performance tracking.",
  admin: "Pricing, form builder, and database admin."
};

export default async function AdminDashboardPage() {
  const session = await getMe().catch(() => null);

  const visibleGroups = GROUPS.map((group) => ({
    group,
    count: TILES.filter(
      (tile) => tile.group === group.id && tile.visibleTo(session)
    ).length
  })).filter((entry) => entry.count > 0);

  return (
    <section className="mx-auto w-full max-w-[1100px] px-5 py-9">
      <div className="mb-9">
        <p className="mb-1 text-xs font-semibold uppercase tracking-[0.18em] text-sudsy-blue">
          Internal Tools
        </p>
        <h1 className="text-2xl font-bold text-splash-navy">Dashboard</h1>
      </div>

      {visibleGroups.length === 0 ? (
        <div className="rounded-splash-lg border-[3px] border-splash-navy/20 bg-white px-6 py-8 text-center text-splash-navy/80">
          No tools available — contact a super_admin to request access.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {visibleGroups.map(({ group, count }) => (
            <Link
              key={group.id}
              href={`/admin/dashboard/${group.id}`}
              className="group flex flex-col overflow-hidden rounded-splash-lg border-[3px] border-splash-navy bg-white text-splash-navy shadow-splash-card transition-transform duration-150 hover:-translate-y-1 hover:shadow-splash-card-hover"
            >
              <div className="flex items-center gap-4 bg-gradient-to-br from-splash-blue to-splash-navy px-6 py-5">
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-[0.6875rem] font-semibold uppercase tracking-[0.16em] text-sudsy-blue">
                    Section
                  </span>
                  <span className="text-lg font-bold leading-tight text-white">
                    {group.label}
                  </span>
                </div>
              </div>
              <div className="flex flex-1 flex-col justify-between gap-3.5 px-6 pb-5 pt-4">
                <div>
                  <p className="text-[0.9375rem] leading-relaxed text-splash-navy/80">
                    {GROUP_DESCRIPTIONS[group.id]}
                  </p>
                  <p className="mt-2 text-xs font-semibold uppercase tracking-[0.14em] text-splash-navy/55">
                    {count} {count === 1 ? "tool" : "tools"}
                  </p>
                </div>
                <span className="inline-flex items-center gap-1.5 self-start text-[0.8125rem] font-bold uppercase tracking-[0.08em] text-splash-blue">
                  Open
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2.5}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="h-3.5 w-3.5 transition-transform duration-200 group-hover:translate-x-1"
                    aria-hidden="true"
                  >
                    <line x1="5" y1="12" x2="19" y2="12" />
                    <polyline points="12 5 19 12 12 19" />
                  </svg>
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}
