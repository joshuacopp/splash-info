// Brief 125 — Form builder section tabs (Fields | Workflow | Settings).
//
// URL-driven via `?tab=fields|workflow|settings`. Default `fields` when
// omitted (back-compat for direct URLs / existing bookmarks). Rendered as
// a client component because BuilderClient owns the active tab state via
// the URL search param.

"use client";

import Link from "next/link";

export type BuilderTab = "fields" | "workflow" | "settings";

interface Props {
  formId: string;
  active: BuilderTab;
}

const TABS: ReadonlyArray<{ id: BuilderTab; label: string }> = [
  { id: "fields", label: "Fields" },
  { id: "workflow", label: "Workflow" },
  { id: "settings", label: "Settings" }
];

export default function FormBuilderTabs({ formId, active }: Props) {
  return (
    <nav
      aria-label="Form builder sections"
      className="mb-4 flex gap-2 border-b border-gray-light pb-3"
    >
      {TABS.map((t) => {
        const isActive = t.id === active;
        const href =
          t.id === "fields"
            ? `/admin/forms/${formId}`
            : `/admin/forms/${formId}?tab=${t.id}`;
        const cls = isActive
          ? "inline-flex items-center rounded-full border border-splash-navy bg-splash-navy px-4 py-1.5 text-sm font-bold text-white shadow-splash-btn"
          : "inline-flex items-center rounded-full border border-splash-navy bg-white px-4 py-1.5 text-sm font-bold text-splash-navy hover:bg-splash-navy/5";
        return (
          <Link
            key={t.id}
            href={href}
            aria-current={isActive ? "page" : undefined}
            className={cls}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
