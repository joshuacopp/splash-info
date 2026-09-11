// Dashboard subgroup page (/admin/dashboard/{group}/{subgroup}).
//
// Third level of the drill-down, below Brief 117's group page. One dynamic
// route covering every subgroup, parameterized off the tile registry — the
// same shape as the group page, and it reuses <DashboardTile> verbatim so the
// tiles here are identical to the ones that used to sit directly under the
// group.
//
// 404 posture matches the level above, and for the same reason: an unknown id,
// a subgroup that does not belong to the named group, or a caller with no
// visible tiles inside it all fall back to a clean 404 rather than leaking
// "this exists but you cannot see it".
//
// Note the group page hides a subgroup card holding only ONE visible tile and
// renders that tile inline instead. This page deliberately does NOT mirror that
// rule: arriving here by direct URL with one visible tile should show it, not
// 404. The rule is about not making someone click through a card to reach a
// single tool, and nobody clicked a card to get here.

import Link from "next/link";
import { notFound } from "next/navigation";
import { getMe } from "../../../../_lib/me";
import { GROUPS, SUBGROUPS, TILES, type TileGroup } from "../../_lib/tiles";
import { DashboardTile } from "../../_components/DashboardTile";

interface PageProps {
  params: Promise<{ group: string; subgroup: string }>;
}

function isTileGroup(value: string): value is TileGroup {
  return GROUPS.some((g) => g.id === value);
}

export default async function DashboardSubgroupPage({ params }: PageProps) {
  const { group: groupParam, subgroup: subgroupParam } = await params;
  if (!isTileGroup(groupParam)) {
    notFound();
  }

  const group = GROUPS.find((g) => g.id === groupParam)!;

  // Matched on BOTH ids: /admin/dashboard/admin/mechanical names a real group
  // and a real subgroup that have nothing to do with each other, and should
  // 404 rather than render Operations tiles under an Admin heading.
  const subgroup = SUBGROUPS.find(
    (sub) => sub.id === subgroupParam && sub.group === group.id
  );
  if (!subgroup) {
    notFound();
  }

  const session = await getMe().catch(() => null);

  const tiles = TILES.filter(
    (tile) =>
      tile.group === group.id &&
      tile.subgroup === subgroup.id &&
      tile.visibleTo(session)
  );

  if (tiles.length === 0) {
    notFound();
  }

  return (
    <section className="mx-auto w-full max-w-[1100px] px-5 py-9">
      <div className="mb-6 flex flex-wrap items-center gap-2 text-sm font-semibold">
        <Link
          href="/admin/dashboard"
          className="text-splash-blue hover:underline"
        >
          Dashboard
        </Link>
        <span aria-hidden="true" className="text-splash-navy/35">
          /
        </span>
        <Link
          href={`/admin/dashboard/${group.id}`}
          className="inline-flex items-center gap-1 text-splash-blue hover:underline"
        >
          {group.label}
        </Link>
      </div>

      <div className="mb-9">
        <p className="mb-1 text-xs font-semibold uppercase tracking-[0.18em] text-sudsy-blue">
          {group.label}
        </p>
        <h1 className="text-2xl font-bold text-splash-navy">{subgroup.label}</h1>
        <p className="mt-2 text-[0.9375rem] leading-relaxed text-splash-navy/80">
          {subgroup.description}
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
