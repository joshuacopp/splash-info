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

import { MaintenanceTabs, resolveTab } from "./_components/MaintenanceTabs";
import { PeriodPicker, resolvePeriodParam } from "./_components/PeriodPicker";
import { getMe } from "../../_lib/me";
import NoAccessCard from "../forms/_components/NoAccessCard";
import { getMaintenanceSummary, type MechanicRow } from "./_lib/worker-fetch";

export const dynamic = "force-dynamic";

// Warehouse and Unattributed were GPS-basis buckets and are gone from the
// cost model: under the punch basis every hour carries a job, so there is
// nothing left unattributed, and warehouse time bills to whatever job was
// punched. Both survive as GPS measures on the Location review surface.
const KIND_STYLE: Record<string, string> = {
  SITE: "bg-emerald-100 text-emerald-800",
  CAPX: "bg-violet-100 text-violet-800",
  MANAGEMENT: "bg-amber-100 text-amber-800",
  PTO: "bg-slate-100 text-slate-700",
  UNASSIGNED: "bg-gray-light text-splash-navy/70"
};

const KIND_LABEL: Record<string, string> = {
  SITE: "Sites",
  CAPX: "Capital projects",
  MANAGEMENT: "Management",
  PTO: "Paid leave",
  UNASSIGNED: "Unassigned"
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

/**
 * Hours, to one decimal below ten and whole above it.
 *
 * Whole-hour rounding everywhere was actively misleading at the small end,
 * which is where most single rows live: a 0.51 h management punch rendered as
 * "1 h", nearly double, and 1.73 h and 2.06 h both rendered as "2 h" — three
 * different facts collapsed into two indistinguishable labels. A tenth of an
 * hour is six minutes, which is finer than punch data deserves to be read at,
 * so it is the floor rather than a default.
 *
 * Above ten hours the decimal stops earning its place: nobody reads 44.9 h
 * differently from 45 h, and the extra digit only adds noise to the totals
 * that are meant to be scanned.
 */
function h(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  const digits = Math.abs(v) < 10 && v !== Math.trunc(v) ? 1 : 0;
  return v.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  });
}
function pct(n: number | null | undefined): string {
  return n === null || n === undefined ? "—" : `${Number(n).toFixed(0)}%`;
}
function monthLabel(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

/** Weekday + short date. The day group is the primary scan line, so it has
 *  to read as a day rather than as an ISO string. */
function dayLabel(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC"
  });
}

