// /admin/damage/car-counts
//
// Server component. Fetches the dc_role-scoped car-count ranges from the
// damage-worker (GET /manage/api/car-counts) and the scoped location roster
// (GET /manage/api/locations, the same source the claims list uses for its
// location dropdown), renders an entry form + a table of existing ranges.
//
// Writes go through server actions in ./actions.ts, which POST via
// damagePostForm and return { redirectTo } (NOT redirect() — that costs ~20s
// under OpenNext). <RedirectForm> pushes the URL client-side. The worker owns
// all validation (date shape, end>=start, cars>=0, no overlaps -> 409); those
// messages land in the action-error banner unchanged.
//
// Modelled on the greeters monthly-targets form + the damage claims list page.

import Link from "next/link";
import { damageGetJson, damageGetJsonOrStatus } from "../_lib/worker-fetch";
import { DamageTabs } from "../_components/DamageTabs";
import { RedirectForm } from "../../_components/RedirectForm";
import { SaveCarCountButton } from "./_components/SaveCarCountButton";
import { DeleteCarCountButton } from "./_components/DeleteCarCountButton";
import { setCarCountAction, deleteCarCountAction } from "./actions";
import type { CarCountRow } from "@splash/types/claims";

// Shape returned from GET /manage/api/locations (the dc_role-scoped set of
// locations). Same interface the claims list page uses.
interface LocationRosterEntry {
  location_code: string;
  location_pretty: string;
  claim_count: number;
}

