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

// Shift Schedule (beekeeper-worker). Mirrors the worker's scheduleGate: a
// `schedule` grant OR a `pricing` grant unlocks it (the operator rule that
// MaxPass pricing admins get shift access to their locations), plus super_admin.
// Per-location scope is enforced at the worker; this only decides tile visibility.
function hasScheduleAccess(session: Session | null): boolean {
  if (!session) return false;
  if (session.role === "super_admin") return true;
  return session.tools.includes("schedule") || session.tools.includes("pricing");
}

// Every grant that opens the chemical-inventory app, in nesting order. Kept as
// a local constant rather than imported from the worker because apps/web
// doesn't depend on apps/inventory; canReadInventory() in
// apps/inventory/worker/auth.ts is the authority and this must track it.
const INVENTORY_GRANTS = ["inventory_view", "inventory", "inventory_admin"] as const;

// Chemical Inventory (splash-inventory). Mirrors the worker's inventoryGate:
// super_admin OR any one of the three tier grants. A read-only holder still
// gets the tile — there's plenty to look at, they just can't submit.
//
// Deliberately NARROWER than hasScheduleAccess — a `pricing` grant does NOT
// imply inventory access. Per-location scope is enforced in the worker; this
// only decides tile visibility.
function hasInventoryAccess(session: Session | null): boolean {
  if (!session) return false;
  if (session.role === "super_admin") return true;
  return INVENTORY_GRANTS.some((grant) => session.tools.includes(grant));
}

/**
 * True for a session whose ONLY usable tool is chemical inventory: not
 * super_admin, no damage-claim role, no promotions role, and every tool grant
 * they hold is an inventory tier.
 *
 * "Every grant is an inventory tier" rather than "exactly one grant": the tiers
 * are meant to be held one at a time, but the console doesn't stop an operator
 * ticking `inventory_view` and `inventory` together, and such a user is still
 * unambiguously inventory-only. Keying off the count would have quietly dropped
 * them back into the full staff dashboard.
 *
 * This exists for the external-vendor population — chemical vendors get a
 * `location_admin` row scoped to their sites plus an inventory grant, and
 * nothing else. They aren't employees and have no reason to be shown the staff
 * tiles.
 *
 * Deliberately narrow. The same argument applies to any single-tool session (a
 * pricing-only or schedule-only account also sees a screen of dead tiles), but
 * widening this changes what existing employees see, which is a policy call
 * rather than a code one. Widen it when the tiles below get real predicates.
 */
function isInventoryOnly(session: Session | null): boolean {
  if (!session) return false;
  if (session.role === "super_admin") return false;
  if (session.dcRole != null) return false;
  if (session.promoRole != null) return false;
  const tools = session.tools;
  if (tools.length === 0) return false;
  return tools.every((tool) => (INVENTORY_GRANTS as readonly string[]).includes(tool));
}

/**
 * Tiles open to any signed-in STAFF member. Was `anySession` (literally
 * `return true`), which held while every account belonged to an employee. It
 * doesn't anymore: an inventory-only vendor landed on the dashboard and saw
 * eight tiles, seven of which dead-end on an access message. None of them leak
 * — every destination re-checks at the server layer — but it's a poor first
 * impression and it generates support questions.
 *
 * Still true for a null session, preserving the documented fallback in
 * dashboard/page.tsx: when the /api/me lookup fails, predicates evaluate
 * against null and the staff tiles still render.
 *
 * This remains a UX hint only. Page-level dcRole / email-on-locations gates are
 * still the actual access control.
 */
