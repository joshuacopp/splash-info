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
  MANAGEMENT: "bg-amber-100 text-amber-800",
  UNATTRIBUTED: "bg-gray-light text-splash-navy/70"
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
  const { cost_centres, sites, mechanics, tiers, crew_names } = result.data;

  const months = [...new Set(cost_centres.map((c) => c.month))].sort().reverse();
  const latest = months[0];
  const latestCosts = cost_centres.filter((c) => c.month === latest);
  const totalH = latestCosts.reduce((a, c) => a + Number(c.hours), 0);
  const byKind = (["SITE", "MANAGEMENT", "UNATTRIBUTED"] as const).map((k) => {
    const rows = latestCosts.filter((c) => c.kind === k);
    return { kind: k, hours: rows.reduce((a, c) => a + Number(c.hours), 0), count: rows.length };
  });

  const latestSites = sites.filter((s) => s.month === latest).slice(0, 20);
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
      <div className="mb-3 grid gap-3 sm:grid-cols-3">
        {byKind.map((k) => (
          <div
            key={k.kind}
            className="rounded-splash-lg border-[1.5px] border-gray-light bg-white p-5 shadow-splash-card"
          >
            <span
              className={`inline-block rounded-full px-2.5 py-0.5 text-[0.6875rem] font-bold uppercase tracking-wide ${KIND_STYLE[k.kind]}`}
            >
              {k.kind === "SITE" ? "Sites" : k.kind === "MANAGEMENT" ? "Management" : "Unattributed"}
            </span>
            <p className="mt-3 text-3xl font-bold text-splash-navy">{h(k.hours)}<span className="ml-1 text-base font-semibold text-splash-navy/60">h</span></p>
            <p className="mt-1 text-sm text-splash-navy/70">
              {totalH ? `${((100 * k.hours) / totalH).toFixed(1)}% of paid time` : "—"}
              {k.kind === "SITE" ? ` · ${k.count} sites` : ""}
            </p>
            {k.kind === "UNATTRIBUTED" ? (
              <p className="mt-2 text-xs leading-relaxed text-splash-navy/60">
                Stopped somewhere with no geofence, plus time the tracker reported
                nothing for. The largest thing this system cannot yet explain.
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
        different site than the punch claimed is charged where it arrived.
      </p>
      <div className="overflow-x-auto rounded-splash-lg border-[1.5px] border-gray-light bg-white shadow-splash-card">
        <table className="w-full min-w-[560px] text-sm">
          <thead className="border-b border-gray-light bg-gray-50 text-left">
            <tr className="text-[0.75rem] uppercase tracking-wide text-splash-navy/60">
              <th className="px-4 py-2.5 font-semibold">Site</th>
              <th className="px-4 py-2.5 text-right font-semibold">On-site h</th>
              <th className="px-4 py-2.5 text-right font-semibold">Travel in h</th>
              <th className="px-4 py-2.5 text-right font-semibold">Total h</th>
              <th className="px-4 py-2.5 text-right font-semibold">Drive time</th>
            </tr>
          </thead>
          <tbody>
            {latestSites.map((s) => (
              <tr key={s.site_number} className="border-b border-gray-light/60 last:border-0">
                <td className="px-4 py-2.5 font-semibold text-splash-navy">Site {s.site_number}</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-splash-navy/80">{h(s.onsite_h)}</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-splash-navy/80">{h(s.inbound_travel_h)}</td>
                <td className="px-4 py-2.5 text-right font-semibold tabular-nums text-splash-navy">{h(s.total_h)}</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-splash-navy/80">{pct(s.pct_drive_time)}</td>
              </tr>
            ))}
            {latestSites.length === 0 ? (
              <tr><td colSpan={5} className="px-4 py-6 text-center text-splash-navy/60">No site hours this month.</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>
      {sites.filter((s) => s.month === latest).length > 20 ? (
        <p className="mt-2 text-xs text-splash-navy/60">
          Showing the 20 largest of {sites.filter((s) => s.month === latest).length} sites.
        </p>
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
