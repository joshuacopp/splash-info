// "Scan gaps by greeter" -- which greeters a site's missed scans follow.
//
// READ THIS BEFORE CHANGING ANY WORDING. Scanning is recorded per SITE-DAY only:
// the site types how many cars it sold, each greeter types how many they
// scanned, and nothing ties a car to a person. So nothing on this screen can
// prove who skipped a scan. It shows whose days the missed scans keep landing
// on, which is a lead for a manager to follow up on the lot -- and the copy has
// to keep saying so, because a table of names sorted by "likely" will otherwise
// be read as a verdict.
//
// Two signals, read TOGETHER (see verdictFor):
//   * with vs without -- the site's scan % on this person's days against the
//     same site's other days. Same site both sides, so a badly run site does
//     not make everybody on it look guilty.
//   * share of the crew's scans against the share they would be expected to
//     carry (hours where the whole crew entered shift times, an even split
//     otherwise).
// Low on the first but normal on the second is its own finding: the site does
// worse on their days, but they are scanning their part -- look at who they
// work WITH. That case is labelled differently rather than lumped in.
//
// Server components only; every number arrives computed by greeter_scan_gaps()
// (supabase/greeter-scan-gaps-16.sql), summed-then-divided like the rest of
// the report.

import Link from "next/link";
import type {
  GreeterScanGapRow,
  LocationPeriodRow
} from "@splash/types/greeter";
import { dayLabel, num, pct } from "../../_lib/format";
import {
  CAPTURE_TIER_CLASSES,
  SCAN_TARGET_PCT,
  scanTier
} from "../../_lib/grading";

/** Below this many days on EITHER side, a with/without comparison is two or
 *  three coin flips. The row still shows; it just is not ranked. */
export const GAP_MIN_DAYS = 3;
/** Points below the site's other days before "with them" counts as worse. */
const GAP_POINTS = 5;
/** ...and the bigger drop that is enough on its own with a middling share. */
const GAP_POINTS_STRONG = 10;
/** Carrying under this share of their expected scans is "scans less". */
const LOW_SHARE_INDEX = 0.7;
/** At or above this they are carrying roughly their part. */
const FAIR_SHARE_INDEX = 0.9;
/** A site whose greeters log more scans than it sold cannot show a gap -- the
 *  numbers are being counted differently, not missed. Small tolerance for a
 *  late-entered house account. */
const OVER_REPORT_PCT = 105;

type Verdict = "likely" | "crew" | "share" | "none" | "thin";

const VERDICT: Record<Verdict, { label: string; cls: string; rank: number; hint: string }> = {
  likely: {
    label: "Likely",
    cls: "bg-splash-deny/15 text-splash-deny",
    rank: 0,
    hint: "The site scans worse on their days AND they log less than their share of the crew's scans. The strongest lead this data can give -- still a lead, not proof."
  },
  crew: {
    label: "Check their crew",
    cls: "bg-yellow-100 text-yellow-900",
    rank: 1,
    hint: "The site scans worse on their days, but they log about their share. The missed cars may belong to whoever they usually work with."
  },
  share: {
    label: "Scans less",
    cls: "bg-yellow-100 text-yellow-900",
    rank: 2,
    hint: "Logs well under their share of the crew's scans, but the site's rate does not drop on their days. Could be their position on the lot; worth a look."
  },
  none: {
    label: "No signal",
    cls: "bg-gray-light text-splash-navy/70",
    rank: 3,
    hint: "Nothing in the numbers points at this person."
  },
  thin: {
    label: "Not enough days",
    cls: "bg-gray-light text-splash-navy/50",
    rank: 4,
    hint: `Needs at least ${GAP_MIN_DAYS} qualifying days with them AND ${GAP_MIN_DAYS} without before it can be compared.`
  }
};

function verdictFor(r: GreeterScanGapRow): Verdict {
  if (
    r.days_with < GAP_MIN_DAYS ||
    r.days_without < GAP_MIN_DAYS ||
    r.gap_points === null
  ) {
    return "thin";
  }
  const gap = Number(r.gap_points);
  const idx = r.share_index === null ? null : Number(r.share_index);
  const worse = gap <= -GAP_POINTS;
  if (worse && idx !== null && idx < LOW_SHARE_INDEX) return "likely";
  if (gap <= -GAP_POINTS_STRONG && idx !== null && idx < FAIR_SHARE_INDEX) return "likely";
  if (worse) return "crew";
  if (idx !== null && idx < LOW_SHARE_INDEX) return "share";
  return "none";
}

