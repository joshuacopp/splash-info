"use client";

// Client wrapper that binds the fleet report definition to the shared
// ReportTable (Brief 179). Exists because the definition holds functions,
// which the server page cannot pass to a client component.

import Link from "next/link";
import { fleetReport, type FleetReportRow } from "@splash/report-kit/reports/fleet";

import { ReportTable } from "../../../_components/report/ReportTable";
import { FLEET_STATUS_PILL_CLASS, isFleetStatus } from "../_lib/constants";

function StatusPill({ status }: { status: string | null }) {
  const label = status ?? "new";
  const cls = isFleetStatus(label) ? FLEET_STATUS_PILL_CLASS[label] : FLEET_STATUS_PILL_CLASS.default;
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-bold ${cls}`}>
      {label}
    </span>
  );
}

const cells = {
  name: (r: FleetReportRow) => (
    <>
      <div className="font-semibold">{r.name ?? "—"}</div>
      {r.company && <div className="text-xs text-splash-navy/60">{r.company}</div>}
    </>
  ),
  status: (r: FleetReportRow) => <StatusPill status={r.status} />
};

const extraColumns = [
  {
    id: "view",
    header: "",
    cell: (r: FleetReportRow) => (
      <Link
        href={`/admin/fleet/${encodeURIComponent(String(r.id))}`}
        className="text-splash-blue hover:underline"
      >
        View
      </Link>
    )
  }
];

export function FleetTable({ rows }: { rows: FleetReportRow[] }) {
  return (
    <ReportTable
      def={fleetReport}
      rows={rows}
      cells={cells}
      extraColumns={extraColumns}
      initialSort={{ id: "submitted_at", desc: true }}
      emptyText="No submissions in this date range."
    />
  );
}
