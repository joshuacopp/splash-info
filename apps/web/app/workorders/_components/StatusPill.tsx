// Brief 70 + Brief 71 — MaintainX status pill. Three states (OPEN /
// IN_PROGRESS / ON_HOLD); the workorders endpoint filters out the other
// three MaintainX statuses upstream.
//
// Brief 71: keys on the UPPERCASED upstream enum value to defend against
// any case-variant MaintainX might emit. Brief 70 shipped with a
// case-sensitive lookup that left IN_PROGRESS rows rendering as plain
// text "In Progress" (no pill background) when the upstream value
// matched any other shape.

const CLASSES: Record<string, string> = {
  OPEN: "bg-sudsy-blue/20 text-splash-navy",
  IN_PROGRESS: "bg-amber-100 text-amber-900",
  ON_HOLD: "bg-gray-light/60 text-splash-navy/70"
};

const LABELS: Record<string, string> = {
  OPEN: "Open",
  IN_PROGRESS: "In Progress",
  ON_HOLD: "On Hold"
};

export function StatusPill({ status }: { status: string }) {
  const key = (status ?? "").trim().toUpperCase();
  const cls = CLASSES[key] ?? CLASSES.ON_HOLD;
  const label = LABELS[key] ?? status;
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${cls}`}
    >
      {label}
    </span>
  );
}
