// Navigation shape for the admin dashboard: what exists, where it sits in the
// hierarchy, and what it is called.
//
// WHY THIS IS SPLIT OUT OF tiles.tsx
//
//   The breadcrumb is a CLIENT component -- it needs usePathname() to know
//   where it is. tiles.tsx cannot be imported from client code without also
//   shipping 23 inline SVG icons and every visibleTo predicate to the browser.
//   Copying the hierarchy into a second file was the alternative, and it is
//   worse: a breadcrumb that disagrees with the dashboard is a breadcrumb that
//   lies about where you are, and nothing would catch it.
//
//   So the shape lives here and tiles.tsx builds its tiles FROM it. Group,
//   subgroup, title and href have exactly one definition. Adding a tile means
//   adding a NAV entry, and tiles.tsx will not compile until that entry has
//   presentation to go with it -- see the Record<NavId, ...> there.
//
// NOTHING IN THIS FILE MAY IMPORT JSX, next/headers, OR Session. It is
// deliberately client-safe; that is the entire reason it exists.

export type TileGroup = "submissions" | "operations" | "admin";
export type TileSubgroup = "daily-tools" | "mechanical" | "other-tools";

export const GROUPS: { id: TileGroup; label: string }[] = [
  { id: "submissions", label: "Submissions" },
  { id: "operations", label: "Operations" },
  { id: "admin", label: "Admin" }
];

export interface Subgroup {
  id: TileSubgroup;
  group: TileGroup;
  label: string;
  description: string;
}

/** Subgroups render before the group's ungrouped tiles, so a section's
 *  categories read first and its loose tools follow. */
export const SUBGROUPS: Subgroup[] = [
  {
    id: "daily-tools",
    group: "operations",
    label: "Daily Tools",
    description:
      "Damage claims, shift schedule, greeter scorecard, and the expense log."
  },
  {
    id: "mechanical",
    group: "operations",
    label: "Mechanical",
    description:
      "Equipment manuals, the parts directory, work orders, and training videos."
  },
  {
    // Deliberately last: a catch-all reads as the place to look when the first
    // two did not have it.
    id: "other-tools",
    group: "operations",
    label: "Other Tools",
    description: "Approvals, chemical inventory, and promotions."
  }
];

export interface NavEntry {
  id: string;
  group: TileGroup;
  subgroup?: TileSubgroup;
  /** Bold display name on the tile, and the last crumb in the trail. */
  title: string;
  href: string;
}

/** Every destination the dashboard offers, in dashboard order. */
export const NAV = [
  // ---- Submissions ----
  { id: "signups-viewer", group: "submissions", title: "Signups", href: "/admin/signups" },
  { id: "jotform", group: "submissions", title: "JotForm", href: "/admin/jotform" },
  { id: "forms-submissions", group: "submissions", title: "Forms", href: "/admin/forms/submissions" },
  { id: "my-requests", group: "submissions", title: "My Requests", href: "/admin/my-requests" },
  { id: "fleet-inquiries", group: "submissions", title: "Fleet Inquiries", href: "/admin/fleet" },

  // ---- Operations / Daily Tools ----
  { id: "damage", group: "operations", subgroup: "daily-tools", title: "Damage Claims", href: "/admin/damage" },
  { id: "schedule", group: "operations", subgroup: "daily-tools", title: "Shift Schedule", href: "/schedule" },
  { id: "greeters", group: "operations", subgroup: "daily-tools", title: "Greeter Scorecard", href: "/admin/greeters" },
  { id: "expenses", group: "operations", subgroup: "daily-tools", title: "Expense Log", href: "/admin/expenses" },

  // ---- Operations / Mechanical ----
  { id: "workorders", group: "operations", subgroup: "mechanical", title: "Work Orders", href: "/workorders" },
  { id: "maintenance-tracker", group: "operations", subgroup: "mechanical", title: "Maintenance Tracker", href: "/admin/maintenance" },
  { id: "parts", group: "operations", subgroup: "mechanical", title: "Equipment Manuals", href: "/admin/parts" },
  { id: "parts-directory", group: "operations", subgroup: "mechanical", title: "Parts Directory", href: "/admin/parts/directory" },
  { id: "macneil-videos", group: "operations", subgroup: "mechanical", title: "MacNeil Videos", href: "/admin/macneil-videos" },

  // ---- Operations / Other Tools ----
  { id: "pending-approvals", group: "operations", subgroup: "other-tools", title: "Pending Approvals", href: "/admin/approvals" },
  { id: "action-items", group: "operations", subgroup: "other-tools", title: "Action Items", href: "/action-items" },
  { id: "forms-fill", group: "operations", subgroup: "other-tools", title: "Fill Out a Form", href: "/forms" },
  { id: "sds", group: "operations", subgroup: "other-tools", title: "SDS Binder Index", href: "/sds" },
  { id: "inventory", group: "operations", subgroup: "other-tools", title: "Chemical Inventory", href: "/inventory/" },
  { id: "promotions", group: "operations", subgroup: "other-tools", title: "Promotions", href: "/admin/promotions" },
  { id: "promotions-queue", group: "operations", subgroup: "other-tools", title: "IT Promotions Queue", href: "/admin/promotions/queue" },

  // ---- Admin ----
  { id: "pricing", group: "admin", title: "Pricing", href: "/admin/pricing" },
  { id: "form-builder", group: "admin", title: "Form Builder", href: "/admin/forms" },
  { id: "sds-catalog", group: "admin", title: "SDS Catalogue", href: "/admin/sds-catalog" },
  { id: "database-admin", group: "admin", title: "Database Admin", href: "/admin/sysadmin" },
  { id: "email-queue", group: "admin", title: "Email Queue", href: "/admin/email-queue" },
  { id: "scorm-builder", group: "admin", title: "SCORM Package Builder", href: "/admin/scorm-builder" }
] as const satisfies ReadonlyArray<NavEntry>;

