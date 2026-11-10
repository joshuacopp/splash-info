"use client";

// Client wrapper that binds a form's JotForm report definition to the shared
// ReportTable (report kit). Exists because the definition holds functions,
// which the server page cannot pass to a client component -- so the page
// passes the form id and the rows, and the definition is built here.

import Link from "next/link";
import { useMemo } from "react";
import { formatEtDateTime } from "@splash/report-kit";
import {
  jotformReportFor,
  type JotformReportRow
} from "@splash/report-kit/reports/jotform";

import { ReportTable } from "../../../../_components/report/ReportTable";

const cells = {
  // One line: a wrapped timestamp makes every row twice as tall.
  jotform_created_at: (r: JotformReportRow) =>
    r.jotform_created_at ? (
      <span className="whitespace-nowrap">{formatEtDateTime(r.jotform_created_at)}</span>
    ) : (
      <span className="text-splash-navy/50">—</span>
    )
};

export function JotformTable({
  formId,
  rows
}: {
  formId: string;
  rows: JotformReportRow[];
}) {
  const def = useMemo(() => jotformReportFor(formId), [formId]);
  const extraColumns = useMemo(
    () => [
      {
        id: "view",
        header: "",
        cell: (r: JotformReportRow) => (
          <Link
            href={`/admin/jotform/${encodeURIComponent(formId)}/${encodeURIComponent(r.id)}`}
            className="whitespace-nowrap text-splash-blue hover:underline"
          >
            View →
          </Link>
        )
      }
    ],
    [formId]
  );
  return (
    <ReportTable
      def={def}
      rows={rows}
      cells={cells}
      extraColumns={extraColumns}
      initialSort={{ id: "jotform_created_at", desc: true }}
      emptyText="No submissions in this date range."
    />
  );
}