// GET /manage/api/car-counts → { car_counts: CarCountRow[] }.
interface CarCountsResponse {
  car_counts: CarCountRow[];
}

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function firstParam(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

// Success keys the actions can hand back. Kept tiny — the writes are a save
// and a delete, nothing else.
const SUCCESS_COPY: Record<string, string> = {
  car_count: "Car count saved.",
  car_count_deleted: "Car count deleted."
};

function formatDate(iso: string): string {
  // 'YYYY-MM-DD' already; slice defends against a stored timestamp.
  return iso.length >= 10 ? iso.slice(0, 10) : iso;
}

function formatRange(start: string, end: string): string {
  const s = formatDate(start);
  const e = formatDate(end);
  return s === e ? s : `${s} → ${e}`;
}

const LABEL_CLS =
  "text-xs font-semibold uppercase tracking-wider text-splash-navy/70";
const INPUT_CLS =
  "rounded-splash-sm border border-gray-light bg-white px-3 py-2 text-sm text-splash-navy placeholder:text-splash-navy/40 focus:border-splash-blue focus:outline-none";

export default async function DamageCarCountsPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const actionError = firstParam(sp.action_error).trim() || null;
  const successKey = firstParam(sp.success).trim();
  const successMessage = SUCCESS_COPY[successKey] ?? null;

  // Fetch the car counts with the status-aware helper so we can split 401
  // (stale session) from 403 (no access) the same way the claims list does.
  // The location roster is null-tolerant — an empty dropdown beats a crash.
  let countsResult:
    | { kind: "ok"; rows: CarCountRow[] }
    | { kind: "denied" }
    | { kind: "session_stale" }
    | { kind: "error"; message: string }
    | null = null;
  let locationRoster: LocationRosterEntry[] = [];
  try {
    const [countsRaw, locations] = await Promise.all([
      damageGetJsonOrStatus<CarCountsResponse>("/manage/api/car-counts"),
      damageGetJson<LocationRosterEntry[]>("/manage/api/locations").then(
        (r) => r ?? []
      )
    ]);
    locationRoster = locations;
    if ("data" in countsRaw) {
      countsResult = { kind: "ok", rows: countsRaw.data.car_counts ?? [] };
    } else if (countsRaw.status === 401) {
      countsResult = { kind: "session_stale" };
    } else if (countsRaw.status === 403) {
      countsResult = { kind: "denied" };
    } else {
      countsResult = {
        kind: "error",
        message: `Worker GET /manage/api/car-counts failed: ${countsRaw.status}`
      };
    }
  } catch (err) {
    countsResult = {
      kind: "error",
      message:
        err instanceof Error ? err.message : "Unknown error fetching car counts."
    };
  }

  if (
    countsResult &&
    (countsResult.kind === "session_stale" || countsResult.kind === "denied")
  ) {
    const returnPath = "/admin/damage/car-counts";
    if (countsResult.kind === "session_stale") {
      return (
        <section className="mx-auto w-full max-w-[1100px] px-5 py-9">
          <DamageTabs active="car-counts" />
          <PageBanner />
          <div className="rounded-splash-lg border border-gray-light bg-white p-6 shadow-splash-card">
            <p className="mb-4 text-splash-navy/80">
              Session expired or hasn&rsquo;t fully loaded. Try refreshing the
              page or signing out and back in.
            </p>
            <Link
              href={`/logout?return=${encodeURIComponent(returnPath)}`}
              className="inline-flex items-center gap-1.5 rounded-splash-sm bg-splash-blue px-5 py-2.5 text-sm font-bold text-white shadow-splash-btn transition-colors hover:bg-splash-blue-dark"
            >
              Sign in again
            </Link>
          </div>
        </section>
      );
    }
    return (
      <section className="mx-auto w-full max-w-[1100px] px-5 py-9">
        <DamageTabs active="car-counts" />
        <PageBanner />
        <div className="rounded-splash-lg border border-gray-light bg-white p-6 shadow-splash-card">
          <p className="mb-4 text-splash-deny">
            You don&rsquo;t have access to Damage Car Counts. Contact your
            administrator if this is unexpected.
          </p>
          <Link
            href={`/login?return=${encodeURIComponent(returnPath)}`}
            className="inline-flex items-center gap-1.5 rounded-splash-sm bg-splash-blue px-5 py-2.5 text-sm font-bold text-white shadow-splash-btn transition-colors hover:bg-splash-blue-dark"
          >
            Sign In
          </Link>
        </div>
      </section>
    );
  }

  if (countsResult && countsResult.kind === "error") {
    return (
      <section className="mx-auto w-full max-w-[1100px] px-5 py-9">
        <DamageTabs active="car-counts" />
        <PageBanner />
        <div className="rounded-splash-lg border border-gray-light bg-white p-6 shadow-splash-card">
          <h2 className="mb-2 text-lg font-bold text-splash-deny">
            Could not load car counts
          </h2>
          <p className="text-sm text-splash-navy/80">{countsResult.message}</p>
          <p className="mt-2 text-sm text-splash-navy/60">
            Reload the page to retry.
          </p>
        </div>
      </section>
    );
  }

  const rows = countsResult && countsResult.kind === "ok" ? countsResult.rows : [];

  // Location dropdown options — dc_role-scoped roster, sorted by pretty name.
  // Rows already in the table are merged in as a fallback so a location that
  // has a count but somehow isn't in the roster still shows a readable label.
  const locationMap = new Map<string, string>();
  for (const loc of locationRoster) {
    locationMap.set(loc.location_code, loc.location_pretty);
  }
  for (const r of rows) {
    if (!locationMap.has(r.location_code)) {
      locationMap.set(r.location_code, r.location_code);
    }
  }
  const locationOptions = Array.from(locationMap.entries()).sort(
    ([, a], [, b]) => a.localeCompare(b)
  );
  const prettyFor = (code: string) => locationMap.get(code) ?? code;

  return (
    <section className="mx-auto w-full max-w-[1100px] px-5 py-9">
      <DamageTabs active="car-counts" />
      {actionError ? <ActionBanner message={actionError} /> : null}
      {successMessage ? <SuccessBanner message={successMessage} /> : null}
      <PageBanner />

      {/* Entry form — create or update one car-count range. The worker owns
          all validation (date shape, end>=start, cars>=0, overlaps -> 409);
          the only up-front check is that a location was picked. */}
      <div className="mb-6 rounded-splash-lg border border-gray-light bg-white p-5 shadow-splash-card">
        <h2 className="mb-1 text-lg font-bold text-splash-navy">
          Add a car count
        </h2>
        <p className="mb-4 text-sm text-splash-navy/70">
          One entry per date range per location. Ranges for the same location
          cannot overlap. Cost-per-car on the Reporting page divides repair
          cost by the cars counted for the overlapping range.
        </p>
        <RedirectForm action={setCarCountAction} className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <label className="flex flex-col gap-1">
              <span className={LABEL_CLS}>Location *</span>
              <select name="location_code" required className={INPUT_CLS} defaultValue="">
                <option value="" disabled>
                  Select a location…
                </option>
                {locationOptions.map(([code, pretty]) => (
                  <option key={code} value={code}>
                    {pretty}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1">
              <span className={LABEL_CLS}>Start date *</span>
              <input type="date" name="start_date" required className={INPUT_CLS} />
            </label>

            <label className="flex flex-col gap-1">
              <span className={LABEL_CLS}>End date *</span>
              <input type="date" name="end_date" required className={INPUT_CLS} />
            </label>

            <label className="flex flex-col gap-1">
              <span className={LABEL_CLS}>Cars *</span>
              <input
                type="number"
                name="cars"
                required
                min="0"
                step="1"
                placeholder="0"
                className={INPUT_CLS}
              />
            </label>

            <label className="flex flex-col gap-1 sm:col-span-2">
              <span className={LABEL_CLS}>Note</span>
              <input
                type="text"
                name="note"
                maxLength={500}
                placeholder="Optional"
                className={INPUT_CLS}
              />
            </label>
          </div>
          <div className="mt-1">
            <SaveCarCountButton>Save car count</SaveCarCountButton>
          </div>
        </RedirectForm>
      </div>

      {/* Existing ranges */}
      {rows.length === 0 ? (
        <div className="rounded-splash-lg border border-gray-light bg-white p-6 shadow-splash-card">
          <p className="text-splash-navy/80">
            No car counts recorded yet. Add one above.
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-splash-lg border border-gray-light bg-white shadow-splash-card">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-light text-sm">
              <thead className="bg-splash-navy/5 text-left text-xs font-semibold uppercase tracking-wider text-splash-navy/70">
                <tr>
                  <th className="px-4 py-3">Location</th>
                  <th className="px-4 py-3">Date range</th>
                  <th className="px-4 py-3 text-right">Cars</th>
                  <th className="px-4 py-3">Note</th>
                  <th className="px-4 py-3">Updated</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-light text-splash-navy">
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="px-4 py-3">
                      <div className="text-splash-navy">{prettyFor(r.location_code)}</div>
                      <div className="font-mono text-xs text-splash-navy/60">
                        {r.location_code}
                      </div>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-splash-navy/80">
                      {formatRange(r.start_date, r.end_date)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-splash-navy">
                      {r.cars.toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-splash-navy/80">
                      {r.note ? r.note : "—"}
                    </td>
                    <td className="px-4 py-3 text-xs text-splash-navy/70">
                      <div>{r.updated_by ?? "—"}</div>
                      <div className="font-mono text-splash-navy/60">
                        {formatDate(r.updated_at)}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <RedirectForm action={deleteCarCountAction}>
                        <input type="hidden" name="id" value={String(r.id)} />
                        <DeleteCarCountButton
                          confirmText={`Delete the car count for ${prettyFor(
                            r.location_code
                          )} (${formatRange(r.start_date, r.end_date)})? This can't be undone.`}
                        />
                      </RedirectForm>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}

function ActionBanner({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="mb-5 flex flex-col gap-2 rounded-splash-md border border-splash-deny/40 bg-splash-deny/10 p-4 text-sm text-splash-deny sm:flex-row sm:items-center sm:justify-between"
    >
      <span className="font-bold">{message}</span>
      <Link
        href="/admin/damage/car-counts"
        className="text-xs font-semibold underline underline-offset-2 hover:text-splash-deny/80"
      >
        Dismiss
      </Link>
    </div>
  );
}

function SuccessBanner({ message }: { message: string }) {
  return (
    <div
      role="status"
      className="mb-5 flex flex-col gap-2 rounded-splash-md border border-splash-success/40 bg-splash-success/10 p-4 text-sm text-splash-success sm:flex-row sm:items-center sm:justify-between"
    >
      <span className="font-bold">{message}</span>
      <Link
        href="/admin/damage/car-counts"
        className="text-xs font-semibold underline underline-offset-2 hover:text-splash-success/80"
      >
        Dismiss
      </Link>
    </div>
  );
}

function PageBanner() {
  return (
    <div className="mb-6">
      <p className="mb-1 text-xs font-semibold uppercase tracking-[0.18em] text-sudsy-blue">
        Internal Tools
      </p>
      <h1 className="text-2xl font-bold text-splash-navy">Damage Car Counts</h1>
    </div>
  );
}
