// Brief 116 — Dashboard tile registry.
//
// Single source of truth for which tiles render on /admin/dashboard, how they
// group, and which sessions can see each one. Onboarding a new tile = add
// one entry here. Group headers auto-suppress when no tile in the group is
// visible to the current session.
//
// File uses .tsx because each tile carries an inline SVG icon (ReactNode);
// the brief's prose example showed `.ts` but the interface change to include
// `icon` is what enables the dashboard to render with no visual regression
// from the prior flat grid (per "no styling changes" in Scope §Phase 2).
//
// Performance tile visibility uses the existing `pertrack` ToolName from
// @splash/types/auth (NOT a new "performance" tool). super_admin role
// implies access without an explicit grant (matches @splash/auth
// checkToolAccess); admin-tier (dcRole === "admin" / "super_admin") also
// sees it as a convenience for the operator population that already manages
// the tool grants.

import type { ReactNode } from "react";
import type { Session } from "@splash/types/session";

export type TileGroup = "submissions" | "operations" | "admin";

export interface Tile {
  id: string;
  group: TileGroup;
  /** Small uppercase label rendered above the title on the tile header. */
  eyebrow: string;
  /** Bold display name. */
  title: string;
  /** One-line body copy. */
  description: string;
  /** Click-through URL. */
  href: string;
  /** Inline SVG icon (renders inside the white circle on the navy header). */
  icon: ReactNode;
  /** Predicate that decides whether this tile renders for `session`. */
  visibleTo: (session: Session | null) => boolean;
}

export const GROUPS: { id: TileGroup; label: string }[] = [
  { id: "submissions", label: "Submissions" },
  { id: "operations", label: "Operations" },
  { id: "admin", label: "Admin" }
];

function isAdminTier(session: Session | null): boolean {
  if (!session) return false;
  return (
    session.role === "super_admin" ||
    session.dcRole === "admin" ||
    session.dcRole === "super_admin"
  );
}

function isSuperAdmin(session: Session | null): boolean {
  return session?.role === "super_admin";
}

function hasPerformanceAccess(session: Session | null): boolean {
  if (!session) return false;
  if (isAdminTier(session)) return true;
  // Performance tool grant is `pertrack` per @splash/types/auth ToolName.
  return session.tools.includes("pertrack");
}

function anySession(_session: Session | null): boolean {
  // Page-level dcRole / email-on-locations gates apply at the destination.
  return true;
}

// ---------------------------------------------------------------------------
// Icons (inline lucide-derived SVGs, matching the rest of apps/web's tiles).
// ---------------------------------------------------------------------------

const SvgProps = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2.2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true
} as const;

const userPlusIcon: ReactNode = (
  <svg {...SvgProps}>
    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <line x1="19" y1="8" x2="19" y2="14" />
    <line x1="22" y1="11" x2="16" y2="11" />
  </svg>
);

const truckIcon: ReactNode = (
  <svg {...SvgProps}>
    <path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2" />
    <path d="M15 18H9" />
    <path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.624l-3.48-4.35A1 1 0 0 0 17.52 8H14" />
    <circle cx="17" cy="18" r="2" />
    <circle cx="7" cy="18" r="2" />
  </svg>
);

const fileTextIcon: ReactNode = (
  <svg {...SvgProps}>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
    <line x1="16" y1="13" x2="8" y2="13" />
    <line x1="16" y1="17" x2="8" y2="17" />
    <polyline points="10 9 9 9 8 9" />
  </svg>
);

const inboxIcon: ReactNode = (
  <svg {...SvgProps}>
    <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
    <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
  </svg>
);

const wrenchIcon: ReactNode = (
  <svg {...SvgProps}>
    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
  </svg>
);

const barChartIcon: ReactNode = (
  <svg {...SvgProps}>
    <line x1="18" y1="20" x2="18" y2="10" />
    <line x1="12" y1="20" x2="12" y2="4" />
    <line x1="6" y1="20" x2="6" y2="14" />
    <line x1="3" y1="20" x2="21" y2="20" />
  </svg>
);

const creditCardIcon: ReactNode = (
  <svg {...SvgProps}>
    <path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z" />
    <path d="M13 5v2" />
    <path d="M13 11v2" />
    <path d="M13 17v2" />
  </svg>
);

