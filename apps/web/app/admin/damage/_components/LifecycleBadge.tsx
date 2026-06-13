// Shared lifecycle pill used by /admin/damage (list) and /admin/damage/[id]
// (detail).
//
// Brief 172 widened the state from binary `LifecycleState` (stored on the
// row) to the 3-way derived `DisplayLifecycleState`. Renderers must call
// `displayLifecycleForStatus(claim.claim_status)` to compute the state
// they pass in — the stored `claims.lifecycle_state` column is still
// binary (CHECK constraint forbids a third value; SQLite can't ALTER it).
//
// Color tokens:
//   Open              → success-green (in-flight; ops team's queue)
//   Awaiting Payment  → amber (post-quote-approval, sitting with finance/AP)
//   Closed            → neutral navy (terminal)

import type { DisplayLifecycleState } from "@splash/types/claims";

export function LifecycleBadge({ state }: { state: DisplayLifecycleState }) {
  let cls = "bg-splash-navy/10 text-splash-navy/80";
  if (state === "Open") {
    cls = "bg-splash-success/15 text-splash-success";
  } else if (state === "Awaiting Payment") {
    cls = "bg-amber-100 text-amber-900";
  }
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${cls}`}
    >
      {state}
    </span>
  );
}