interface SiteBlock {
  location_id: number;
  site_number: number;
  location_code: string;
  site_days: number;
  scannable: number;
  scanned: number;
  scan_pct: number | null;
  overReported: boolean;
  rows: (GreeterScanGapRow & { verdict: Verdict })[];
}

/** Every greeter row carries its site's totals, so the site block is read off
 *  the first row (with + without = the site) rather than refetched. */
function buildSites(rows: GreeterScanGapRow[], needle: string): SiteBlock[] {
  const map = new Map<number, SiteBlock>();
  for (const r of rows) {
    let site = map.get(r.location_id);
    if (!site) {
      const scannable = Number(r.scannable_with) + Number(r.scannable_without);
      const scanned = Number(r.scanned_with) + Number(r.scanned_without);
      const scanPct = scannable > 0 ? Math.round((scanned * 1000) / scannable) / 10 : null;
      site = {
        location_id: r.location_id,
        site_number: r.site_number,
        location_code: r.location_code,
        site_days: r.site_days,
        scannable,
        scanned,
        scan_pct: scanPct,
        overReported: scanPct !== null && scanPct > OVER_REPORT_PCT,
        rows: []
      };
      map.set(r.location_id, site);
    }
    // The greeter filter narrows what is SHOWN. It never narrows the input --
    // every row here was computed against the whole crew.
    if (needle && !r.greeter_name.toLowerCase().includes(needle)) continue;
    site.rows.push({ ...r, verdict: site.overReported ? "none" : verdictFor(r) });
  }
  for (const s of map.values()) {
    s.rows.sort((a, b) => {
      const v = VERDICT[a.verdict].rank - VERDICT[b.verdict].rank;
      if (v !== 0) return v;
      return (Number(a.gap_points ?? 0) - Number(b.gap_points ?? 0)) ||
        a.greeter_name.localeCompare(b.greeter_name);
    });
  }
  // Worst-scanning site first; sites whose numbers cannot show a gap last.
  return [...map.values()]
    .filter((s) => s.rows.length > 0)
    .sort((a, b) => {
      if (a.overReported !== b.overReported) return a.overReported ? 1 : -1;
      return (a.scan_pct ?? 999) - (b.scan_pct ?? 999);
    });
}

