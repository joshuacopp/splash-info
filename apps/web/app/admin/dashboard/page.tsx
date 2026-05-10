// Admin landing page (/admin/dashboard).
//
// Replaces the Step-4 placeholder with a card-grid landing page that links
// into the four admin tools (Pricing / Damage / Performance / Sysadmin).
// Visual reference: legacy/dashboard.js renderDashboard (lines 382-606).
//
// V1 rendering policy: ALL tiles render unconditionally for any authed user.
// Per-tool access is enforced by the destination page when the user clicks
// in (each tool's existing "no access" handling). This matches legacy
// dashboard behavior - the legacy never gated tiles per role/grant.
//
// Why no per-tile gating in v1:
//   - apps/web doesn't currently have a way to read the current user's
//     session.tools / session.role server-side (no /api/me endpoint on
//     dashboard-worker, no Supabase env vars wired into apps/web). Both
//     are tracked separately (BUILD_STATE.md item 11a + the Supabase env
//     gap). Adding gating later is a non-breaking upgrade.
//   - Legacy parity. Operators who use only one tool still see a familiar
//     surface and won't get confused by tiles disappearing.
//
// Server component. No client interactivity in the grid itself - each card
// is just a Link covering the whole tile.

import Link from "next/link";
import type { ReactNode } from "react";

interface Tile {
  href: string;
  eyebrow: string;
  title: string;
  description: string;
  icon: ReactNode;
}

const TILES: ReadonlyArray<Tile> = [
  {
    href: "/admin/pricing",
    eyebrow: "Signup form",
    title: "MaxPass Admin",
    description:
      "Manage MaxPass pricing and review recent signups across your locations.",
    icon: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2.2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z" />
        <path d="M13 5v2" />
        <path d="M13 11v2" />
        <path d="M13 17v2" />
      </svg>
    )
  },
  {
    href: "/admin/damage",
    eyebrow: "Service",
    title: "Damage Claims",
    description: "Review and manage vehicle damage claims and resolutions.",
    icon: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2.2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
      </svg>
    )
  },
  {
    href: "/admin/performance",
    eyebrow: "Insights",
    title: "Performance Tracking",
    description: "View location performance metrics and operational insights.",
    icon: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2.2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <line x1="18" y1="20" x2="18" y2="10" />
        <line x1="12" y1="20" x2="12" y2="4" />
        <line x1="6" y1="20" x2="6" y2="14" />
        <line x1="3" y1="20" x2="21" y2="20" />
      </svg>
    )
  },
  {
    href: "/admin/sysadmin",
    eyebrow: "Admin",
    title: "Database Admin",
    description: "Manage user accounts, role assignments, and tool grants.",
    icon: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2.2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </svg>
    )
  },
  {
    href: "/workorders",
    eyebrow: "Maintenance",
    title: "MaintainX",
    description: "Open MaintainX work orders for your locations.",
    icon: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2.2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
      </svg>
    )
  },
  {
    href: "/admin/fleet",
    eyebrow: "B2B leads",
    title: "Fleet Inquiries",
    description:
      "View and export fleet customer inquiries from fleet.splashcarwashes.info.",
    // lucide Truck — inlined per the existing convention used by sibling tiles.
    icon: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2.2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2" />
        <path d="M15 18H9" />
        <path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.624l-3.48-4.35A1 1 0 0 0 17.52 8H14" />
        <circle cx="17" cy="18" r="2" />
        <circle cx="7" cy="18" r="2" />
      </svg>
    )
  },
  {
    href: "/admin/forms",
    eyebrow: "Builder",
    title: "Forms",
    description: "Build and manage admin-built forms.",
    // lucide ClipboardList — inlined per the existing convention used by sibling tiles.
    icon: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2.2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <rect width="8" height="4" x="8" y="2" rx="1" ry="1" />
        <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
        <path d="M12 11h4" />
        <path d="M12 16h4" />
        <path d="M8 11h.01" />
        <path d="M8 16h.01" />
      </svg>
    )
  }
] as const;

export default function AdminDashboardPage() {
  return (
    <section className="mx-auto w-full max-w-[1100px] px-5 py-9">
      <div className="mb-9">
        <p className="mb-1 text-xs font-semibold uppercase tracking-[0.18em] text-sudsy-blue">
          Internal Tools
        </p>
        <h1 className="text-2xl font-bold text-splash-navy">Dashboard</h1>
      </div>

      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {TILES.map((tile) => (
          <Link
            key={tile.href}
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
        ))}
      </div>
    </section>
  );
}
