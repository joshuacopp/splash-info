// Brief 70 — MaintainX status pill. Three states (OPEN / IN_PROGRESS /
// ON_HOLD); the workorders endpoint filters out the other three MaintainX
// statuses upstream.

const CLASSES: Record<string, string> = {
  OPEN: "bg-sudsy-blue/20 text-splash-navy",
  IN_PROGRESS: "bg-yellow-100 text-yellow-900",
  ON_HOLD: "bg-gray-light/60 text-splash-navy/70"
};

const LABELS: Record<string, string> = {
  OPEN: "Open",
  IN_PROGRESS: "In Progress",
  ON_HOLD: "On Hold"
};

export function StatusPill({ status }: { status: string }) {
  const cls = CLASSES[status] ?? CLASSES.ON_HOLD;
  const label = LABELS[status] ?? status;
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${cls}`}
    >
      {label}
    </span>
  );
}
