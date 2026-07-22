// Brief 80 — MaintainX work-request status pill for the Requests sub-tab.
// Only two states surface here (PENDING / REJECTED); APPROVED and DONE are
// filtered out upstream because they've been promoted to work orders and
// appear on the Reactive/Preventative tabs instead.
//
// Keyed on the UPPERCASED `requestStatus` value, mirroring StatusPill's
// case-defensive lookup.

const CLASSES: Record<string, string> = {
  PENDING: "bg-amber-100 text-amber-900",
  REJECTED: "bg-splash-deny/15 text-splash-deny"
};

const LABELS: Record<string, string> = {
  PENDING: "Pending",
  REJECTED: "Rejected"
};

export function RequestStatusPill({ status }: { status: string }) {
  const key = (status ?? "").trim().toUpperCase();
  const cls = CLASSES[key] ?? CLASSES.PENDING;
  const label = LABELS[key] ?? status;
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${cls}`}
    >
      {label}
    </span>
  );
}
