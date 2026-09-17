// Maintenance tracker — Phase 4 dashboard.
//
// Admin-tier gated; the worker re-validates on every call as defense in depth.
// Everything rendered here comes from Postgres views (supabase/mt-*.sql), so
// the page has no numbers of its own and nothing here can drift from the
// definitions recorded alongside the SQL.
//
// THE CAVEATS ARE RENDERED, NOT DOCUMENTED. PLAN.md 8 is explicit that the
// firm caveat "on-site dwell is a ceiling on productive time, never evidence
// of it" belongs in the UI and not only in the plan, and that a large overhead
// figure is a fact about territory rather than about a person. A dashboard
// that shows these numbers without them manufactures confident-looking
// accusations out of ambiguity, which is the failure mode the whole design is
// built to avoid. Do not move them to a tooltip.

import { getMe } from "../../_lib/me";
import NoAccessCard from "../forms/_components/NoAccessCard";
import { getMaintenanceSummary, type MechanicRow } from "./_lib/worker-fetch";

export const dynamic = "force-dynamic";

const KIND_STYLE: Record<string, string> = {
  SITE: "bg-emerald-100 text-emerald-800",
  WAREHOUSE: "bg-blue-100 text-blue-800",
  MANAGEMENT: "bg-amber-100 text-amber-800",
  UNATTRIBUTED: "bg-gray-light text-splash-navy/70"
};

const KIND_LABEL: Record<string, string> = {
  SITE: "Sites",
  WAREHOUSE: "Warehouse",
  MANAGEMENT: "Management",
  UNATTRIBUTED: "Unattributed"
};

const TIER_STYLE: Record<string, string> = {
  GPS_CONFIRMED: "bg-emerald-100 text-emerald-800",
  INTERVAL_ONLY: "bg-blue-100 text-blue-800",
  PUNCH_ONLY: "bg-amber-100 text-amber-800",
  WO_NO_FIELD_EVIDENCE: "bg-gray-light text-splash-navy/70"
};

const TIER_LABEL: Record<string, string> = {
  GPS_CONFIRMED: "GPS confirmed at the site",
  INTERVAL_ONLY: "Status interval only",
  PUNCH_ONLY: "Punch overlap only",
  WO_NO_FIELD_EVIDENCE: "No field evidence"
};

