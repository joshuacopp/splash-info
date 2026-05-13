// Brief 116 — Per-tile renderer used by /admin/dashboard.
//
// Server component. Stateless. Renders one card from the tile registry —
// same JSX shape that the old flat-grid page rendered inline (preserves
// the existing styling per the brief's "no styling changes" requirement).

import Link from "next/link";
import type { Tile } from "../_lib/tiles";

export function DashboardTile({ tile }: { tile: Tile }) {
  return (
    <Link
      href={tile.href}
      className="group flex flex-col overflow-hidden rounded-splash-lg border-[3px] border-splash-navy bg-white text-splash-navy shadow-splash-card transition-transform duration-150 hover:-translate-y-1 hover:shadow-splash-card-hover"
    >
      <div className="flex items-center gap-4 bg-gradient-to-br from-splash-blue to-splash-navy px-6 py-5">
        <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full bg-white text-splash-blue">
          <span className="block h-[26px] w-[26px]">{tile.icon}</span>
        </div>
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-[0.6875rem] font-semibold uppercase tracking-[0.16em] text-sudsy-blue">
            {tile.eyebrow}
          </span>
          <span className="text-lg font-bold leading-tight text-white">
            {tile.title}
          </span>
        </div>
      </div>
      <div className="flex flex-1 flex-col justify-between gap-3.5 px-6 pb-5 pt-4">
        <p className="text-[0.9375rem] leading-relaxed text-splash-navy/80">
          {tile.description}
        </p>
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
  );
}
