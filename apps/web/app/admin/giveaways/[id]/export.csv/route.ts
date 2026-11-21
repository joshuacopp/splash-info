// CSV of one giveaway's entries, built here from the same JSON the page reads
// with the shared definition's columns
// (@splash/report-kit/reports/giveaway-entries), so the file always matches
// the table. The worker decides access (admin tier or the `giveaways` grant).

import { csvResponseHeaders, toCsv } from "@splash/report-kit";
import { giveawayEntriesFilename, giveawayEntriesReport } from "@splash/report-kit/reports/giveaway-entries";
import { getGiveaway } from "../../_lib/worker-fetch";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  const res = await getGiveaway(id);
  if (!("data" in res)) {
    return new Response(res.error ?? "Couldn't load the entries.", {
      status: res.status === 401 || res.status === 403 || res.status === 404 ? res.status : 502
    });
  }
  const { giveaway, entries, today } = res.data;
  return new Response(toCsv(giveawayEntriesReport, entries), {
    headers: csvResponseHeaders(giveawayEntriesFilename(giveaway.title, today))
  });
}
