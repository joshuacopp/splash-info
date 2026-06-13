// Age-since-submission pill rendered in the /admin/damage list (Brief 68).
// Mirrors the legacy/damagemanager.js renderAgeBadge helper. Open claims get
// a color escalation; Closed claims render a muted neutral pill so the
// column stays aligned without adding visual noise to terminal items.
//
// Brief 69 (2026-05-07): collapsed Brief 68's four-tier curve to two tiers
// per operator's ask. Yellow at >3d, red at >10d. Fewer color changes makes
// the urgency signal clearer at a glance. Tune by editing the constants
// below and pushing.
//
// Brief 172: takes the 3-way DisplayLifecycleState. "Awaiting Payment"
// claims are NOT in the ops team's queue (they're with finance/AP), so
// they render with the same muted neutral pill as Closed — no
// escalation, since the ops team has no remaining action.

import type { DisplayLifecycleState } from "@splash/types/claims";

type Tier = "neutral" | "yellow" | "red";

const TIER_CLASSES: Record<Tier, string> = {
  neutral: "bg-gray-light/60 text-splash-navy/70",
  yellow: "bg-yellow-100 text-yellow-900",
  red: "bg-splash-deny/20 text-splash-deny"
};

function tierFor(ageDays: number): Tier {
  if (ageDays >= 11) return "red";
  if (ageDays >= 4) return "yellow";
  return "neutral";
}

export function AgePill({
  ageDays,
  lifecycle
}: {
  ageDays: number;
  lifecycle: DisplayLifecycleState;
}) {
  const days = Math.max(0, Math.trunc(ageDays));
  const cls =
    lifecycle === "Open"
      ? TIER_CLASSES[tierFor(days)]
      : TIER_CLASSES.neutral;
  const label = days === 0 ? "<1d" : `${days}d`;
  let title: string;
  if (lifecycle === "Open") {
    title = `${days} day${days === 1 ? "" : "s"} since submission`;
  } else if (lifecycle === "Awaiting Payment") {
    title = `Awaiting Payment; ${days} day${days === 1 ? "" : "s"} since submission`;
  } else {
    title = `Closed; ${days} day${days === 1 ? "" : "s"} from submission to last status change`;
  }
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${cls}`}
      title={title}
    >
      {label}
    </span>
  );
}
