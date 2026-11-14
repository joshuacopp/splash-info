// Price Match -- email NCS a price-match request (/admin/price-match).
//
// Gate: the `price_match` grant, and ONLY that -- super_admin does not imply
// it (operator, 2026-11-14: "for now only granted to me"). The worker
// re-checks; this just keeps the form off screens that cannot use it.

import Link from "next/link";
import { getMe } from "../../_lib/me";
import NoAccessCard from "../forms/_components/NoAccessCard";
import { getOverview } from "./_lib/worker-fetch";
import PriceMatchForm from "./PriceMatchForm";

export const dynamic = "force-dynamic";

function formatEt(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(iso));
}

export default async function PriceMatchPage() {
  const session = await getMe().catch(() => null);
  if (!session) return <NoAccessCard reason="signin" returnPath="/admin/price-match" />;
  const allowed = (session.tools as readonly string[]).includes("price_match");
  const overview = allowed ? await getOverview() : null;

  return (
    <section className="mx-auto w-full max-w-[1400px] px-5 py-9">
      <div className="mb-2 text-sm">
        <Link href="/admin/dashboard/operations" className="text-splash-blue hover:underline">
          ← Operations
        </Link>
      </div>
      <p className="mb-1 text-xs font-semibold uppercase tracking-[0.18em] text-sudsy-blue">NCS</p>
      <h1 className="text-2xl font-bold text-splash-navy">Price Match</h1>
      <p className="mb-5 mt-1 text-sm text-splash-navy/70">
        NCS matches competitor pricing. List the parts with both prices, attach the competitor&apos;s quote or link
        their pages, and this sends NCS the request with a spreadsheet of the same table.
      </p>

      {!allowed ? (
        <p className="rounded-splash-md border border-gray-light bg-white px-4 py-8 text-center text-splash-navy/70">
          Price Match isn&apos;t turned on for your login.
        </p>
      ) : !overview ? (
        <p className="rounded-splash-md border border-racecar-red bg-white px-3 py-2 text-racecar-red">
          Could not load Price Match. Try again in a moment.
        </p>
      ) : (
        <>
          <PriceMatchForm
            live={overview.live}
            to={overview.to}
            cc={overview.cc}
            liveRecipients={overview.live_recipients}
            senderEmail={session.email}
            competitors={[...new Set(overview.requests.map((r) => r.competitor))]}
          />

          <h2 className="mb-2 mt-10 text-lg font-bold text-splash-navy">Sent requests</h2>
          {overview.requests.length === 0 ? (
            <p className="rounded-splash-md border border-gray-light bg-white px-4 py-6 text-center italic text-splash-navy/60">
              Nothing sent yet.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-splash-md border-[1.5px] border-splash-navy/15 bg-white shadow-splash-card">
              <table className="w-full text-left text-sm">
                <thead className="bg-gray-light/50 text-xs uppercase tracking-wide text-splash-navy/60">
                  <tr>
                    <th className="px-3 py-2">#</th>
                    <th className="px-3 py-2">Sent</th>
                    <th className="px-3 py-2">Competitor</th>
                    <th className="px-3 py-2">Parts</th>
                    <th className="px-3 py-2">Attachments</th>
                    <th className="px-3 py-2">To</th>
                    <th className="px-3 py-2">By</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-light">
                  {overview.requests.map((r) => (
                    <tr key={r.id} className="align-top">
                      <td className="whitespace-nowrap px-3 py-2 font-semibold">
                        {r.ref_no}
                        {r.test && (
                          <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800">
                            Test
                          </span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-splash-navy/70">{formatEt(r.created_at)}</td>
                      <td className="px-3 py-2">{r.competitor}</td>
                      <td className="px-3 py-2" title={r.lines.map((l) => l.part).join("\n")}>
                        {r.lines.length}
                        <span className="text-splash-navy/50">
                          {" "}
                          · {r.lines.slice(0, 2).map((l) => l.part).join(", ")}
                          {r.lines.length > 2 ? "…" : ""}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-splash-navy/70">{r.files.map((f) => f.filename).join(", ")}</td>
                      <td className="px-3 py-2 text-splash-navy/70">
                        {r.sent_to}
                        {r.sent_cc.length > 0 && <div className="text-xs">CC {r.sent_cc.join(", ")}</div>}
                      </td>
                      <td className="px-3 py-2 text-splash-navy/70">{r.created_by_email}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}
