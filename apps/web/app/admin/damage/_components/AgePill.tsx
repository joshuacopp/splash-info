// Age-since-submission pill rendered in the /admin/damage list (Brief 68).
// Mirrors the legacy/damagemanager.js renderAgeBadge helper. Open claims get
// a four-tier color escalation; Closed claims render a muted neutral pill so
// the column stays aligned without adding visual noise to terminal items.
//
// Thresholds (4 / 8 / 15 days) are inline by design — operator tunes by
// editing these constants and pushing.

import type { LifecycleState } from "@splash/types/claims";

type Tier = "neutral" | "amber" | "orange" | "red";

const TIER_CLASSES: Record<Tier, string> = {
  neutral: "bg-gray-light/60 text-splash-navy/70",
  amber: "bg-yellow-100 text-yellow-900",
  orange: "bg-orange-100 text-orange-900",
  red: "bg-splash-deny/20 text-splash-deny"
};

function tierFor(ageDays: number): Tier {
  if (ageDays >= 15) return "red";
  if (ageDays >= 8) return "orange";
  if (ageDays >= 4) return "amber";
  return "neutral";
}

export function AgePill({
  ageDays,
  lifecycle
}: {
  ageDays: number;
  lifecycle: LifecycleState;
}) {
  const days = Math.max(0, Math.trunc(ageDays));
  const cls =
    lifecycle === "Open"
      ? TIER_CLASSES[tierFor(days)]
      : TIER_CLASSES.neutral;
  const label = days === 0 ? "<1d" : `${days}d`;
  const title =
    lifecycle === "Open"
      ? `${days} day${days === 1 ? "" : "s"} since submission`
      : `Closed; ${days} day${days === 1 ? "" : "s"} from submission to last status change`;
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${cls}`}
      title={title}
    >
      {label}
    </span>
  );
}
