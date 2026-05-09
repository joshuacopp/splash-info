// Per-location signups viewer (Brief 56 + Brief 84). Read-only.
//
// Server component — fetches /admin/api/locations/{loc}/signups on
// signup-worker. Pattern mirrors /admin/pricing/[location]/page.tsx
// for sign-in-required and access-denied surfaces.
//
// Brief 84 swapped the 1/7/30 dropdown for the shared <DateRangePicker>
// component (introduced for /admin/fleet in Brief 83) and added a CSV
// export button. The legacy `?days=N` URL param continues to work for
// any old bookmarks — see worker-side parseDateRange in admin-signups.ts.

import Link from "next/link";
import {
  getSignupsForLocation,
  getSignupsCsvUrl,
  type SignupDays,
  type SignupsResponse
} from "../../pricing/_lib/worker-fetch";
import { SignupAdminTabs } from "../../_components/SignupAdminTabs";
import { DateRangePicker } from "../../../_components/DateRangePicker";
import { CsvExportButton } from "../../../_components/CsvExportButton";

interface PageProps {
  params: Promise<{ location: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const LOCATION_CODE_RE = /^[a-z0-9_]+$/;
const DEFAULT_WINDOW_DAYS = 30;
const ALLOWED_DAYS: ReadonlyArray<SignupDays> = [1, 7, 30];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function readStringParam(
  raw: string | string[] | undefined
): string | undefined {
  if (typeof raw !== "string") return undefined;
  if (raw === "") return undefined;
  return raw;
}

function parseLegacyDays(raw: string | string[] | undefined): SignupDays | null {
  if (typeof raw !== "string" || raw === "") return null;
  const n = Number.parseInt(raw, 10);
  if (n === 1 || n === 7 || n === 30) return n;
  return null;
}

function ymdUtc(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function todayYmd(): string {
  const n = new Date();
  return ymdUtc(
    new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()))
  );
}

function defaultFromYmd(): string {
  const n = new Date();
  const today = new Date(
    Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate())
  );
  return ymdUtc(new Date(today.getTime() - DEFAULT_WINDOW_DAYS * 86_400_000));
}

export default async function LocationSignupsPage({
  params,
  searchParams
}: PageProps) {
  const { location } = await params;
  const sp = await searchParams;
  const locationLower = location.toLowerCase();

  // Brief: validate with the same regex as the pricing page. Pricing
  // doesn't validate inline; we apply the worker's LOCATION_CODE_RE
  // (`^[a-z0-9_]+$`) defensively here so a malformed slug renders 404
  // chrome instead of a worker round-trip.
  if (!LOCATION_CODE_RE.test(locationLower)) {
    return (
      <section className="mx-auto w-full max-w-[640px] px-5 py-9">
        <SignupAdminTabs locationCode={null} active="signups" />
        <h1 className="mb-2 text-2xl font-bold text-splash-navy">
          Signups
        </h1>
        <p className="text-racecar-red">
          Invalid location code: <strong>{location}</strong>
        </p>
        <p className="mt-3">
          <Link href="/admin/signups" className="text-splash-blue underline">
            ← All locations
          </Link>
        </p>
      </section>
    );
  }

  // Resolve URL params. `from`/`to` (Brief 84) take precedence; `days`
  // (Brief 56) is honored when from/to aren't both present.
  const fromRaw = readStringParam(sp.from);
  const toRaw = readStringParam(sp.to);
  const validFrom = fromRaw && DATE_RE.test(fromRaw) ? fromRaw : undefined;
  const validTo = toRaw && DATE_RE.test(toRaw) ? toRaw : undefined;
  const legacyDays = parseLegacyDays(sp.days);
  const usingDateRange = validFrom != null && validTo != null;

  let data: SignupsResponse | null;
  try {
    if (usingDateRange) {
      data = await getSignupsForLocation(locationLower, {
        from: validFrom,
        to: validTo
      });
    } else if (legacyDays != null) {
      data = await getSignupsForLocation(locationLower, { days: legacyDays });
    } else {
      data = await getSignupsForLocation(locationLower, {});
    }
  } catch (err) {
    return (
      <section className="mx-auto w-full max-w-[1000px] px-5 py-9">
        <SignupAdminTabs locationCode={locationLower} active="signups" />
        <h1 className="mb-3 text-2xl font-bold text-splash-navy">
          Signups · {capitalize(locationLower)}
        </h1>
        <p className="text-racecar-red">
          Failed to load signups:{" "}
          {err instanceof Error ? err.message : "unknown error"}
        </p>
      </section>
    );
  }

  if (!data) {
    const returnPath = `/admin/signups/${encodeURIComponent(locationLower)}`;
    return (
      <section className="mx-auto w-full max-w-[640px] px-5 py-9">
        <SignupAdminTabs locationCode={locationLower} active="signups" />
        <h1 className="mb-2 text-2xl font-bold text-splash-navy">
          Signups · {capitalize(locationLower)}
        </h1>
        <p className="text-racecar-red">
          You don&rsquo;t have access to <strong>{locationLower}</strong>.
        </p>
        <p className="mt-4">
          <Link
            href={`/login?return=${encodeURIComponent(returnPath)}`}
            className="inline-flex items-center gap-1.5 rounded-splash-sm bg-splash-blue px-5 py-2.5 text-sm font-bold text-white shadow-splash-btn transition-colors hover:bg-splash-blue-dark"
          >
            Sign In
          </Link>
        </p>
        <p className="mt-3 text-sm">
          <Link href="/admin/signups" className="text-splash-blue underline">
            ← All locations
          </Link>
        </p>
      </section>
    );
  }

  const csvUrl = getSignupsCsvUrl(locationLower, {
    from: validFrom,
    to: validTo
  });

  return (
    <section className="mx-auto w-full max-w-[1000px] px-5 py-9">
      <SignupAdminTabs locationCode={locationLower} active="signups" />

      <div className="mb-2 text-sm">
        <Link href="/admin/signups" className="text-splash-blue hover:underline">
          ← All locations
        </Link>
      </div>

      <h1 className="mb-3 text-2xl font-bold text-splash-navy">
        Signups · {capitalize(locationLower)}
      </h1>

      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <DateRangePicker
          defaultFromYmd={defaultFromYmd()}
          defaultToYmd={todayYmd()}
        />
        <CsvExportButton href={csvUrl} />
      </div>

      {legacyDays != null && !usingDateRange ? (
        <LegacyDayFilter activeDays={legacyDays} location={locationLower} />
      ) : null}

      <p className="mb-4 mt-3 text-sm text-splash-navy/70">
        {data.count} signup{data.count === 1 ? "" : "s"} between{" "}
        {formatRangeLabel(data.from)} and {formatRangeLabel(data.to)}
        {data.days != null
          ? ` (last ${data.days} day${data.days === 1 ? "" : "s"})`
          : ""}
      </p>

      <SignupsTable rows={data.rows} />

      {data.limit_hit ? (
        <p className="mt-3 text-xs text-splash-navy/60">
          Showing the most recent {data.limit}. Narrow the date range to see
          all entries within a window, or use Export CSV for the complete set.
        </p>
      ) : null}
    </section>
  );
}

