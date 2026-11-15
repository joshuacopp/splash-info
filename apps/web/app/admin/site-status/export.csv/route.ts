// CSV of site closures for the report period. Built here from the same JSON
// the reports page reads, with the shared definition's columns
// (@splash/report-kit/reports/site-closures), so the file always matches the
// page.

import { csvResponseHeaders, exportFilename, parseReportParams, toCsv } from "@splash/report-kit";
import { siteClosuresReport, toClosureRows } from "@splash/report-kit/reports/site-closures";
import { getReport } from "../_lib/worker-fetch";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const sp = Object.fromEntries(new URL(req.url).searchParams.entries());
  const { range } = parseReportParams(siteClosuresReport, sp);
  const res = await getReport(range.fromIso, range.toIso);
  if (!("data" in res)) return new Response("Couldn't load the report.", { status: res.status === 401 ? 401 : 502 });
  const rows = toClosureRows(res.data.closures, new Date(res.data.now));
  return new Response(toCsv(siteClosuresReport, rows), {
    headers: csvResponseHeaders(exportFilename(siteClosuresReport, range, "csv"))
  });
}