const clipboardListIcon: ReactNode = (
  <svg {...SvgProps}>
    <rect width="8" height="4" x="8" y="2" rx="1" ry="1" />
    <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
    <path d="M12 11h4" />
    <path d="M12 16h4" />
    <path d="M8 11h.01" />
    <path d="M8 16h.01" />
  </svg>
);

const checkCircleIcon: ReactNode = (
  <svg {...SvgProps}>
    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
    <polyline points="22 4 12 14.01 9 11.01" />
  </svg>
);

const sendIcon: ReactNode = (
  <svg {...SvgProps}>
    <line x1="22" y1="2" x2="11" y2="13" />
    <polygon points="22 2 15 22 11 13 2 9 22 2" />
  </svg>
);

const settingsGearIcon: ReactNode = (
  <svg {...SvgProps}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
);

// ---------------------------------------------------------------------------
// Tile registry.
// ---------------------------------------------------------------------------

export const TILES: ReadonlyArray<Tile> = [
  // ---- Submissions group ----
  {
    id: "signups-viewer",
    group: "submissions",
    eyebrow: "MaxPass",
    title: "Signups",
    description: "Recent customer enrollments by location.",
    href: "/admin/signups",
    icon: userPlusIcon,
    visibleTo: anySession
  },
  {
    id: "fleet-inquiries",
    group: "submissions",
    eyebrow: "B2B leads",
    title: "Fleet Inquiries",
    description: "View and edit fleet customer inquiries.",
    href: "/admin/fleet",
    icon: truckIcon,
    visibleTo: isAdminTier
  },
  {
    id: "jotform",
    group: "submissions",
    eyebrow: "Field forms",
    title: "JotForm",
    description: "Rewash, salt log, retention, and time card edits.",
    href: "/admin/jotform",
    icon: fileTextIcon,
    visibleTo: anySession
  },
  {
    id: "forms-submissions",
    group: "submissions",
    eyebrow: "Custom forms",
    title: "Forms",
    description: "View submissions to admin-built custom forms.",
    href: "/admin/forms/submissions",
    icon: inboxIcon,
    visibleTo: isAdminTier
  },
  {
    id: "my-requests",
    group: "submissions",
    eyebrow: "Workflow",
    title: "My Requests",
    description: "Submissions you submitted — waiting, approved, denied.",
    href: "/admin/my-requests",
    icon: sendIcon,
    visibleTo: anySession
  },

  // ---- Operations group ----
  {
    id: "damage",
    group: "operations",
    eyebrow: "Service",
    title: "Damage Claims",
    description: "Review and manage vehicle damage claims and resolutions.",
    href: "/admin/damage",
    icon: wrenchIcon,
    visibleTo: anySession
  },
  {
    id: "workorders",
    group: "operations",
    eyebrow: "Maintenance",
    title: "Work Orders",
    description: "View MaintainX work orders for your locations.",
    href: "/workorders",
    icon: wrenchIcon,
    visibleTo: anySession
  },
  {
    id: "pending-approvals",
    group: "operations",
    eyebrow: "Workflow",
    title: "Pending Approvals",
    description: "Custom form submissions waiting on your review.",
    href: "/admin/approvals",
    icon: checkCircleIcon,
    visibleTo: anySession
  },
  {
    id: "performance",
    group: "operations",
    eyebrow: "Insights",
    title: "Performance Tracking",
    description: "Location performance metrics and operational insights.",
    href: "/admin/performance",
    icon: barChartIcon,
    visibleTo: hasPerformanceAccess
  },

  // ---- Admin group ----
  {
    id: "pricing",
    group: "admin",
    eyebrow: "MaxPass",
    title: "Pricing",
    description: "Set per-location MaxPass pricing.",
    href: "/admin/pricing",
    icon: creditCardIcon,
    visibleTo: anySession
  },
  {
    id: "form-builder",
    group: "admin",
    eyebrow: "Builder",
    title: "Form Builder",
    description: "Build and manage admin-built forms.",
    href: "/admin/forms",
    icon: clipboardListIcon,
    visibleTo: isAdminTier
  },
  {
    id: "database-admin",
    group: "admin",
    eyebrow: "Admin",
    title: "Database Admin",
    description: "Manage user accounts, role assignments, and tool grants.",
    href: "/admin/sysadmin",
    icon: settingsGearIcon,
    visibleTo: isSuperAdmin
  }
];
