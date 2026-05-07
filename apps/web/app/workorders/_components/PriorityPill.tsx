// Brief 70 — MaintainX priority pill. Four states (HIGH / MEDIUM / LOW /
// NONE) with color escalation. Same rounded-full pill shape as Brief 68/69's
// AgePill so the page's row chrome stays visually consistent.

const CLASSES: Record<string, string> = {
  HIGH: "bg-splash-deny/20 text-splash-deny",
  MEDIUM: "bg-yellow-100 text-yellow-900",
  LOW: "bg-sudsy-blue/20 text-splash-navy",
  NONE: "bg-gray-light/60 text-splash-navy/70"
};

const LABELS: Record<string, string> = {
  HIGH: "High",
  MEDIUM: "Medium",
  LOW: "Low",
  NONE: "—"
};

export function PriorityPill({ priority }: { priority: string }) {
  const key = priority in CLASSES ? priority : "NONE";
  const cls = CLASSES[key] ?? CLASSES.NONE;
  const label = LABELS[key] ?? priority;
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${cls}`}
      title={`Priority: ${label}`}
    >
      {label}
    </span>
  );
}