export function ScanGapsView({
  rows,
  greeterNeedle,
  selectedSite,
  link
}: {
  rows: GreeterScanGapRow[] | null;
  greeterNeedle: string;
  selectedSite: number | null;
  link: (patch: Record<string, string>) => string;
}) {
  if (rows === null) {
    return (
      <Box>
        <p className="px-5 py-6 text-sm text-splash-navy/70">
          Scan gaps could not be loaded. The <code>greeter_scan_gaps</code> SQL
          function may not be installed yet (supabase/greeter-scan-gaps-16.sql).
        </p>
      </Box>
    );
  }
  const sites = buildSites(rows, greeterNeedle.toLowerCase());
  const leads = sites
    .flatMap((s) => s.rows.filter((r) => r.verdict === "likely"))
    .sort((a, b) => Number(b.missed_share ?? 0) - Number(a.missed_share ?? 0));

  return (
    <>
      <Box>
        <div className="border-b border-gray-light px-5 py-4">
          <h2 className="text-lg font-bold text-splash-navy">Where to look first</h2>
          <p className="mt-1 text-xs text-splash-navy/70">
            Greeters whose sites scan worse on their days <em>and</em> who log less
            than their share of the crew&rsquo;s scans, most missed cars first.
            Scanning is only recorded per site per day, so this is a lead to check
            on the lot, not proof of who skipped a scan.
          </p>
        </div>
        {leads.length === 0 ? (
          <p className="px-5 py-6 text-sm text-splash-navy/70">
            Nobody in this window meets both conditions. The per-site tables below
            still show who is on the weaker days.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-light text-sm">
              <thead className={THEAD}>
                <tr>
                  <th className="px-4 py-3">Greeter</th>
                  <th className="px-4 py-3">Site</th>
                  <th className="px-4 py-3">Scan % with / without</th>
                  <th className="px-4 py-3">Share carried</th>
                  <th className="px-4 py-3">≈ Missed cars</th>
                  <th className="px-4 py-3">Days</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-light">
                {leads.map((r) => (
                  <tr key={`${r.location_id}-${r.beekeeper_user_id}`}>
                    <td className="px-4 py-3 font-semibold text-splash-navy">
                      <Link href={link({ person: r.beekeeper_user_id })} className="hover:text-splash-blue">
                        {r.greeter_name}
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      <Link href={link({ site: String(r.location_id) })} className="text-splash-blue hover:text-splash-blue-dark">
                        {r.location_code}
                      </Link>
                    </td>
                    <td className="px-4 py-3"><WithWithout r={r} /></td>
                    <td className="px-4 py-3"><ShareCell r={r} /></td>
                    <td className="px-4 py-3 text-splash-navy/80">{num(roundNum(r.missed_share))}</td>
                    <td className="px-4 py-3 text-splash-navy/70">{r.days_with} on · {r.days_without} off</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Box>

      <HowToRead />

      {sites.length === 0 ? (
        <Box>
          <p className="px-5 py-6 text-sm text-splash-navy/70">
            No site in this window has both a site day and greeter days to compare.
          </p>
        </Box>
      ) : (
        sites.map((s) => (
          <Box key={s.location_id}>
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-gray-light px-5 py-4">
              <div>
                <h3 className="text-base font-bold text-splash-navy">
                  {s.location_code} · site {s.site_number}
                </h3>
                <p className="mt-1 text-xs text-splash-navy/70">
                  {num(s.scanned)} of {num(s.scannable)} scannable cars scanned over{" "}
                  {s.site_days} qualifying day{s.site_days === 1 ? "" : "s"}.
                </p>
              </div>
              <div className="flex items-center gap-3">
                <ScanPill value={s.scan_pct} />
                <Link
                  href={link({ site: selectedSite === s.location_id ? "" : String(s.location_id) })}
                  className="whitespace-nowrap text-sm font-semibold text-splash-blue hover:text-splash-blue-dark"
                >
                  {selectedSite === s.location_id ? "Hide days" : "Day by day →"}
                </Link>
              </div>
            </div>
            {s.overReported ? (
              <p className="border-b border-gray-light bg-yellow-50 px-5 py-3 text-xs text-yellow-900">
                Greeters here logged <strong>more</strong> scans than the site sold
                scannable cars ({pct(s.scan_pct)}). That is a counting problem --
                members, rewashes or the same car twice -- not missed scans, so no one
                is flagged. Fix what is being counted first.
              </p>
            ) : null}
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-light text-sm">
                <thead className={THEAD}>
                  <tr>
                    <th className="px-4 py-3">Greeter</th>
                    <th className="px-4 py-3">Lead</th>
                    <th className="px-4 py-3" title="The site's scan rate on days this greeter worked, against the site's other qualifying days.">Scan % with / without</th>
                    <th className="px-4 py-3" title="This greeter's scans as a share of what they would be expected to log: hours worked where the whole crew entered shift times, otherwise an even split of the crew.">Share carried</th>
                    <th className="px-4 py-3" title="The site's unscanned cars on their days, split across that day's crew the same way. An estimate of exposure, not a count of anything they did.">≈ Missed cars</th>
                    <th className="px-4 py-3">Own scans</th>
                    <th className="px-4 py-3">Days on / off</th>
                    <th className="px-4 py-3">Avg crew</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-light">
                  {s.rows.map((r) => {
                    const v = VERDICT[r.verdict];
                    return (
                      <tr key={r.beekeeper_user_id}>
                        <td className="px-4 py-3 font-semibold text-splash-navy">
                          <Link href={link({ person: r.beekeeper_user_id })} className="hover:text-splash-blue">
                            {r.greeter_name}
                          </Link>
                        </td>
                        <td className="px-4 py-3">
                          <span title={v.hint} className={`inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-bold ${v.cls}`}>
                            {v.label}
                          </span>
                        </td>
                        <td className="px-4 py-3"><WithWithout r={r} /></td>
                        <td className="px-4 py-3"><ShareCell r={r} /></td>
                        <td className="px-4 py-3 text-splash-navy/80">{num(roundNum(r.missed_share))}</td>
                        <td className="px-4 py-3 text-splash-navy/80">{num(Number(r.own_scans))}</td>
                        <td className="px-4 py-3 text-splash-navy/70">{r.days_with} / {r.days_without}</td>
                        <td className="px-4 py-3 text-splash-navy/70">{r.avg_crew_size === null ? "—" : Number(r.avg_crew_size).toFixed(1)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Box>
        ))
      )}
    </>
  );
}

/* ------------------------------------------------------------
 * Day-by-day crew grid for one site
 * ------------------------------------------------------------ */

/** The subset of a greeter day row the grid needs. */
export interface CrewDayRow {
  business_date: string;
  location_id?: number;
  beekeeper_user_id?: string;
  greeter_name?: string;
  wash_sales: number | null;
  hours_worked: number | null;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function weekdayOf(iso: string): number {
  return new Date(`${iso}T12:00:00Z`).getUTCDay();
}

/**
 * Every day for one site with who was on and what each logged -- the screen a
 * manager reads to confirm or kill a lead from the table above. A weekday strip
 * on top, because "every bad day is a Saturday" is a pattern a list of dates
 * hides.
 */
export function ScanCrewGrid({
  siteDays,
  crewDays,
  highlight,
  link
}: {
  siteDays: LocationPeriodRow[];
  crewDays: CrewDayRow[] | null;
  /** beekeeper_user_ids flagged "likely" at this site, to mark in the crew lists. */
  highlight: Set<string>;
  link: (patch: Record<string, string>) => string;
}) {
  const crewByDate = new Map<string, CrewDayRow[]>();
  for (const c of crewDays ?? []) {
    const list = crewByDate.get(c.business_date) ?? [];
    list.push(c);
    crewByDate.set(c.business_date, list);
  }

  const days = [...siteDays]
    .map((d) => {
      const scannable = Math.max(0, (d.wash_sales ?? 0) - (d.house_accounts ?? 0) - (d.rewashes ?? 0));
      const scanned = Number(d.scanned_wash_sales ?? 0);
      return {
        iso: d.business_date,
        scannable,
        scanned,
        pct: scannable > 0 ? Math.round((scanned * 1000) / scannable) / 10 : null,
        crew: (crewByDate.get(d.business_date) ?? []).sort(
          (a, b) => (b.wash_sales ?? 0) - (a.wash_sales ?? 0)
        )
      };
    })
    .sort((a, b) => b.iso.localeCompare(a.iso));

  // Weekday rollup, summed then divided like everything else.
  const wk = WEEKDAYS.map(() => ({ scannable: 0, scanned: 0, days: 0 }));
  for (const d of days) {
    if (d.scannable <= 0 || d.crew.length === 0) continue;
    const w = wk[weekdayOf(d.iso)]!;
    w.scannable += d.scannable;
    w.scanned += d.scanned;
    w.days += 1;
  }

  if (days.length === 0) {
    return <p className="px-5 py-6 text-sm text-splash-navy/70">This site logged nothing in the window.</p>;
  }

  return (
    <>
      <div className="grid grid-cols-4 gap-2 px-5 pb-4 sm:grid-cols-7">
        {WEEKDAYS.map((name, i) => {
          const w = wk[i]!;
          const p = w.scannable > 0 ? Math.round((w.scanned * 1000) / w.scannable) / 10 : null;
          return (
            <div key={name} className="rounded-splash-sm border border-gray-light px-2 py-2 text-center">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-splash-navy/60">{name}</p>
              <div className="mt-1"><ScanPill value={p} /></div>
              <p className="mt-1 text-[11px] text-splash-navy/50">{w.days} day{w.days === 1 ? "" : "s"}</p>
            </div>
          );
        })}
      </div>
      {crewDays === null ? (
        <p className="px-5 pb-3 text-xs text-splash-deny">Could not load who worked each day.</p>
      ) : null}
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-light text-sm">
          <thead className={THEAD}>
            <tr>
              <th className="px-4 py-3">Date</th>
              <th className="px-4 py-3">Scanned</th>
              <th className="px-4 py-3">Scan %</th>
              <th className="px-4 py-3">Crew (cars each scanned)</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-light">
            {days.map((d) => (
              <tr key={d.iso}>
                <td className="whitespace-nowrap px-4 py-3 font-mono text-xs text-splash-navy/80">{dayLabel(d.iso)}</td>
                <td className="whitespace-nowrap px-4 py-3 text-splash-navy/80">
                  {num(d.scanned)} / {num(d.scannable)}
                </td>
                <td className="px-4 py-3"><ScanPill value={d.pct} /></td>
                <td className="px-4 py-3">
                  {d.crew.length === 0 ? (
                    <span className="text-xs text-splash-navy/50">No greeter logged this day</span>
                  ) : (
                    <div className="flex flex-wrap gap-1.5">
                      {d.crew.map((c) => {
                        const flagged = c.beekeeper_user_id ? highlight.has(c.beekeeper_user_id) : false;
                        const hrs = c.hours_worked === null ? "" : ` · ${Number(c.hours_worked).toFixed(1)}h`;
                        return (
                          <Link
                            key={`${c.beekeeper_user_id ?? c.greeter_name}`}
                            href={c.beekeeper_user_id ? link({ person: c.beekeeper_user_id }) : link({})}
                            className={`rounded-full border px-2 py-0.5 text-xs ${
                              flagged
                                ? "border-splash-deny/40 bg-splash-deny/10 font-semibold text-splash-deny"
                                : "border-gray-light text-splash-navy/80 hover:border-splash-blue"
                            }`}
                          >
                            {c.greeter_name ?? "Greeter"} ({num(c.wash_sales ?? 0)}{hrs})
                          </Link>
                        );
                      })}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/* ------------------------------------------------------------
 * Small pieces
 * ------------------------------------------------------------ */

function HowToRead() {
  return (
    <details className="mb-6 rounded-splash-lg border border-gray-light bg-white px-5 py-3 text-xs text-splash-navy/80 shadow-splash-card">
      <summary className="cursor-pointer font-semibold text-splash-navy">How to read these numbers</summary>
      <ul className="mt-2 list-disc space-y-1 pl-5">
        <li>
          <strong>Scan % with / without</strong> is the site&rsquo;s scan rate on the
          days this person worked against the same site&rsquo;s other days. Only
          days with scannable cars and at least one greeter logged count.
        </li>
        <li>
          <strong>Share carried</strong> is their scans against what they would be
          expected to log. 100% is their share; 40% is well under it. Where the whole
          crew entered shift times it uses hours worked, otherwise an even split.
        </li>
        <li>
          <strong>≈ Missed cars</strong> is the site&rsquo;s unscanned cars on their
          days, split across the crew. An estimate of exposure, not a count.
        </li>
        <li>
          Nobody is compared on fewer than {GAP_MIN_DAYS} days on and {GAP_MIN_DAYS} days
          off. Longer windows give firmer leads; 30 to 60 days works best.
        </li>
        <li>
          Shift times are optional, so most days use an even split. Days where the
          whole crew entered times make the comparison sharper.
        </li>
      </ul>
    </details>
  );
}

function WithWithout({ r }: { r: GreeterScanGapRow }) {
  const gap = r.gap_points === null ? null : Number(r.gap_points);
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <ScanPill value={r.pct_with === null ? null : Number(r.pct_with)} />
      <span className="text-splash-navy/40">/</span>
      <span className="text-xs text-splash-navy/70">{pct(r.pct_without === null ? null : Number(r.pct_without))}</span>
      {gap === null ? null : (
        <span className={`text-xs font-semibold ${gap <= -GAP_POINTS ? "text-splash-deny" : "text-splash-navy/50"}`}>
          ({gap > 0 ? "+" : ""}{gap.toFixed(1)})
        </span>
      )}
    </span>
  );
}

function ShareCell({ r }: { r: GreeterScanGapRow }) {
  if (r.share_index === null) return <span className="text-splash-navy/40">—</span>;
  const idx = Number(r.share_index);
  const cls =
    idx < LOW_SHARE_INDEX
      ? "text-splash-deny font-semibold"
      : idx < FAIR_SHARE_INDEX
        ? "text-yellow-900"
        : "text-splash-navy/80";
  return (
    <span
      className={cls}
      title={`${pct(r.share_pct === null ? null : Number(r.share_pct))} of the crew's scans on their days, against an expected ${pct(
        r.expected_share_pct === null ? null : Number(r.expected_share_pct)
      )}${r.hours_days > 0 ? ` (${r.hours_days} day${r.hours_days === 1 ? "" : "s"} weighted by hours)` : ""}.`}
    >
      {Math.round(idx * 100)}%
    </span>
  );
}

function ScanPill({ value }: { value: number | null }) {
  if (value === null) return <span className="text-splash-navy/40">—</span>;
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-bold ${CAPTURE_TIER_CLASSES[scanTier(value)]}`}
      title={`${SCAN_TARGET_PCT}% of scannable cars scanned is the target.`}
    >
      {pct(value)}
    </span>
  );
}

function Box({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-6 overflow-hidden rounded-splash-lg border border-gray-light bg-white shadow-splash-card">
      {children}
    </div>
  );
}

function roundNum(v: number | string | null): number | null {
  return v === null ? null : Math.round(Number(v));
}

// Same header style as the report's own tables.
const THEAD =
  "bg-splash-navy/5 text-left text-xs font-semibold uppercase tracking-wider text-splash-navy/70";

/** For the page: ids flagged "likely" at one site, to mark in its crew grid. */
export function likelyAtSite(rows: GreeterScanGapRow[] | null, locationId: number): Set<string> {
  const out = new Set<string>();
  for (const r of rows ?? []) {
    if (r.location_id !== locationId) continue;
    const scannable = Number(r.scannable_with) + Number(r.scannable_without);
    const scanned = Number(r.scanned_with) + Number(r.scanned_without);
    if (scannable > 0 && (scanned * 100) / scannable > OVER_REPORT_PCT) return new Set();
    if (verdictFor(r) === "likely") out.add(r.beekeeper_user_id);
  }
  return out;
}
