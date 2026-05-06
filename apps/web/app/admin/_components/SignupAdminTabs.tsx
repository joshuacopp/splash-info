// Brief 56 — Signup Admin tab nav.
//
// Mounted above the four pages under the Signup Admin umbrella:
//   /admin/pricing                          (active="pricing", locationCode=null)
//   /admin/pricing/{loc}                    (active="pricing", locationCode={loc})
//   /admin/signups                          (active="signups", locationCode=null)
//   /admin/signups/{loc}                    (active="signups", locationCode={loc})
//
// `active` is passed explicitly by the owning page (no pathname matching).
// `locationCode` preserves the per-location context across the flip — when
// set, the tabs link sibling-with-location URLs; when null, they link the
// landing list pages.
//
// Server component. No JS — both tabs are next/link <Link>s. Aesthetic
// mirrors sysadmin's ModePicker (Brief 30) but as a horizontal pill row
// so it fits naturally above the existing per-page H1.

import Link from "next/link";

interface SignupAdminTabsProps {
  /** Per-location context. When null, tabs link to the landing pages. */
  locationCode: string | null;
  /** Which tab is currently active — owning page passes this explicitly. */
  active: "pricing" | "signups";
}

export function SignupAdminTabs({ locationCode, active }: SignupAdminTabsProps) {
  const pricingHref = locationCode
    ? `/admin/pricing/${encodeURIComponent(locationCode)}`
    : "/admin/pricing";
  const signupsHref = locationCode
    ? `/admin/signups/${encodeURIComponent(locationCode)}`
    : "/admin/signups";

  return (
    <nav aria-label="Signup Admin sections" className="mb-5 flex gap-2">
      <Tab href={pricingHref} label="Pricing" active={active === "pricing"} />
      <Tab href={signupsHref} label="Signups" active={active === "signups"} />
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
