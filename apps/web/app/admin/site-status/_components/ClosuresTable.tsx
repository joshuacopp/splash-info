"use client";

// Binds the site closures report definition to the shared ReportTable. A
// client wrapper because the definition holds functions.

import { siteClosuresReport, type SiteClosureRow } from "@splash/report-kit/reports/site-closures";
import { ReportTable } from "../../../_components/report/ReportTable";

export function ClosuresTable({ rows }: { rows: SiteClosureRow[] }) {
  return (
    <ReportTable
      def={siteClosuresReport}
      rows={rows}
      cells={{
        estimate_notes: (r) => (r.estimate_notes ? <span className="whitespace-pre-line text-xs">{r.estimate_notes}</span> : ""),
        still_closed: (r) =>
          r.still_closed ? (
            <span className="rounded-full bg-splash-deny/15 px-2 py-0.5 text-xs font-bold text-splash-deny">Closed</span>
          ) : (
            ""
          )
      }}
    />
  );
}
