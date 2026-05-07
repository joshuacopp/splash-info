// Brief 70 — empty state for /workorders when zero open WOs match the
// caller's scope.

export function EmptyState() {
  return (
    <div className="rounded-splash-lg border border-gray-light bg-white px-6 py-10 text-center">
      <p className="text-base font-semibold text-splash-navy">
        No open work orders for your locations.
      </p>
      <p className="mt-1 text-sm text-splash-navy/70">
        For closed work orders, log into MaintainX directly.
      </p>
      <p className="mt-4">
        <a
          href="https://app.getmaintainx.com/workorders"
          target="_blank"
          rel="noreferrer"
          className="text-sm font-semibold text-splash-blue hover:underline"
        >
          Open MaintainX ↗
        </a>
      </p>
    </div>
  );
}
