// Brief 59 — Damage tab nav.
//
// Mounted above:
//   /admin/damage           (active="claims")
//   /admin/damage/reporting (active="reporting")
//
// Visual style mirrors SignupAdminTabs (Brief 56) — pill row.
// `active` is passed explicitly by the owning page; no pathname matching.
//
// The detail page /admin/damage/[id] intentionally does NOT mount this nav
// (it's a deeper drill-down inside Claims).

import Link from "next/link";

interface DamageTabsProps {
  active: "claims" | "reporting" | "car-counts";
}

export function DamageTabs({ active }: DamageTabsProps) {
  return (
    <nav aria-label="Damage sections" className="mb-5 flex gap-2">
      <Tab href="/admin/damage" label="Claims" active={active === "claims"} />
      <Tab
        href="/admin/damage/reporting"
        label="Reporting"
        active={active === "reporting"}
      />
      <Tab
        href="/admin/damage/car-counts"
        label="Car Counts"
        active={active === "car-counts"}
      />
    </nav>
  );
}

function Tab({
  href,
  label,
  active
}: {
  href: string;
  label: string;
  active: boolean;
}) {
  const cls = active
    ? "inline-flex items-center rounded-full border border-splash-blue bg-splash-blue px-4 py-1.5 text-sm font-bold text-white shadow-splash-btn"
    : "inline-flex items-center rounded-full border border-splash-blue bg-white px-4 py-1.5 text-sm font-bold text-splash-blue hover:bg-splash-blue/5";
  return (
    <Link href={href} aria-current={active ? "page" : undefined} className={cls}>
      {label}
    </Link>
  );
}
