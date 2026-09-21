// Brief 95 — Forms admin tab nav.
//
// Mounted above pages under the Forms umbrella:
//   /admin/forms                    (All Forms list)
//   /admin/forms/[id]               (Builder)
//   /admin/forms/[id]/submissions   (Brief 96 — coming next)
//   /admin/forms/[id]/versions      (Brief 96 — coming next)
//
// Mirrors SignupAdminTabs (Brief 56). Pathname-driven active state. The
// per-form sub-tabs only render when `formId` is provided (i.e., on
// /admin/forms/[id] and below).

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

interface Props {
  formId?: string;
  /**
   * Whether the caller can reach the BUILDER surfaces. All Forms, Builder and
   * Versions are admin-tier gated pages; Submissions is not. A caller who
   * reaches submissions through a form access tag or a location grant would
   * otherwise be shown four tabs and dead-end on a forbidden card for three of
   * them -- which is the "why is this button here if I can't use it" complaint
   * that has already been reported once on this feature.
   *
   * Defaults true so every existing admin-tier callsite is unchanged.
   */
  canBuild?: boolean;
}

export default function FormsAdminTabs({ formId, canBuild = true }: Props) {
  const pathname = usePathname() ?? "";

  const tabs: Array<{ href: string; label: string; active: boolean }> = [];

  if (canBuild) {
    tabs.push({
      href: "/admin/forms",
      label: "All Forms",
      active: pathname === "/admin/forms"
    });
  }

  if (formId) {
    if (canBuild) {
      tabs.push({
        href: `/admin/forms/${formId}`,
        label: "Builder",
        active: pathname === `/admin/forms/${formId}`
      });
    }
    tabs.push(
      {
        href: `/admin/forms/${formId}/submissions`,
        label: "Submissions",
        active: pathname.startsWith(`/admin/forms/${formId}/submissions`)
      },
    );
    if (canBuild) {
      tabs.push({
        href: `/admin/forms/${formId}/versions`,
        label: "Versions",
        active: pathname.startsWith(`/admin/forms/${formId}/versions`)
      });
    }
  }

  // A single tab is a label, not navigation.
  if (tabs.length < 2) return null;

  return (
    <nav aria-label="Forms admin sections" className="mb-5 flex gap-2">
      {tabs.map((t) => {
        const cls = t.active
          ? "inline-flex items-center rounded-full border border-splash-blue bg-splash-blue px-4 py-1.5 text-sm font-bold text-white shadow-splash-btn"
          : "inline-flex items-center rounded-full border border-splash-blue bg-white px-4 py-1.5 text-sm font-bold text-splash-blue hover:bg-splash-blue/5";
        return (
          <Link
            key={t.href}
            href={t.href}
            aria-current={t.active ? "page" : undefined}
            className={cls}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
