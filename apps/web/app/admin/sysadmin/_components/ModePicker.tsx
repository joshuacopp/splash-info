// Two-mode hub picker. Brief 30 / Option A — URL-search-param-driven.
// Renders two large buttons; the active mode gets filled splash-blue
// background. No JS — both buttons are <Link>s so the server-rendered
// page swaps to the chosen section on navigation.
//
// Audit-log filter params (`audit_*`) are preserved on mode swap so the
// operator's filtered view of the log doesn't reset when they flip
// between Manage Users / Manage Tables. The `audit_offset` is also
// preserved.

import Link from "next/link";

export type SysadminMode = "users" | "tables";

interface ModePickerProps {
  activeMode: SysadminMode;
  /** Search params currently on the URL — passed through to preserve
   *  audit_* filters when the user flips modes. */
  searchParams: Record<string, string | string[] | undefined>;
}

function buildModeHref(
  mode: SysadminMode,
  sp: Record<string, string | string[] | undefined>
): string {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (k === "mode") continue;
    if (typeof v === "string" && v.length > 0) usp.set(k, v);
  }
  usp.set("mode", mode);
  return `/admin/sysadmin?${usp.toString()}`;
}

export function ModePicker({ activeMode, searchParams }: ModePickerProps) {
  return (
    <nav
      aria-label="Sysadmin mode"
      className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-2"
    >
      <ModeButton
        title="Manage Users"
        operationCount={5}
        active={activeMode === "users"}
        href={buildModeHref("users", searchParams)}
      />
      <ModeButton
        title="Manage Tables"
        operationCount={3}
        active={activeMode === "tables"}
        href={buildModeHref("tables", searchParams)}
      />
    </nav>
  );
}

function ModeButton({
  title,
  operationCount,
  active,
  href
}: {
  title: string;
  operationCount: number;
  active: boolean;
  href: string;
}) {
  const cls = active
    ? "block rounded-splash-lg border-[1.5px] border-splash-blue bg-splash-blue px-5 py-4 text-left shadow-splash-card"
    : "block rounded-splash-lg border-[1.5px] border-gray-light bg-white px-5 py-4 text-left shadow-splash-card hover:border-splash-blue/50 hover:shadow-splash-card-hover";
  const titleCls = active
    ? "text-base font-bold text-white"
    : "text-base font-bold text-splash-navy";
  const subCls = active
    ? "mt-0.5 text-xs text-white/80"
    : "mt-0.5 text-xs text-splash-navy/60";
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cls}
    >
      <div className={titleCls}>{title}</div>
      <div className={subCls}>
        {operationCount} operation{operationCount === 1 ? "" : "s"}
      </div>
    </Link>
  );
}
