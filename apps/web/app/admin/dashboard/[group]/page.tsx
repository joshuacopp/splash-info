// Brief 117 — Dashboard group landing page (/admin/dashboard/{groupId}).
//
// One dynamic route covering all three groups (submissions / operations /
// admin) parameterized off the Brief 116 registry. Unknown group ids 404
// via notFound(). A caller with zero visible sub-tiles in the resolved
// group also 404s — that matches the top-level state where the group tile
// would have been hidden, so a direct URL with no access falls back to a
// clean 404 rather than leaking "this group exists but you can't see it".
//
// Tile cards reuse the Brief 116 <DashboardTile> renderer verbatim so the
// sub-tiles here are visually identical to the prior flat-grid version of
// /admin/dashboard.

import Link from "next/link";
import { notFound } from "next/navigation";
import { getMe } from "../../../_lib/me";
import { GROUPS, TILES, type TileGroup } from "../_lib/tiles";
import { DashboardTile } from "../_components/DashboardTile";

const GROUP_DESCRIPTIONS: Record<TileGroup, string> = {
  submissions: "View signups, fleet inquiries, JotForm, and form submissions.",
  operations: "Damage claims, work orders, and performance tracking.",
  admin: "Pricing, form builder, and database admin."
};

interface PageProps {
  params: Promise<{ group: string }>;
}

function isTileGroup(value: string): value is TileGroup {
  return GROUPS.some((g) => g.id === value);
}

export default async function DashboardGroupPage({ params }: PageProps) {
  const { group: groupParam } = await params;
  if (!isTileGroup(groupParam)) {
    notFound();
  }

  const group = GROUPS.find((g) => g.id === groupParam)!;
  const session = await getMe().catch(() => null);

  const tiles = TILES.filter(
    (tile) => tile.group === group.id && tile.visibleTo(session)
  );

  if (tiles.length === 0) {
    notFound();
  }

  return (
    <section className="mx-auto w-full max-w-[1100px] px-5 py-9">
      <div className="mb-6">
        <Link
          href="/admin/dashboard"
          className="inline-flex items-center gap-1 text-sm font-semibold text-splash-blue hover:underline"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-3.5 w-3.5"
            aria-hidden="true"
          >
            <polyline points="15 18 9 12 15 6" />
          </svg>
          Dashboard
        </Link>
      </div>

      <div className="mb-9">
        <p className="mb-1 text-xs font-semibold uppercase tracking-[0.18em] text-sudsy-blue">
          Section
        </p>
        <h1 className="text-2xl font-bold text-splash-navy">{group.label}</h1>
        <p className="mt-2 text-[0.9375rem] leading-relaxed text-splash-navy/80">
          {GROUP_DESCRIPTIONS[group.id]}
        </p>
      </div>

      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {tiles.map((tile) => (
          <DashboardTile key={tile.id} tile={tile} />
        ))}
      </div>
    </section>
  );
}
