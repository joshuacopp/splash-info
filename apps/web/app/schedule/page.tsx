// Schedule · location picker. Top-level route (NOT under /admin/*), carved on
// the apex host alongside the beekeeper-worker API (/schedule/api/*). Server
// component: SSR-fetches the accessible locations from the worker via the
// BEEKEEPER_WORKER binding and renders a searchable card grid, each linking to
// /schedule/{location_code}. Inherits the shared navy Header from the root
// layout + the Splash design system.

import Link from "next/link";
import { fetchScheduleLocations } from "./_lib/worker-fetch";
import LocationSearchGrid, {
  type LocationItem
} from "../admin/_components/LocationSearchGrid";

export const dynamic = "force-dynamic";

export default async function SchedulePickerPage() {
  const result = await fetchScheduleLocations();

  if (result.kind === "denied") {
    return (
      <section className="mx-auto w-full max-w-[640px] px-5 py-9">
        <PageHeading />
        <p className="text-racecar-red">
          You don&rsquo;t have access to the shift schedule. Contact your
          administrator.
        </p>
        <p className="mt-4">
          <Link
            href="/login?return=%2Fschedule"
            className="inline-flex items-center gap-1.5 rounded-splash-sm bg-splash-blue px-5 py-2.5 text-sm font-bold text-white shadow-splash-btn transition-colors hover:bg-splash-blue-dark"
          >
            Sign In
          </Link>
        </p>
      </section>
    );
  }

  if (result.kind === "error") {
    return (
      <section className="mx-auto w-full max-w-[820px] px-5 py-9">
        <PageHeading />
        <div className="rounded-splash-lg border border-splash-deny/50 bg-splash-deny/10 px-6 py-6">
          <h2 className="text-base font-semibold text-splash-deny">
            Couldn&rsquo;t load locations
          </h2>
          <p className="mt-2 text-sm text-splash-navy/80">
            {result.message} (status {result.status}). Try reloading.
          </p>
        </div>
      </section>
    );
  }

  const { locations } = result.data;

  if (locations.length === 0) {
    return (
      <section className="mx-auto w-full max-w-[640px] px-5 py-9">
        <PageHeading />
        <p className="text-splash-navy/70">
          Your account has schedule access but no locations are assigned. Ask
          your administrator to map a Beekeeper schedule to one of your
          locations.
        </p>
      </section>
    );
  }

  return (
    <section className="mx-auto w-full max-w-[820px] px-5 py-9">
      <PageHeading />
      <p className="mb-5 text-sm text-splash-navy/70">
        Pick a location to view and edit its weekly shift schedule.
      </p>

      <LocationSearchGrid
        locations={locations
          .slice()
          .sort((a, b) =>
            (a.name || a.code).localeCompare(b.name || b.code)
          )
          .map<LocationItem>((loc) => ({
            location_code: loc.code,
            location_pretty: loc.name || loc.code,
            href: `/schedule/${encodeURIComponent(loc.code)}`,
            secondaryLine: (
              <span className="font-mono text-xs text-splash-navy/60">
                {loc.code}
              </span>
            )
          }))}
      />
    </section>
  );
}

function PageHeading() {
  return (
    <div className="mb-2">
      <p className="mb-1 text-xs font-semibold uppercase tracking-[0.18em] text-sudsy-blue">
        Beekeeper
      </p>
      <h1 className="text-2xl font-bold text-splash-navy">Shift Schedule</h1>
    </div>
  );
}
