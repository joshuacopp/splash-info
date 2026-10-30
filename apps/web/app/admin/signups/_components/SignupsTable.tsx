"use client";

// Client wrapper that binds the signups report definition to the shared
// ReportTable (Brief 179). Exists because the definition holds functions,
// which the server page cannot pass to a client component.

import { signupsReport, type SignupsReportRow } from "@splash/report-kit/reports/signups";

import { ReportTable } from "../../../_components/report/ReportTable";

export function SignupsTable({ rows }: { rows: SignupsReportRow[] }) {
  return (
    <ReportTable
      def={signupsReport}
      rows={rows}
      totals={["today_price"]}
      initialSort={{ id: "submitted_at", desc: true }}
      emptyText="No signups in this date range."
    />
  );
}