export default async function MaintenancePage({
  searchParams
}: {
  searchParams: Promise<{ tab?: string | string[]; period?: string | string[] }>;
}) {
  const sp = await searchParams;
  const tab = resolveTab(sp?.tab);
  const periodParam = resolvePeriodParam(sp?.period);
  const session = await getMe().catch(() => null);
  if (!session) return <NoAccessCard reason="signin" returnPath="/admin/maintenance" />;
  const allowed =
    session.role === "super_admin" ||
    session.dcRole === "admin" ||
    session.dcRole === "super_admin";
  if (!allowed) return <NoAccessCard reason="forbidden" />;

  const result = await getMaintenanceSummary(periodParam);
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
    period, cost_rows, mechanics, tiers, crew_names, site_names, site_rms, work_orders,
    mechanic_days, devices, workload
  } = result.data;

  const badDevices = devices.filter((d) => d.device_status !== "OK");
  const silentIds = new Set(
    devices
      .filter((d) => d.device_status === "TRANSPONDER_SILENT")
      .map((d) => d.connecteam_user_id)
  );

  const siteLabel = (n: number) => site_names[String(n)] ?? `Site ${n}`;

  // PUNCH BASIS. Every paid hour carries a job and every job a cost centre, so
  // the buckets are additive with no remainder -- PTO included. Hence no
  // "scored total" caveat any more: under the GPS basis PTO sat outside the
  // denominator because leave can never carry GPS; under the punch basis it is
  // simply another thing the crew was paid for.
  const totalH = cost_rows.reduce((a, c) => a + Number(c.punched_h), 0);
  const byKind = (["SITE", "CAPX", "MANAGEMENT", "PTO", "UNASSIGNED"] as const)
    .map((k) => {
      const rows = cost_rows.filter((c) => c.kind === k);
      return {
        kind: k,
        hours: rows.reduce((a, c) => a + Number(c.punched_h), 0),
        gps: rows.reduce((a, c) => a + Number(c.gps_onsite_h), 0),
        count: new Set(rows.map((c) => c.site_number).filter((n) => n !== null)).size
      };
    })
    .filter((k) => k.hours > 0);

  // Work orders bucketed by site. The worker already filtered them to the
  // period, so there is no month test here any more.
  const woBySite = new Map<number, typeof work_orders>();
  for (const w of work_orders) {
    const list = woBySite.get(w.site_number);
    if (list) list.push(w);
    else woBySite.set(w.site_number, [w]);
  }

  // Per-site billed and corroborated, folded out of the same rows the headline
  // uses so the two can never disagree.
  const perSite = new Map<
    number,
    { punched: number; capx: number; gps: number; gpsCapx: number }
  >();
  for (const c of cost_rows) {
    if (c.site_number === null) continue;
    if (c.kind !== "SITE" && c.kind !== "CAPX") continue;
    const cur =
      perSite.get(c.site_number) ?? { punched: 0, capx: 0, gps: 0, gpsCapx: 0 };
    if (c.kind === "SITE") {
      cur.punched += Number(c.punched_h);
      cur.gps += Number(c.gps_onsite_h);
    } else {
      cur.capx += Number(c.punched_h);
      cur.gpsCapx += Number(c.gps_onsite_h);
    }
    perSite.set(c.site_number, cur);
  }

  // EVERY site, not a top-N. A truncated list is useless for the question this
  // table actually gets asked ("what happened at MY site"), and the cap also
  // hid the more interesting row: sites with work orders and no billed hours.
  const allSiteNumbers = [
    ...new Set([...perSite.keys(), ...woBySite.keys()])
  ].sort((a, b) => siteLabel(a).localeCompare(siteLabel(b)));

  const billedFor = (sn: number) => {
    const r = perSite.get(sn);
    return r ? r.punched + r.capx : 0;
  };
  const seenFor = (sn: number) => {
    const r = perSite.get(sn);
    return r ? r.gps + r.gpsCapx : 0;
  };

  // Matched on maintainx_user_id, never on name: mt_device_person says
  // "Charles Zimmer" where MaintainX says "Chuck Zimmer", so a name join would
  // drop precisely the person whose transponder is dead.
  const silentMxIds = new Set(
    devices
      .filter((d) => d.device_status !== "OK" && d.maintainx_user_id !== null)
      .map((d) => d.maintainx_user_id as number)
  );

  // Charged vs actual, per site. Lives on the review tab, not the site
  // breakdown: the operator reads Sites to see what a site is charged, and
  // mixing "can GPS corroborate it" into that column set made a dead
  // transponder look like an absent mechanic.
  const siteReview = allSiteNumbers
    .map((sn) => {
      const billed = billedFor(sn);
      const seen = seenFor(sn);
      const wos = woBySite.get(sn) ?? [];
      return {
        sn,
        billed,
        seen,
        pct: billed > 0 ? (100 * seen) / billed : null,
        // Only a MECHANIC closing a ticket implies a vehicle should have been
        // here. IT, CMMS admins, RMs and the site login do not.
        expectsVisit: wos.some((w) => w.implies_site_visit),
        silentCloser: wos.some(
          (w) => w.completer_id !== null && silentMxIds.has(w.completer_id)
        )
      };
    })
    .filter((r) => r.billed > 0 || r.seen > 0)
    .sort((a, b) => b.billed - a.billed);
  const unseen = siteReview.filter((r) => r.billed > 0 && r.seen === 0);

  const billedAll = siteReview.reduce((a, r) => a + r.billed, 0);
  const seenAll = siteReview.reduce((a, r) => a + r.seen, 0);
  const overallPct = billedAll > 0 ? (100 * seenAll) / billedAll : null;

  // Group site lists by Regional Manager. 57 flat rows is a scroll nobody
  // reads; nine RMs with 3-10 sites each is a list you can find yourself in.
  //
  // Grouped on regional_manager, NOT area_manager -- the latter is the
  // Regional Director despite the column name (CLAUDE.md label-vs-data), and
  // would give four large buckets instead of nine useful ones.
  const rmOf = (sn: number) => site_rms[String(sn)] ?? "Unassigned";

  function groupByRm<T extends { sn: number }>(rows: T[]) {
    const m = new Map<string, T[]>();
    for (const r of rows) {
      const k = rmOf(r.sn);
      const list = m.get(k);
      if (list) list.push(r);
      else m.set(k, [r]);
    }
    return [...m.entries()]
      .map(([rm, items]) => ({ rm, items }))
      // Unassigned last however big it is; otherwise most billed hours first.
      .sort((a, b) => {
        if (a.rm === "Unassigned") return 1;
        if (b.rm === "Unassigned") return -1;
        return (
          b.items.reduce((x, r) => x + billedFor(r.sn), 0) -
          a.items.reduce((x, r) => x + billedFor(r.sn), 0)
        );
      });
  }

  const reviewByRm = groupByRm(siteReview);
  const sitesByRm = groupByRm(allSiteNumbers.map((sn) => ({ sn })));

  const weeks = [...new Set(mechanics.map((m) => m.week_starting))].sort().reverse();
  const latestWeek = weeks[0];
  const latestMechanics: MechanicRow[] = mechanics
    .filter((m) => m.week_starting === latestWeek)
    .sort((a, b) => Number(b.paid_h) - Number(a.paid_h));
  // Day detail, grouped and collapsed. ~690 rows in the window is unreadable
  // flat -- the operator's words were "borderline unusable because it's just
  // a giant list".
  //
  // Grouped here and not in SQL: mt_mechanic_day is the right grain for every
  // other consumer (one row per mechanic, day and job) and a second grouped
  // view would have to be kept in step with it for one page's benefit.
  const dayMap = new Map<string, typeof mechanic_days>();
  for (const d of mechanic_days) {
    const list = dayMap.get(d.work_date);
    if (list) list.push(d);
    else dayMap.set(d.work_date, [d]);
  }
  const dayGroups = [...dayMap.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([date, rows]) => ({
      date,
      rows,
      mechanics: new Set(rows.map((r) => r.connecteam_user_id)).size,
      punch_h: rows.reduce((a, r) => a + Number(r.punch_h), 0),
      wo: rows.reduce((a, r) => a + Number(r.wo_closed_at_claimed_site), 0),
      // Per row, not per mechanic: one mechanic can have a job with GPS and
      // another without on the same day, and both are worth surfacing.
      noGps: rows.filter((r) => r.evidence_flag === "NO_GPS").length
    }));

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
          MaintainX. {period.label} &mdash; {period.from} to {period.to}.
        </p>
      </div>

      <MaintenanceTabs active={tab} period={period.id} />
      <PeriodPicker
        active={period.id}
        tab={tab}
        from={period.from}
        to={period.to}
      />

      {tab === "overview" ? (
      <>
      {/* Reading rules. First, not last: every number below is easy to misread. */}
      <div className="mb-7 rounded-splash-lg border-[1.5px] border-amber-300 bg-amber-50 p-5">
        <p className="mb-2 text-sm font-bold text-splash-navy">Before reading these numbers</p>
        <ul className="list-disc space-y-1.5 pl-5 text-[0.875rem] leading-relaxed text-splash-navy/85">
          <li>
            <strong>These are BILLED hours &mdash; what mechanics punched.</strong>
            That is what a site is charged, and it is the basis for every figure on
            this tab. Whether GPS can corroborate a given hour is a separate question,
            answered on Location review.
          </li>
          <li>
            <strong>A punched hour is not an hour of work observed.</strong> Connecteam
            records a button press; GPS tracks a vehicle. Neither watches anyone work.
          </li>
          <li>
            <strong>The drive home is inside a site punch, not in Management.</strong>
            Mechanics do not switch to an overhead job on leaving, so the last site of
            the day carries the commute. Sites are overstated and Management understated
            by roughly that amount.
          </li>
          <li>
            <strong>Silence is not idleness.</strong> Two transponders are dead, so
            their sites show billed hours with no GPS at all. That is a broken device,
            not an absent mechanic.
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
              {k.kind === "SITE" || k.kind === "CAPX" ? ` · ${k.count} sites` : ""}
            </p>
            {k.kind === "CAPX" ? (
              <p className="mt-2 text-xs leading-relaxed text-splash-navy/60">
                Hours punched to a site&rsquo;s &ldquo;CapX&rdquo; twin job. Capital
work is not ordinarily a charge against a site&rsquo;s operating budget, so it is
reported separately rather than inside its Sites figure.
              </p>
            ) : null}
            {k.kind === "PTO" ? (
              <p className="mt-2 text-xs leading-relaxed text-splash-navy/60">
                Paid leave, punched to a PTO job. A real cost of the crew, so it
sits in the total like any other &mdash; it simply has no site to charge and no
GPS to corroborate.
              </p>
            ) : null}
            {k.kind === "UNASSIGNED" ? (
              <p className="mt-2 text-xs leading-relaxed text-splash-navy/60">
                Punched to a site job whose site could not be resolved. Not lost
                time &mdash; it is billed, just not yet to a named site. Shrinks as
                the job catalogue improves.
              </p>
            ) : null}
            {k.kind === "MANAGEMENT" ? (
              <p className="mt-2 text-xs leading-relaxed text-splash-navy/60">
                Hours punched to an overhead job, plus every hour of staff whose
                role is overhead (IT, regional managers, CMMS admins) wherever they
                punched. Under the punch basis the drive home is NOT here &mdash; it
                sits inside whichever site punch was open at the time.
              </p>
            ) : null}
          </div>
        ))}
      </div>

      </>
      ) : null}

      {tab === "sites" ? (
      <>
      {/* Sites */}
      <h2 className="mb-1 mt-8 text-lg font-bold text-splash-navy">
        By site &mdash; {period.label}
      </h2>
      <p className="mb-3 text-sm text-splash-navy/70">
        What each site is charged: the hours mechanics punched into its jobs in
        Connecteam, split into routine maintenance and capital work. Expand a row for
        the reactive work orders closed there this month, and who closed them.
      </p>
      {/* One <details> per site rather than a table: expanding a row to show
          its work orders needs no client island, no state, and keeps the whole
          page server-rendered. A <tbody> toggle would have required one. */}
      <div className="overflow-hidden rounded-splash-lg border-[1.5px] border-gray-light bg-white shadow-splash-card">
        <div className="hidden border-b border-gray-light bg-gray-50 px-4 py-2.5 text-[0.75rem] uppercase tracking-wide text-splash-navy/60 sm:flex">
          <span className="flex-1 font-semibold">Site</span>
          <span className="w-24 text-right font-semibold">Billed</span>
          <span className="w-24 text-right font-semibold">Capital</span>
          <span className="w-24 text-right font-semibold">Work orders</span>
        </div>

                {sitesByRm.map((g) => {
          const gBilled = g.items.reduce((a, r) => a + billedFor(r.sn), 0);
          const gWos = g.items.reduce((a, r) => a + (woBySite.get(r.sn)?.length ?? 0), 0);
          return (
            <details key={g.rm} className="border-b border-gray-light last:border-0">
              <summary className="flex cursor-pointer flex-wrap items-baseline gap-x-3 gap-y-1 bg-gray-50/70 px-4 py-2.5 hover:bg-gray-light/40">
                <span className="font-bold text-splash-navy">{g.rm}</span>
                <span className="text-sm text-splash-navy/70">
                  {g.items.length} site{g.items.length === 1 ? "" : "s"} &middot;{" "}
                  {h(gBilled)} h billed &middot; {gWos} work order{gWos === 1 ? "" : "s"}
                </span>
              </summary>
              <div className="border-t border-gray-light/60">
              {g.items.map(({ sn }) => {
                const s = perSite.get(sn);
                const wos = woBySite.get(sn) ?? [];

                return (
                  <details key={sn} className="group border-b border-gray-light/60 last:border-0">
                    <summary className="flex cursor-pointer list-none flex-col gap-1 px-4 py-2.5 text-sm hover:bg-gray-50 sm:flex-row sm:flex-nowrap sm:items-baseline sm:gap-0">
                      <span className="min-w-0 flex-1 font-semibold text-splash-navy">
                        <span className="mr-1.5 inline-block text-splash-navy/40 transition-transform group-open:rotate-90">
                          &rsaquo;
                        </span>
                        {siteLabel(sn)}
                        <span className="ml-2 text-xs font-normal text-splash-navy/45">#{sn}</span>
                      </span>
                      <span className="flex flex-wrap items-baseline gap-x-4 gap-y-0.5 pl-5 sm:contents">
                        <Figure
                          label="Billed"
                          width="sm:w-24"
                          strong
                          value={s && s.punched > 0 ? `${h(s.punched)} h` : "—"}
                        />
                        <Figure
                          label="Capital"
                          width="sm:w-24"
                          value={s && s.capx > 0 ? `${h(s.capx)} h` : "—"}
                        />
                        <Figure label="Work orders" width="sm:w-24" muted value={wos.length} />
                      </span>
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
      <p className="mt-2 text-xs leading-relaxed text-splash-navy/60">
        All {allSiteNumbers.length} sites with activity this month, alphabetically.
        Billed and capital hours are what mechanics punched into this site&rsquo;s jobs
        in Connecteam. Whether GPS can corroborate them is a separate question, and
        lives on the Location review tab.
      </p>

      </>
      ) : null}

      {tab === "mechanics" ? (
      <>
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


      </>
      ) : null}

      {tab === "review" ? (
      <>
      <h2 className="mb-1 mt-8 text-lg font-bold text-splash-navy">
        Charged vs actual &mdash; by site
      </h2>
      <p className="mb-3 text-sm text-splash-navy/70">
        What each site was billed against what GPS can place there. This is the
        comparison the tracker exists for, kept off the Sites tab so a charged figure
        is never confused with a corroborated one.
      </p>
      <div className="mb-3 rounded-splash-lg border-[1.5px] border-amber-300 bg-amber-50 p-4">
        <p className="text-sm leading-relaxed text-splash-navy/80">
          <strong>Corroborated is expected to be well under 100%.</strong> A billed
          hour legitimately contains travel, an unfenced stop, or time at a site whose
          fence is wrong. Across all sites it currently runs at{" "}
          {overallPct === null ? "—" : `${overallPct.toFixed(0)}%`}. Read a row against
          its neighbours, not against 100.
        </p>
        <p className="mt-2 text-sm leading-relaxed text-splash-navy/80">
          <strong>Zero is usually a dead transponder, not an absent mechanic.</strong>{" "}
          Rows marked <span className="font-semibold">transponder down</span> had their
          work closed by someone whose device is silent or patchy, so no GPS could have
          been recorded whatever they did.
        </p>
      </div>
      <div className="overflow-hidden rounded-splash-lg border-[1.5px] border-gray-light bg-white shadow-splash-card">
        <div className="hidden border-b border-gray-light bg-gray-50 px-4 py-2.5 text-[0.75rem] uppercase tracking-wide text-splash-navy/60 sm:flex">
          <span className="flex-1 font-semibold">Site</span>
          <span className="w-24 text-right font-semibold">Billed</span>
          <span className="w-24 text-right font-semibold">Placed by GPS</span>
          <span className="w-28 text-right font-semibold">Corroborated</span>
        </div>
                {reviewByRm.map((g) => {
          const gBilled = g.items.reduce((a, r) => a + r.billed, 0);
          const gSeen = g.items.reduce((a, r) => a + r.seen, 0);
          const gUnseen = g.items.filter((r) => r.billed > 0 && r.seen === 0).length;
          return (
            <details key={g.rm} className="border-b border-gray-light/60 last:border-0">
              <summary className="flex cursor-pointer flex-wrap items-baseline gap-x-3 gap-y-1 bg-gray-50/70 px-4 py-2.5 hover:bg-gray-light/40">
                <span className="font-bold text-splash-navy">{g.rm}</span>
                <span className="text-sm text-splash-navy/70">
                  {g.items.length} site{g.items.length === 1 ? "" : "s"} &middot;{" "}
                  {h(gBilled)} h billed &middot;{" "}
                  {gBilled > 0 ? `${((100 * gSeen) / gBilled).toFixed(0)}% corroborated` : "—"}
                </span>
                {gUnseen ? (
                  <span className="whitespace-nowrap rounded bg-amber-200 px-1.5 py-0.5 text-[0.625rem] font-bold uppercase tracking-wide text-amber-900">
                    {gUnseen} with no GPS
                  </span>
                ) : null}
              </summary>
              <div>
              {g.items.map((r) => (
                <div
                  key={r.sn}
                  className="flex flex-col gap-1 border-b border-gray-light/60 px-4 py-2.5 text-sm last:border-0 sm:flex-row sm:flex-nowrap sm:items-baseline sm:gap-0"
                >
                  <span className="min-w-0 flex-1 font-semibold text-splash-navy">
                    {siteLabel(r.sn)}
                    <span className="ml-2 text-xs font-normal text-splash-navy/45">#{r.sn}</span>
                    {r.billed > 0 && r.seen === 0 ? (
                      r.silentCloser ? (
                        <span
                          className="ml-2 whitespace-nowrap rounded bg-amber-200 px-1.5 py-0.5 text-[0.625rem] font-bold uppercase tracking-wide text-amber-900"
                          title="Work here was closed by a mechanic whose transponder is silent or patchy. No GPS could have been recorded."
                        >
                          transponder down
                        </span>
                      ) : r.expectsVisit ? (
                        <span
                          className="ml-2 whitespace-nowrap rounded bg-amber-200 px-1.5 py-0.5 text-[0.625rem] font-bold uppercase tracking-wide text-amber-900"
                          title="Billed hours and a mechanic-closed ticket, but no vehicle placed here. Worth a look."
                        >
                          billed, not placed
                        </span>
                      ) : (
                        <span
                          className="ml-2 whitespace-nowrap rounded bg-gray-light px-1.5 py-0.5 text-[0.625rem] font-bold uppercase tracking-wide text-splash-navy/60"
                          title="No mechanic-closed work here, so no vehicle is expected."
                        >
                          no visit expected
                        </span>
                      )
                    ) : null}
                  </span>
                  <Figure label="Billed" width="sm:w-24" strong value={`${h(r.billed)} h`} />
                  <Figure label="Placed by GPS" width="sm:w-24" value={`${h(r.seen)} h`} />
                  <Figure
                    label="Corroborated"
                    width="sm:w-28"
                    muted
                    value={r.pct === null ? "—" : `${r.pct.toFixed(0)}%`}
                  />
                </div>
              ))}
              </div>
            </details>
          );
        })}

        {siteReview.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-splash-navy/60">
            No site activity this month.
          </p>
        ) : null}
      </div>
      <p className="mt-2 mb-2 text-xs leading-relaxed text-splash-navy/60">
        {unseen.length} of {siteReview.length} sites were billed hours with nothing
        placed by GPS. Sorted by billed hours, largest first.
      </p>

      {/* Per-mechanic day drill-down. Claim, presence and output side by side,
          deliberately not collapsed into a score -- see the caveat below. */}
      <h2 className="mb-1 mt-8 text-lg font-bold text-splash-navy">Mechanic day detail</h2>
      <p className="mb-3 text-sm text-splash-navy/70">
        One row per mechanic, day and job: what the punch claimed, where the truck
        actually was, and what got closed. Newest first.
      </p>
      <div className="mb-3 rounded-splash-lg border-[1.5px] border-amber-300 bg-amber-50 p-4">
        <p className="text-sm leading-relaxed text-splash-navy/80">
          <strong>These three columns disagree for honest reasons.</strong> A mechanic
          can be on site all day with nothing to close &mdash; diagnosis, waiting on a
          part, covering for someone &mdash; and can close a work order from the road.
          Read a row as a question worth asking, never as a finding.
        </p>
        <p className="mt-2 text-sm leading-relaxed text-splash-navy/80">
          <strong>Site from GPS is not independent evidence.</strong> Rows marked{" "}
          <span className="font-semibold">derived</span> got their claimed site from the
          behavioural crosswalk, which is itself built from GPS &mdash; so asking whether
          the truck was there is partly asking GPS to confirm itself, and it will tend to
          agree. Rows marked <span className="font-semibold">code</span> took the site
          from the Connecteam job&rsquo;s own cost code and are a real comparison.
        </p>
        <p className="mt-2 text-sm leading-relaxed text-splash-navy/80">
          <strong>No GPS is not absence.</strong> Two transponders are dead, so those
          mechanics show no-GPS days throughout. That is a broken device, not a missing
          mechanic.
        </p>
      </div>
      <div className="space-y-2">
        {dayGroups.map((g) => (
          <details
            key={g.date}
            className="overflow-hidden rounded-splash-lg border-[1.5px] border-gray-light bg-white shadow-splash-card"
          >
            <summary className="flex cursor-pointer flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-3 hover:bg-gray-light/30">
              <span className="font-bold text-splash-navy">{dayLabel(g.date)}</span>
              <span className="text-sm text-splash-navy/70">
                {g.mechanics} mechanic{g.mechanics === 1 ? "" : "s"} &middot; {h(g.punch_h)} h
                {g.wo ? ` · ${g.wo} WO${g.wo === 1 ? "" : "s"} closed` : " · no WOs closed"}
              </span>
              {g.noGps ? (
                <span className="rounded bg-gray-light px-1.5 py-0.5 text-[0.625rem] font-bold uppercase text-splash-navy/60">
                  {g.noGps} no GPS
                </span>
              ) : null}
            </summary>
            <div className="border-t border-gray-light/70 px-2 py-2">
              {g.rows.map((d, i) => (
                <details key={`${d.connecteam_user_id}-${d.job_title}-${i}`} className="rounded-splash">
                  <summary className="flex cursor-pointer flex-wrap items-baseline gap-x-2 gap-y-1 rounded-splash px-2.5 py-2 text-sm hover:bg-gray-light/40">
                    <span className="min-w-[9rem] font-semibold text-splash-navy">{d.display_name}</span>
                    <span className="text-splash-navy/80">
                      {d.claimed_site_name ?? d.job_title ?? "—"}
                    </span>
                    {d.work_kind === "CAPX" ? (
                      <span className="rounded bg-violet-100 px-1.5 py-0.5 text-[0.625rem] font-bold uppercase text-violet-800">
                        CapX
                      </span>
                    ) : null}
                    {d.work_kind === "OVERHEAD" ? (
                      <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[0.625rem] font-bold uppercase text-amber-800">
                        Overhead
                      </span>
                    ) : null}
                    <span className="tabular-nums font-semibold text-splash-navy">{h(d.punch_h)} h</span>
                    {/* A row with no claimed site has no site to be seen at and
                        nothing there to close. Saying "not seen on site" about
                        an hour punched to CC Management reads as a mechanic who
                        went nowhere and did nothing, when the truth is that the
                        question does not apply -- the two are opposite findings
                        rendered identically. Absence of evidence is only worth
                        printing where evidence was possible. */}
                    {d.claimed_site_name ? (
                      <>
                        <span className="text-splash-navy/60">
                          {Number(d.at_claimed_site_h) > 0
                            ? `${h(d.at_claimed_site_h)} h on site`
                            : "not seen on site"}
                        </span>
                        <span className="text-splash-navy/60">
                          {d.wo_closed_at_claimed_site
                            ? `${d.wo_closed_at_claimed_site} closed here`
                            : "nothing closed here"}
                        </span>
                      </>
                    ) : (
                      <span className="text-splash-navy/45">
                        {d.work_kind === "OVERHEAD"
                          ? "no site — overhead"
                          : d.work_kind === "PTO"
                            ? "no site — PTO"
                            : "no site claimed"}
                      </span>
                    )}
                  </summary>
                  <div className="mx-2.5 mb-2 grid gap-x-6 gap-y-1.5 rounded-splash bg-gray-light/30 px-3 py-2.5 text-xs sm:grid-cols-2">
                    <Fact label="Punched" value={`${h(d.punch_h)} h`} />
                    <Fact
                      label="Job claimed"
                      value={`${d.job_title ?? "—"}${
                        d.site_source === "CODE"
                          ? " (site from job code)"
                          : d.site_source === "DERIVED"
                            ? " (site inferred from GPS — not independent)"
                            : ""
                      }`}
                    />
                    {/* Same rule as the summary line: only report against a
                        claimed site when there is one. "At the claimed site:
                        0 h" on an overhead punch is not a measurement. */}
                    {d.claimed_site_name ? (
                      <Fact label="At the claimed site" value={`${h(d.at_claimed_site_h)} h`} />
                    ) : (
                      <Fact label="At the claimed site" value="no site claimed" />
                    )}
                    <Fact
                      label={d.claimed_site_name ? "At another site" : "Seen at a site"}
                      value={`${h(d.at_other_site_h)} h${d.other_sites ? ` — ${d.other_sites}` : ""}`}
                    />
                    <Fact label="Stopped off site" value={`${h(d.stopped_offsite_h)} h`} />
                    <Fact label="Moving or no GPS" value={`${h(d.moving_or_no_gps_h)} h`} />
                    <Fact
                      label="Work orders closed"
                      value={
                        d.claimed_site_name
                          ? `${d.wo_closed_at_claimed_site} here${
                              d.wo_closed_elsewhere ? `, ${d.wo_closed_elsewhere} elsewhere` : ""
                            }`
                          : d.wo_closed_elsewhere
                            ? `${d.wo_closed_elsewhere} elsewhere`
                            : "none"
                      }
                    />
                    <Fact label="Shape of day" value={d.evidence_flag.replaceAll("_", " ").toLowerCase()} />
                    {d.wo_titles ? (
                      <p className="text-splash-navy/70 sm:col-span-2">
                        <span className="font-semibold text-splash-navy/80">Closed here: </span>
                        {d.wo_titles}
                      </p>
                    ) : null}
                  </div>
                </details>
              ))}
            </div>
          </details>
        ))}
      </div>
      <p className="mt-3 text-xs leading-relaxed text-splash-navy/60">
        Current and previous month, newest first. Expand a day for its mechanics, and a
        mechanic for the hour breakdown. &ldquo;On site&rdquo; is time the vehicle sat
        inside that site&rsquo;s fence; the rest is another site, an unfenced stop, or
        driving.
      </p>
      </>
      ) : null}

      {tab === "evidence" ? (
      <>
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

      </>
      ) : null}

      <p className="mt-8 text-xs text-splash-navy/50">
        Computed live from Postgres views. Generated {new Date(result.data.generated_at).toUTCString()}.
      </p>
    </section>
  );
}

/** One label/value line inside an expanded mechanic-day panel. */
function Fact({ label, value }: { label: string; value: string }) {
  return (
    <p className="text-splash-navy/70">
      <span className="font-semibold text-splash-navy/80">{label}: </span>
      {value}
    </p>
  );
}

/**
 * One figure in a site row.
 *
 * Two layouts from one set of markup. Below `sm` the row stacks and each
 * figure carries its own label, because the column header is hidden there and
 * a bare wrapped number is unreadable -- which is exactly what portrait looked
 * like before. From `sm` up the wrapper is display:contents, so these become
 * direct flex children of the summary again and the fixed widths still line up
 * with the header row.
 *
 * `width` is an sm-prefixed class on purpose: at mobile width the figures
 * are auto-width labelled pairs, not columns. Keep the values in step with
 * the header spans above if either changes.
 */
function Figure({
  label,
  value,
  width,
  strong,
  muted
}: {
  label: string;
  value: string | number;
  width: string;
  strong?: boolean;
  muted?: boolean;
}) {
  const tone = strong
    ? "font-semibold text-splash-navy"
    : muted
      ? "text-splash-navy/60"
      : "text-splash-navy/80";
  return (
    <span className={`w-auto tabular-nums ${tone} sm:shrink-0 sm:text-right ${width}`}>
      <span className="mr-1 text-[0.6875rem] font-semibold uppercase tracking-wide text-splash-navy/45 sm:hidden">
        {label}
      </span>
      {value}
    </span>
  );
}