function h(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 });
}
function pct(n: number | null | undefined): string {
  return n === null || n === undefined ? "—" : `${Number(n).toFixed(0)}%`;
}
function monthLabel(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

export default async function MaintenancePage() {
  const session = await getMe().catch(() => null);
  if (!session) return <NoAccessCard reason="signin" returnPath="/admin/maintenance" />;
  const allowed =
    session.role === "super_admin" ||
    session.dcRole === "admin" ||
    session.dcRole === "super_admin";
  if (!allowed) return <NoAccessCard reason="forbidden" />;

  const result = await getMaintenanceSummary();
  if (!result.ok) {
    return (
      <section className="mx-auto w-full max-w-[1100px] px-5 py-9">
        <h1 className="mb-4 text-2xl font-bold text-splash-navy">Maintenance tracker</h1>
        <div className="rounded-splash-lg border-[1.5px] border-amber-300 bg-amber-50 p-6">
          <p className="text-base font-semibold text-splash-navy">
            Could not load the tracker.
          </p>
          <p className="mt-2 text-sm text-splash-navy/80">{result.error}</p>
        </div>
      </section>
    );
  }
  const {
    cost_centres, sites, mechanics, tiers, crew_names, site_names, work_orders,
    devices, workload
  } = result.data;

  const badDevices = devices.filter((d) => d.device_status !== "OK");
  const silentIds = new Set(
    devices
      .filter((d) => d.device_status === "TRANSPONDER_SILENT")
      .map((d) => d.connecteam_user_id)
  );

  const siteLabel = (n: number) => site_names[String(n)] ?? `Site ${n}`;

  const months = [...new Set(cost_centres.map((c) => c.month))].sort().reverse();
  const latest = months[0];
  const latestCosts = cost_centres.filter((c) => c.month === latest);
  const totalH = latestCosts.reduce((a, c) => a + Number(c.hours), 0);
  const byKind = (["SITE", "WAREHOUSE", "MANAGEMENT", "UNATTRIBUTED"] as const).map((k) => {
    const rows = latestCosts.filter((c) => c.kind === k);
    return { kind: k, hours: rows.reduce((a, c) => a + Number(c.hours), 0), count: rows.length };
  });

  // Work orders for the rendered month, bucketed by site so each <details>
  // can read its own list without rescanning the array.
  const woBySite = new Map<number, typeof work_orders>();
  for (const w of work_orders) {
    if (w.month !== latest) continue;
    const list = woBySite.get(w.site_number);
    if (list) list.push(w);
    else woBySite.set(w.site_number, [w]);
  }

  // EVERY site, not a top-N. A truncated list is useless for the question this
  // table actually gets asked ("what happened at MY site"), and the cap also
  // hid the more interesting row: sites with work orders and NO recorded hours.
  //
  // The list is the UNION of sites with GPS hours and sites with reactive work
  // orders closed this month. Showing only the former under-reports by 13 --
  // 56 sites have hours, 69 have work orders -- and every one of those 13 is a
  // site where work demonstrably happened and the tracker cannot see the visit.
  const hoursBySite = new Map(
    sites.filter((s) => s.month === latest).map((s) => [s.site_number, s])
  );
  const allSiteNumbers = [
    ...new Set([...hoursBySite.keys(), ...woBySite.keys()])
  ].sort((a, b) => siteLabel(a).localeCompare(siteLabel(b)));

  const noHourSites = allSiteNumbers.filter((sn) => !hoursBySite.has(sn));
  const gapSites = noHourSites.filter((sn) =>
    (woBySite.get(sn) ?? []).some((w) => w.implies_site_visit)
  ).length;
  const explainedSites = noHourSites.length - gapSites;

  const weeks = [...new Set(mechanics.map((m) => m.week_starting))].sort().reverse();
  const latestWeek = weeks[0];
  const latestMechanics: MechanicRow[] = mechanics
    .filter((m) => m.week_starting === latestWeek)
    .sort((a, b) => Number(b.paid_h) - Number(a.paid_h));
  const tierTotal = tiers.reduce((a, t) => a + t.rows, 0);

  return (
    <section className="mx-auto w-full max-w-[1100px] px-5 py-9">
      <div className="mb-6">
        <p className="mb-1 text-xs font-semibold uppercase tracking-[0.18em] text-sudsy-blue">
          Internal Tools
        </p>
        <h1 className="text-2xl font-bold text-splash-navy">Maintenance tracker</h1>
        <p className="mt-1 text-sm text-splash-navy/70">
          Where paid maintenance hours go, from Connecteam punches, Geotab GPS and
          MaintainX. {latest ? monthLabel(latest) : "No data"}.
        </p>
      </div>

      {/* Reading rules. First, not last: every number below is easy to misread. */}
      <div className="mb-7 rounded-splash-lg border-[1.5px] border-amber-300 bg-amber-50 p-5">
        <p className="mb-2 text-sm font-bold text-splash-navy">Before reading these numbers</p>
        <ul className="list-disc space-y-1.5 pl-5 text-[0.875rem] leading-relaxed text-splash-navy/85">
          <li>
            <strong>On-site hours are a ceiling on productive time, never evidence of
            it.</strong> GPS tracks a vehicle and Connecteam records a button press.
            Neither observes work.
          </li>
          <li>
            <strong>A large Management figure is about territory, not about a
            person.</strong> It is mostly the drive home, and someone with a long commute
            posts a big number through no fault of their own. Do not rank people on it.
          </li>
          <li>
            <strong>Low on-site time with high &ldquo;no GPS&rdquo; is silence, not
            idleness.</strong> The two are indistinguishable without looking at both.
          </li>
          <li>
            Where a number raises a question, the output is a question for a supervisor
            to ask &mdash; not a finding.
          </li>
        </ul>
      </div>

      {/* Cost centre allocation — the headline. */}
      <h2 className="mb-1 text-lg font-bold text-splash-navy">Where the hours went</h2>
      <p className="mb-3 text-sm text-splash-navy/70">
        Every paid hour lands in exactly one cost centre. The drive home is charged to
        Management, not to the last site worked.
      </p>
      <div className="mb-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {byKind.map((k) => (
          <div
            key={k.kind}
            className="rounded-splash-lg border-[1.5px] border-gray-light bg-white p-5 shadow-splash-card"
          >
            <span
              className={`inline-block rounded-full px-2.5 py-0.5 text-[0.6875rem] font-bold uppercase tracking-wide ${KIND_STYLE[k.kind]}`}
            >
              {KIND_LABEL[k.kind] ?? k.kind}
            </span>
            <p className="mt-3 text-3xl font-bold text-splash-navy">{h(k.hours)}<span className="ml-1 text-base font-semibold text-splash-navy/60">h</span></p>
            <p className="mt-1 text-sm text-splash-navy/70">
              {totalH ? `${((100 * k.hours) / totalH).toFixed(1)}% of paid time` : "—"}
              {k.kind === "SITE" ? ` · ${k.count} sites` : ""}
            </p>
            {k.kind === "UNATTRIBUTED" ? (
              <p className="mt-2 text-xs leading-relaxed text-splash-navy/60">
                Stopped somewhere unnamed, plus time the tracker reported nothing for.
                Not a geofence problem &mdash; only 3% of it is within 150&nbsp;m of a
                site fence. Mostly one-off stops and time at home.
              </p>
            ) : null}
            {k.kind === "WAREHOUSE" ? (
              <p className="mt-2 text-xs leading-relaxed text-splash-navy/60">
                Time at the CT and NY warehouses, carved out of Unattributed rather
                than added to the total.
              </p>
            ) : null}
            {k.kind === "MANAGEMENT" ? (
              <p className="mt-2 text-xs leading-relaxed text-splash-navy/60">
                Travel ending at no known site. Not currently billed this way &mdash;
                the overhead job is not being punched, so today it sits on the last
                site worked.
              </p>
            ) : null}
          </div>
        ))}
      </div>

      {/* Sites */}
      <h2 className="mb-1 mt-8 text-lg font-bold text-splash-navy">
        By site &mdash; {latest ? monthLabel(latest) : ""}
      </h2>
      <p className="mb-3 text-sm text-splash-navy/70">
        Hours are charged to the site the vehicle actually reached, so a leg ending at a
        different site than the punch claimed is charged where it arrived. Expand a row
        for the reactive work orders closed there this month, and who closed them.
      </p>
      {/* One <details> per site rather than a table: expanding a row to show
          its work orders needs no client island, no state, and keeps the whole
          page server-rendered. A <tbody> toggle would have required one. */}
      <div className="overflow-hidden rounded-splash-lg border-[1.5px] border-gray-light bg-white shadow-splash-card">
        <div className="hidden border-b border-gray-light bg-gray-50 px-4 py-2.5 text-[0.75rem] uppercase tracking-wide text-splash-navy/60 sm:flex">
          <span className="flex-1 font-semibold">Site</span>
          <span className="w-20 text-right font-semibold">On-site</span>
          <span className="w-20 text-right font-semibold">Travel in</span>
          <span className="w-16 text-right font-semibold">Total</span>
          <span className="w-16 text-right font-semibold">Drive</span>
          <span className="w-20 text-right font-semibold">Work orders</span>
        </div>

        {allSiteNumbers.map((sn) => {
          const s = hoursBySite.get(sn);
          const wos = woBySite.get(sn) ?? [];
          const noHours = !s;
          // Only a MECHANIC closing a ticket implies a vehicle should have
          // been here. IT, CMMS admins, regional managers and the site's own
          // login do not, so those sites are explained rather than flagged.
          const mechanicGap = noHours && wos.some((w) => w.implies_site_visit);
          return (
            <details key={sn} className="group border-b border-gray-light/60 last:border-0">
              <summary className="flex cursor-pointer list-none flex-wrap items-baseline px-4 py-2.5 text-sm hover:bg-gray-50">
                <span className="flex-1 font-semibold text-splash-navy">
                  <span className="mr-1.5 inline-block text-splash-navy/40 transition-transform group-open:rotate-90">
                    &rsaquo;
                  </span>
                  {siteLabel(sn)}
                  <span className="ml-2 text-xs font-normal text-splash-navy/45">#{sn}</span>
                  {noHours && mechanicGap ? (
                    <span
                      className="ml-2 rounded bg-amber-200 px-1.5 py-0.5 text-[0.625rem] font-bold uppercase tracking-wide text-amber-900"
                      title="A mechanic closed a ticket here but no crew vehicle was recorded on site. Usually a dead transponder."
                    >
                      no visit recorded
                    </span>
                  ) : noHours && wos.length > 0 ? (
                    <span
                      className="ml-2 rounded bg-gray-light px-1.5 py-0.5 text-[0.625rem] font-bold uppercase tracking-wide text-splash-navy/60"
                      title="Closed by IT, a CMMS admin, a regional manager, or the site's own login — none of which expense to the site or imply a mechanic drove here."
                    >
                      no site visit expected
                    </span>
                  ) : null}
                </span>
                <span className="w-20 text-right tabular-nums text-splash-navy/80">{s ? h(s.onsite_h) : "—"}</span>
                <span className="w-20 text-right tabular-nums text-splash-navy/80">{s ? h(s.inbound_travel_h) : "—"}</span>
                <span className="w-16 text-right font-semibold tabular-nums text-splash-navy">{s ? h(s.total_h) : "—"}</span>
                <span className="w-16 text-right tabular-nums text-splash-navy/80">{s ? pct(s.pct_drive_time) : "—"}</span>
                <span className="w-20 text-right tabular-nums text-splash-navy/60">{wos.length}</span>
              </summary>

              <div className="border-t border-gray-light/60 bg-gray-50/60 px-4 py-3">
                {wos.length === 0 ? (
                  <p className="text-xs leading-relaxed text-splash-navy/60">
                    No reactive work orders completed here this month. Hours above are
                    still real &mdash; a mechanic can be on site for preventative work,
                    or for a job closed in a different month.
                  </p>
                ) : (
                  <>
                    {mechanicGap ? (
                      <p className="mb-2 text-xs leading-relaxed text-splash-navy/70">
                        A mechanic closed work here but no crew vehicle was recorded on
                        site. That is a gap in the tracking, not evidence the work was
                        not done &mdash; a dead transponder looks exactly like this.
                      </p>
                    ) : noHours ? (
                      <p className="mb-2 text-xs leading-relaxed text-splash-navy/60">
                        No mechanic visit is expected here. These were closed by IT, a
                        CMMS administrator, a regional manager, or the site&rsquo;s own
                        login &mdash; none of which expense time to the site.
                      </p>
                    ) : null}
                    <ul className="space-y-1.5">
                    {wos.map((w) => (
                      <li key={w.id} className="flex flex-wrap items-baseline gap-x-2 text-[0.8125rem]">
                        <a
                          href={`https://app.getmaintainx.com/workorders/${w.id}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-mono text-xs text-sudsy-blue hover:underline"
                        >
                          #{w.sequential_id ?? w.id}
                        </a>
                        <span className="min-w-0 flex-1 truncate text-splash-navy/85" title={w.title ?? ""}>
                          {w.title ?? "(untitled)"}
                        </span>
                        {w.priority && w.priority !== "NONE" ? (
                          <span className="rounded bg-gray-light px-1.5 py-0.5 text-[0.625rem] font-semibold uppercase tracking-wide text-splash-navy/70">
                            {w.priority}
                          </span>
                        ) : null}
                        {w.completed_by ? (
                          <span
                            className="text-xs text-splash-navy/70"
                            title="Who marked it Done in MaintainX — not necessarily the only person who worked it."
                          >
                            {w.completed_by}
                            {w.closer_role !== "MECHANIC" ? (
                              <span
                                className="ml-1 text-[0.625rem] uppercase tracking-wide text-splash-navy/45"
                                title={
                                  w.expense_to === "MANAGEMENT"
                                    ? "IT — time and travel are overhead, never expensed to the site."
                                    : "Not a field mechanic; no site visit implied."
                                }
                              >
                                {w.closer_role === "SITE_ACCOUNT"
                                  ? "site"
                                  : w.closer_role === "CMMS_ADMIN"
                                    ? "admin"
                                    : w.closer_role === "REGIONAL_MANAGER"
                                      ? "RM"
                                      : w.closer_role === "IT"
                                        ? "IT · overhead"
                                        : "unclassified"}
                              </span>
                            ) : null}
                          </span>
                        ) : null}
                        <span className="tabular-nums text-xs text-splash-navy/55">
                          {new Date(w.completed_at).toLocaleDateString("en-US", {
                            month: "short",
                            day: "numeric",
                            timeZone: "America/New_York"
                          })}
                        </span>
                        {w.labor_h ? (
                          <span className="tabular-nums text-xs text-splash-navy/55">{w.labor_h} h</span>
                        ) : null}
                      </li>
                    ))}
                    </ul>
                  </>
                )}
              </div>
            </details>
          );
        })}

        {allSiteNumbers.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-splash-navy/60">
            No site activity this month.
          </p>
        ) : null}
      </div>
      <p className="mt-2 text-xs text-splash-navy/60">
        All {allSiteNumbers.length} sites with activity this month, alphabetically.{" "}
        {hoursBySite.size} have recorded hours. Of the rest,{" "}
        {gapSites} had a mechanic close work with no vehicle recorded on site (a
        tracking gap, usually a dead transponder) and {explainedSites} were closed by
        IT, admin, a regional manager or the site itself, where no visit is expected.
      </p>

      {/* Transponder health. Above the mechanic table on purpose: a silent
          device is indistinguishable from an idle person in every column
          below it, so this has to be read first or not at all. */}
      {badDevices.length > 0 ? (
        <div className="mt-8 rounded-splash-lg border-[1.5px] border-red-300 bg-red-50 p-5">
          <p className="mb-1 text-sm font-bold text-splash-navy">
            {badDevices.filter((d) => d.device_status !== "NOT_WORKING").length > 0
              ? "Some transponders are not reporting"
              : "Crew not currently punching"}
          </p>
          <p className="mb-3 text-[0.8125rem] leading-relaxed text-splash-navy/80">
            A dead transponder looks exactly like an idle mechanic everywhere else on
            this page &mdash; near-zero on-site hours, a large unaccounted figure. For
            anyone listed here, treat the rows below as <strong>missing</strong>, not
            as low.
          </p>
          <ul className="space-y-1 text-[0.8125rem]">
            {badDevices.map((d) => (
              <li key={d.device_id} className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-semibold text-splash-navy">{d.display_name}</span>
                <span className="font-mono text-xs text-splash-navy/45">{d.device_id}</span>
                <span
                  className={`rounded px-1.5 py-0.5 text-[0.625rem] font-bold uppercase tracking-wide ${
                    d.device_status === "TRANSPONDER_SILENT"
                      ? "bg-red-200 text-red-900"
                      : d.device_status === "TRANSPONDER_PATCHY"
                        ? "bg-amber-200 text-amber-900"
                        : "bg-gray-light text-splash-navy/70"
                  }`}
                >
                  {d.device_status === "TRANSPONDER_SILENT"
                    ? "no GPS"
                    : d.device_status === "TRANSPONDER_PATCHY"
                      ? "patchy GPS"
                      : "not punching"}
                </span>
                <span className="text-splash-navy/70">
                  {d.device_status === "NOT_WORKING"
                    ? `no punches in 21 days (last ${d.last_punch?.slice(0, 10) ?? "—"})`
                    : `worked ${d.punch_days_21d} of the last 21 days, GPS on ${d.gps_days_21d}` +
                      (d.days_since_gps !== null
                        ? ` — last fix ${d.days_since_gps} days ago`
                        : "")}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* Mechanics */}
      <h2 className="mb-1 mt-8 text-lg font-bold text-splash-navy">
        By mechanic &mdash; week of {latestWeek ?? "—"}
      </h2>
      <p className="mb-3 text-sm text-splash-navy/70">
        Billable share is recovered travel &divide; all travel. Read it beside the no-GPS
        column, always.
      </p>
      <div className="overflow-x-auto rounded-splash-lg border-[1.5px] border-gray-light bg-white shadow-splash-card">
        <table className="w-full min-w-[720px] text-sm">
          <thead className="border-b border-gray-light bg-gray-50 text-left">
            <tr className="text-[0.75rem] uppercase tracking-wide text-splash-navy/60">
              <th className="px-4 py-2.5 font-semibold">Mechanic</th>
              <th className="px-4 py-2.5 text-right font-semibold">Paid h</th>
              <th className="px-4 py-2.5 text-right font-semibold">On-site h</th>
              <th className="px-4 py-2.5 text-right font-semibold">Billable travel</th>
              <th className="px-4 py-2.5 text-right font-semibold">Management</th>
              <th className="px-4 py-2.5 text-right font-semibold">Billable share</th>
              <th className="px-4 py-2.5 text-right font-semibold">No GPS</th>
            </tr>
          </thead>
          <tbody>
            {latestMechanics.map((m) => (
              <tr key={m.connecteam_user_id} className="border-b border-gray-light/60 last:border-0">
                <td className="px-4 py-2.5 font-semibold text-splash-navy">
                  {crew_names[String(m.connecteam_user_id)] ?? `User ${m.connecteam_user_id}`}
                  {silentIds.has(m.connecteam_user_id) ? (
                    <span
                      className="ml-2 rounded bg-red-200 px-1.5 py-0.5 text-[0.625rem] font-bold uppercase tracking-wide text-red-900"
                      title="Transponder not reporting — the GPS columns understate this row, they are not a measure of activity."
                    >
                      no GPS
                    </span>
                  ) : null}
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums text-splash-navy/80">{h(m.paid_h)}</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-splash-navy/80">{h(m.onsite_h)}</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-splash-navy/80">{h(m.billable_travel_h)}</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-splash-navy/80">{h(m.overhead_travel_h)}</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-splash-navy/80">{pct(m.billable_travel_pct)}</td>
                <td
                  className={`px-4 py-2.5 text-right tabular-nums ${
                    Number(m.no_gps_pct ?? 0) >= 25 ? "font-semibold text-amber-700" : "text-splash-navy/60"
                  }`}
                  title={
                    Number(m.no_gps_pct ?? 0) >= 25
                      ? "A quarter or more of this week is unmeasured. The other columns understate everything."
                      : undefined
                  }
                >
                  {pct(m.no_gps_pct)}
                </td>
              </tr>
            ))}
            {latestMechanics.length === 0 ? (
              <tr><td colSpan={7} className="px-4 py-6 text-center text-splash-navy/60">No punches this week.</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {/* Work-order workload. Separate from the hours table above because the
          periods differ — hours are one week, these are a live snapshot and a
          30-day window — and silently mixing them in one table would invite
          people to read a rate that does not exist. */}
      <h2 className="mb-1 mt-8 text-lg font-bold text-splash-navy">
        Reactive work orders by mechanic
      </h2>
      <p className="mb-3 text-sm text-splash-navy/70">
        Open is a live snapshot of what is assigned now; closed and days-to-close cover
        the last 30 days.
      </p>
      <div className="overflow-x-auto rounded-splash-lg border-[1.5px] border-gray-light bg-white shadow-splash-card">
        <table className="w-full min-w-[720px] text-sm">
          <thead className="border-b border-gray-light bg-gray-50 text-left">
            <tr className="text-[0.75rem] uppercase tracking-wide text-splash-navy/60">
              <th className="px-4 py-2.5 font-semibold">Mechanic</th>
              <th className="px-4 py-2.5 text-right font-semibold">Open</th>
              <th className="px-4 py-2.5 text-right font-semibold">In progress</th>
              <th className="px-4 py-2.5 text-right font-semibold">Open &gt; 30d</th>
              <th className="px-4 py-2.5 text-right font-semibold">Closed 7d</th>
              <th className="px-4 py-2.5 text-right font-semibold">Closed 30d</th>
              <th className="px-4 py-2.5 text-right font-semibold">Median days</th>
              <th className="px-4 py-2.5 text-right font-semibold">Mean days</th>
            </tr>
          </thead>
          <tbody>
            {workload.map((w) => (
              <tr key={w.connecteam_user_id} className="border-b border-gray-light/60 last:border-0">
                <td className="px-4 py-2.5 font-semibold text-splash-navy">{w.display_name}</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-splash-navy/80">{w.open_assigned}</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-splash-navy/60">{w.open_in_progress}</td>
                <td
                  className={`px-4 py-2.5 text-right tabular-nums ${
                    w.open_over_30d >= 5 ? "font-semibold text-amber-700" : "text-splash-navy/60"
                  }`}
                  title="Assigned work orders created more than 30 days ago and still not closed."
                >
                  {w.open_over_30d}
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums text-splash-navy/80">{w.closed_7d}</td>
                <td className="px-4 py-2.5 text-right font-semibold tabular-nums text-splash-navy">{w.closed_30d}</td>
                <td
                  className="px-4 py-2.5 text-right tabular-nums text-splash-navy/80"
                  title="Typical time from work order created to closed. Median, because the mean is dragged by a few very old tickets."
                >
                  {w.median_days_to_close ?? "—"}
                </td>
                <td
                  className="px-4 py-2.5 text-right tabular-nums text-splash-navy/45"
                  title="Mean. Shown only so a gap between it and the median is visible — that gap IS the stale-ticket backlog."
                >
                  {w.mean_days_to_close ?? "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-splash-navy/60">
        <strong>Days-to-close is ticket age, not work time.</strong> It measures created
        to closed, so a two-hour job raised in July and closed in September reads as 60
        days. Median leads because the mean across the crew is 8.7 days against a median
        of 1.2 &mdash; a thin tail of stale tickets dragging the average to seven times
        typical. Where a mechanic&rsquo;s mean is far above their median, the backlog is
        the story, not the pace. A work order with two assignees counts for both, so the
        Open column sums to more than the real backlog.
      </p>

      {/* Evidence tiers */}
      <h2 className="mb-1 mt-8 text-lg font-bold text-splash-navy">Evidence coverage</h2>
      <p className="mb-3 text-sm text-splash-navy/70">
        For reactive work orders with logged labour: how strong the evidence is that the
        mechanic was at that site. Knowing which comparison was available is part of the
        answer, not a footnote on it.
      </p>
      <div className="rounded-splash-lg border-[1.5px] border-gray-light bg-white p-5 shadow-splash-card">
        {tiers.map((t) => (
          <div key={t.evidence_tier} className="mb-3 last:mb-0">
            <div className="mb-1 flex items-baseline justify-between gap-3">
              <span
                className={`rounded-full px-2.5 py-0.5 text-[0.6875rem] font-bold uppercase tracking-wide ${TIER_STYLE[t.evidence_tier] ?? "bg-gray-light text-splash-navy/70"}`}
              >
                {TIER_LABEL[t.evidence_tier] ?? t.evidence_tier}
              </span>
              <span className="text-sm tabular-nums text-splash-navy/70">
                {t.rows} work orders · {h(t.logged_hours)} h logged
              </span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-gray-light">
              <div
                className="h-full rounded-full bg-sudsy-blue"
                style={{ width: `${tierTotal ? (100 * t.rows) / tierTotal : 0}%` }}
              />
            </div>
          </div>
        ))}
        <p className="mt-4 text-xs leading-relaxed text-splash-navy/60">
          &ldquo;Punch overlap only&rdquo; is not a finding about anyone. Some reactive
          work orders are resolved by phone and some are administrative cleanup; neither
          should produce a site visit. Temporal overlap alone matches the wrong mechanic
          58% of the time, which is why it is reported as its own tier rather than
          counted as confirmation.
        </p>
      </div>

      <p className="mt-8 text-xs text-splash-navy/50">
        Computed live from Postgres views. Generated {new Date(result.data.generated_at).toUTCString()}.
      </p>
    </section>
  );
}
