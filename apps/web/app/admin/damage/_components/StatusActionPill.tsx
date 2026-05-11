// Brief 101 — small visual indicator beside a claim status that makes
// specific pending-action states obvious. Today the only status that
// surfaces a pill is "Approved — Pending Quotes" (operator asked for a
// clear "needs quotes" signal so GMs know to upload). Adding more
// states later is a single map entry below.
//
// Mirrors AgePill.tsx: utility-class pill, server-renderable, no
// shared package dependency. Returns null for any status not in the
// map so callers can drop it inline without branching.

import type { ClaimStatus } from "@splash/types/claims";

interface PillConfig {
  label: string;
  classes: string;
  title?: string;
}

const STATUS_ACTION_PILLS: Partial<Record<ClaimStatus, PillConfig>> = {
  "Approved — Pending Quotes": {
    label: "Needs quotes",
    classes: "bg-amber-100 text-amber-900 ring-1 ring-amber-300",
    title: "GM should upload one or more quotes from approved vendors."
  }
};

export function StatusActionPill({ status }: { status: ClaimStatus }) {
  const config = STATUS_ACTION_PILLS[status];
  if (!config) return null;
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${config.classes}`}
      title={config.title}
    >
      {config.label}
    </span>
  );
}