/* ============================================================
 * Legacy day filter (Brief 56 back-compat)
 * ============================================================
 *
 * Renders only when an old bookmark URL with `?days=N` lands on the page.
 * The shared <DateRangePicker> is the primary surface; this is a tiny
 * affordance so legacy URLs render a sensible UI rather than silently
 * ignoring the parameter.
 */

function LegacyDayFilter({
  activeDays,
  location
}: {
  activeDays: SignupDays;
  location: string;
}) {
  return (
    <nav aria-label="Day filter (legacy)" className="mt-2 flex gap-2">
      {ALLOWED_DAYS.map((d) => {
        const active = d === activeDays;
        const cls = active
          ? "inline-flex items-center rounded-full border border-splash-blue bg-splash-blue px-3.5 py-1 text-xs font-bold text-white"
          : "inline-flex items-center rounded-full border border-splash-blue bg-white px-3.5 py-1 text-xs font-bold text-splash-blue hover:bg-splash-blue/5";
        return (
          <Link
            key={d}
            href={`/admin/signups/${encodeURIComponent(location)}?days=${d}`}
            aria-current={active ? "page" : undefined}
            className={cls}
          >
            {d === 1 ? "1 day" : `${d} days`}
          </Link>
        );
      })}
    </nav>
  );
}

/* ============================================================
 * Table
 * ============================================================ */

interface RowShape {
  submitted_at: string;
  phone_formatted: string;
  email: string | null;
  package_pretty: string;
  today_price: number;
  city: string | null;
  region: string | null;
}

function SignupsTable({ rows }: { rows: RowShape[] }) {
  return (
    <div className="overflow-x-auto rounded-splash-md border border-gray-light">
      <table className="w-full border-collapse text-sm">
        <thead className="bg-sudsy-blue-soft/40 text-left text-xs uppercase tracking-wide text-splash-navy/70">
          <tr>
            <th className="px-3 py-2 font-semibold">When</th>
            <th className="px-3 py-2 font-semibold">Phone</th>
            <th className="px-3 py-2 font-semibold">Email</th>
            <th className="px-3 py-2 font-semibold">Package</th>
            <th className="px-3 py-2 font-semibold">Price</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td
                colSpan={5}
                className="px-3 py-4 text-center italic text-splash-navy/60"
              >
                No signups in this date range.
              </td>
            </tr>
          ) : (
            rows.map((r, i) => (
              <tr
                key={`${r.submitted_at}-${r.phone_formatted}-${i}`}
                className="border-t border-gray-light"
              >
                <td className="px-3 py-2 align-top text-splash-navy">
                  <span title={formatAbsolute(r.submitted_at)}>
                    {formatRelative(r.submitted_at)}
                  </span>
                </td>
                <td className="px-3 py-2 align-top text-splash-navy">
                  {r.phone_formatted}
                </td>
                <td className="px-3 py-2 align-top text-splash-navy">
                  {r.email ?? <span className="text-splash-navy/50">—</span>}
                </td>
                <td className="px-3 py-2 align-top text-splash-navy">
                  {r.package_pretty}
                </td>
                <td className="px-3 py-2 align-top text-splash-navy">
                  {formatPrice(r.today_price)}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

/* ============================================================
 * Format helpers
 * ============================================================ */

function capitalize(s: string): string {
  if (s.length === 0) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function formatRangeLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric"
  });
}

function formatAbsolute(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

function formatRelative(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const ms = Date.now() - d.getTime();
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day} day${day === 1 ? "" : "s"} ago`;
  return formatAbsolute(iso);
}

function formatPrice(n: number): string {
  if (typeof n !== "number" || Number.isNaN(n)) return "—";
  return `$${n.toFixed(2)}`;
}
