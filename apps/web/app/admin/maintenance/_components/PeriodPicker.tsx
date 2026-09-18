// Reporting-period selector.
//
// URL-driven (`?period=`) and paired with `?tab=`, so a link carries both and
// the page stays a server component with no client state.
//
// The LABELS live here; the BOUNDARIES live in the worker (resolvePeriod). One
// definition of "this week" server-side means two people reading the same link
// see the same range, and the page never has to agree with the worker about
// when a quarter starts.

import Link from "next/link";
import { MAINTENANCE_PERIODS } from "../_lib/worker-fetch";
import type { MaintenanceTab } from "./MaintenanceTabs";

export function resolvePeriodParam(raw: string | string[] | undefined): string {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return MAINTENANCE_PERIODS.some((p) => p.id === v) ? (v as string) : "current_month";
}

export function PeriodPicker({
  active,
  tab,
  from,
  to
}: {
  active: string;
  tab: MaintenanceTab;
  from: string;
  to: string;
}) {
  return (
    <div className="mb-6">
      <nav aria-label="Reporting period" className="flex flex-wrap gap-1.5">
        {MAINTENANCE_PERIODS.map((p) => {
          const on = p.id === active;
          return (
            <Link
              key={p.id}
              href={`/admin/maintenance?tab=${tab}&period=${p.id}`}
              aria-current={on ? "true" : undefined}
              className={
                on
                  ? "inline-flex items-center rounded-full bg-splash-navy px-3 py-1 text-xs font-bold text-white"
                  : "inline-flex items-center rounded-full border border-gray-light bg-white px-3 py-1 text-xs font-semibold text-splash-navy/70 hover:bg-gray-light/40"
              }
            >
              {p.label}
            </Link>
          );
        })}
      </nav>
      <p className="mt-1.5 text-xs text-splash-navy/50">
        {from} to {to} &mdash; end date exclusive. Periods run on the mechanics&rsquo;
        local (Eastern) calendar day, and weeks start Monday.
      </p>
    </div>
  );
}
