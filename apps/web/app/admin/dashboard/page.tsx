// Admin landing page (/admin/dashboard).
//
// Brief 116 — three-group layout (Submissions / Operations / Admin) driven
// by the tile registry at _lib/tiles.tsx. Each tile carries its own
// `visibleTo` predicate; group headers auto-suppress when no tile in the
// group is visible to the current session. Replaces the flat 8-tile grid
// (Brief 4 / Brief 78 / Brief 109).
//
// Tile destinations enforce their own access at the page or worker layer
// (e.g., /admin/sysadmin re-checks super_admin, the workorders worker
// scopes by email-on-locations). visibleTo here is a UX hint — it stops a
// non-admin from seeing a "Database Admin" tile they can't enter, not
// access control.
//
// Server component. getMe() is best-effort: when the dashboard-worker
// /api/me lookup fails, predicates evaluate against `null` and only the
// `anySession` tiles render. Operators in that state can still navigate
// directly via bookmarks (and the destination will redirect to /login).

import { getMe } from "../../_lib/me";
import { GROUPS, TILES } from "./_lib/tiles";
import { DashboardTile } from "./_components/DashboardTile";

export default async function AdminDashboardPage() {
  const session = await getMe().catch(() => null);

  const visibleByGroup = GROUPS.map((group) => ({
    group,
    tiles: TILES.filter(
      (tile) => tile.group === group.id && tile.visibleTo(session)
    )
  })).filter((entry) => entry.tiles.length > 0);

  return (
    <section className="mx-auto w-full max-w-[1100px] px-5 py-9">
      <div className="mb-9">
        <p className="mb-1 text-xs font-semibold uppercase tracking-[0.18em] text-sudsy-blue">
          Internal Tools
        </p>
        <h1 className="text-2xl font-bold text-splash-navy">Dashboard</h1>
      </div>

      <div className="flex flex-col gap-10">
        {visibleByGroup.map(({ group, tiles }) => (
          <section key={group.id} aria-labelledby={`group-${group.id}`}>
            <h2
              id={`group-${group.id}`}
              className="mb-4 text-xs font-semibold uppercase tracking-[0.18em] text-splash-navy/70"
            >
              {group.label}
            </h2>
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {tiles.map((tile) => (
                <DashboardTile key={tile.id} tile={tile} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </section>
  );
}