export type NavId = (typeof NAV)[number]["id"];

export interface Crumb {
  label: string;
  /** Null on the final crumb -- you are already there, so it is not a link. */
  href: string | null;
}

const GROUP_LABEL = new Map(GROUPS.map((g) => [g.id, g.label]));
const SUBGROUP_LABEL = new Map(SUBGROUPS.map((s) => [s.id, s.label]));

/**
 * The trail for a pathname, e.g.
 *
 *   /admin/maintenance      -> Dashboard / Operations / Mechanical / Maintenance Tracker
 *   /admin/damage/1234      -> Dashboard / Operations / Daily Tools / Damage Claims
 *   /admin/dashboard/admin  -> Dashboard / Admin
 *
 * LONGEST PREFIX WINS, and that is load-bearing rather than incidental:
 * "/admin/parts" and "/admin/parts/directory" are separate destinations, and
 * "/admin/forms" and "/admin/forms/submissions" sit in DIFFERENT GROUPS. First
 * match would put the Parts Directory under Equipment Manuals and file Forms
 * submissions under Admin. Detail pages inherit their parent's trail, which is
 * what makes /admin/damage/1234 work without an entry of its own.
 *
 * Returns an empty array for anything not under the dashboard -- /login,
 * /change-password, the dashboard root itself -- so the caller renders
 * nothing rather than a trail pointing at where you already are.
 */
export function resolveTrail(pathname: string): Crumb[] {
  const path = normalise(pathname);
  if (path === "" || path === "/") return [];

  // The dashboard's own pages. /admin/dashboard is the root and gets no trail.
  if (path === "/admin/dashboard") return [];
  if (path.startsWith("/admin/dashboard/")) {
    const [, , , groupId, subgroupId] = path.split("/");
    const groupLabel = GROUP_LABEL.get(groupId as TileGroup);
    if (!groupLabel) return [];
    const crumbs: Crumb[] = [{ label: "Dashboard", href: "/admin/dashboard" }];
    if (!subgroupId) {
      crumbs.push({ label: groupLabel, href: null });
      return crumbs;
    }
    const subLabel = SUBGROUP_LABEL.get(subgroupId as TileSubgroup);
    if (!subLabel) return crumbs.concat({ label: groupLabel, href: null });
    crumbs.push({ label: groupLabel, href: `/admin/dashboard/${groupId}` });
    crumbs.push({ label: subLabel, href: null });
    return crumbs;
  }

  let best: NavEntry | null = null;
  for (const entry of NAV) {
    const href = normalise(entry.href);
    if (path !== href && !path.startsWith(href + "/")) continue;
    if (!best || href.length > normalise(best.href).length) best = entry;
  }
  if (!best) return [];

  const groupLabel = GROUP_LABEL.get(best.group);
  if (!groupLabel) return [];

  const crumbs: Crumb[] = [
    { label: "Dashboard", href: "/admin/dashboard" },
    { label: groupLabel, href: `/admin/dashboard/${best.group}` }
  ];
  if (best.subgroup) {
    const subLabel = SUBGROUP_LABEL.get(best.subgroup);
    if (subLabel) {
      crumbs.push({
        label: subLabel,
        href: `/admin/dashboard/${best.group}/${best.subgroup}`
      });
    }
  }
  // The destination itself. Linked when we are on a sub-page of it (so it is a
  // real way back), inert when we are already on it.
  const onTile = path === normalise(best.href);
  crumbs.push({ label: best.title, href: onTile ? null : best.href });
  return crumbs;
}

/** Trailing slashes off so "/inventory/" and "/inventory" compare equal.
 *  The inventory tile's href genuinely carries one. */
function normalise(pathname: string): string {
  const p = (pathname || "").split("?")[0]!.split("#")[0]!;
  return p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
}