function allStaff(session: Session | null): boolean {
  return !isInventoryOnly(session);
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

const beakerIcon: ReactNode = (
  <svg {...SvgProps}>
    <path d="M4.5 3h15" />
    <path d="M6 3v16a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V3" />
    <path d="M6 14h12" />
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

const mailIcon: ReactNode = (
  <svg {...SvgProps}>
    <rect x="2" y="4" width="20" height="16" rx="2" />
    <path d="M2 7l10 6 10-6" />
  </svg>
);

const graduationCapIcon: ReactNode = (
  <svg {...SvgProps}>
    <path d="M22 10 12 4 2 10l10 6 10-6z" />
    <path d="M6 12v5c0 1.7 2.7 3 6 3s6-1.3 6-3v-5" />
    <path d="M22 10v6" />
  </svg>
);

const settingsGearIcon: ReactNode = (
  <svg {...SvgProps}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
);

const megaphoneIcon: ReactNode = (
  <svg {...SvgProps}>
    <path d="M3 11v2a2 2 0 0 0 2 2h1l4 4V5L6 9H5a2 2 0 0 0-2 2z" />
    <path d="M14 7a5 5 0 0 1 0 10" />
    <path d="M18 5a9 9 0 0 1 0 14" />
  </svg>
);

const ticketIcon: ReactNode = (
  <svg {...SvgProps}>
    <path d="M3 8a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-2a2 2 0 0 0 0-4z" />
    <line x1="13" y1="6" x2="13" y2="18" />
  </svg>
);

const calendarIcon: ReactNode = (
  <svg {...SvgProps}>
    <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
    <line x1="16" y1="2" x2="16" y2="6" />
    <line x1="8" y1="2" x2="8" y2="6" />
    <line x1="3" y1="10" x2="21" y2="10" />
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
    visibleTo: allStaff
  },
  {
    id: "jotform",
    group: "submissions",
    eyebrow: "Field forms",
    title: "JotForm",
    description: "Rewash, salt log, retention, and time card edits.",
    href: "/admin/jotform",
    icon: fileTextIcon,
    visibleTo: allStaff
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
    visibleTo: allStaff
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

  // ---- Operations group ----
  {
    id: "damage",
    group: "operations",
    eyebrow: "Service",
    title: "Damage Claims",
    description: "Review and manage vehicle damage claims and resolutions.",
    href: "/admin/damage",
    icon: wrenchIcon,
    visibleTo: allStaff
  },
  {
    id: "schedule",
    group: "operations",
    eyebrow: "Scheduling",
    title: "Shift Schedule",
    description: "Add and edit employee shifts by location.",
    href: "/schedule",
    icon: calendarIcon,
    visibleTo: hasScheduleAccess
  },
  {
    id: "workorders",
    group: "operations",
    eyebrow: "Maintenance",
    title: "Work Orders",
    description: "View MaintainX work orders for your locations.",
    href: "/workorders",
    icon: wrenchIcon,
    visibleTo: allStaff
  },
  {
    id: "pending-approvals",
    group: "operations",
    eyebrow: "Workflow",
    title: "Pending Approvals",
    description: "Custom form submissions waiting on your review.",
    href: "/admin/approvals",
    icon: checkCircleIcon,
    visibleTo: allStaff
  },
  {
    id: "inventory",
    group: "operations",
    eyebrow: "Chemicals",
    title: "Chemical Inventory",
    description: "Log site visits and track chemical usage and cost per car.",
    href: "/inventory/",
    icon: beakerIcon,
    visibleTo: hasInventoryAccess
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
  {
    // Same `pertrack` grant as Performance Tracking — a separate tile because
    // it's a different job (one greeter's whole day of sales numbers, not a
    // manager's site visit), not a different permission.
    id: "greeters",
    group: "operations",
    eyebrow: "Insights",
    title: "Greeter Scorecard",
    description:
      "Daily sign-ups, wash sales, and D.O.B. by greeter and by location.",
    href: "/admin/greeters",
    icon: barChartIcon,
    visibleTo: hasPerformanceAccess
  },
  // Brief 158a — Promotions feature. Visible to any user with a promo_role
  // (super_admin / it / marketing / ops); page-level gate re-checks at the
  // destination. IT Queue is the work-queue surface for super_admin / it
  // only — pre-filtered to "Assigned to me" by default.
  {
    id: "promotions",
    group: "operations",
    eyebrow: "Campaigns",
    title: "Promotions",
    description:
      "Plan, scope, and run promotional campaigns across locations.",
    href: "/admin/promotions",
    icon: megaphoneIcon,
    visibleTo: (s: Session | null) => s?.promoRole != null
  },
  {
    id: "promotions-queue",
    group: "operations",
    eyebrow: "IT",
    title: "IT Promotions Queue",
    description:
      "Items waiting on the IT team for scoping or build.",
    href: "/admin/promotions/queue",
    icon: ticketIcon,
    visibleTo: (s: Session | null) =>
      s?.promoRole === "super_admin" || s?.promoRole === "it"
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
    visibleTo: allStaff
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
  },
  {
    id: "email-queue",
    group: "admin",
    eyebrow: "Infra",
    title: "Email Queue",
    description: "Pending, sent, and stuck outbound emails.",
    href: "/admin/email-queue",
    icon: mailIcon,
    visibleTo: isAdminTier
  },
  {
    id: "scorm-builder",
    group: "admin",
    eyebrow: "Training",
    title: "SCORM Package Builder",
    description: "Build training packages — video + quiz — for upload to your LMS.",
    href: "/admin/scorm-builder",
    icon: graduationCapIcon,
    visibleTo: isAdminTier
  }
];
