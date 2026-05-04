// Shared lifecycle pill used by /admin/damage (list) and /admin/damage/[id]
// (detail). Open and Closed are the only two states; styling matches the
// dashboard tile palette — splash-success-tinted bg for Open, neutral
// splash-navy/10 for Closed.

import type { LifecycleState } from "@splash/types/claims";

export function LifecycleBadge({ state }: { state: LifecycleState }) {
  const cls =
    state === "Open"
      ? "bg-splash-success/15 text-splash-success"
      : "bg-splash-navy/10 text-splash-navy/80";
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${cls}`}
    >
      {state}
    </span>
  );
}
