// Schedule · per-location week grid. Server component: SSR-fetches the
// location context (schedule meta + assignable roster) and the current ET
// week's shifts from beekeeper-worker, then hands both to the interactive
// client grid. Access + per-location scope are enforced worker-side; this page
// surfaces 401/403 as a sign-in prompt and unmapped/unknown codes as an error.

import Link from "next/link";
import {
  fetchScheduleContext,
  fetchScheduleShifts,
  etToday,
  mondayOf,
  weekQueryWindow,
  type ShiftView
} from "../_lib/worker-fetch";
import { ScheduleWeekGrid } from "../_components/ScheduleWeekGrid";

export const dynamic = "force-dynamic";

const LOCATION_CODE_RE = /^[a-z0-9_]+$/;

interface PageProps {
  params: Promise<{ location: string }>;
}

export default async function ScheduleLocationPage({ params }: PageProps) {
  const { location } = await params;
  const code = location.toLowerCase();

  if (!LOCATION_CODE_RE.test(code)) {
    return (
      <Shell>
        <BackLink />
        <h1 className="mb-2 text-2xl font-bold text-splash-navy">Schedule</h1>
        <p className="text-racecar-red">
          Invalid location code: <strong>{location}</strong>
        </p>
      </Shell>
    );
  }

  const ctxResult = await fetchScheduleContext(code);

  if (ctxResult.kind === "denied") {
    const returnPath = `/schedule/${encodeURIComponent(code)}`;
    return (
      <Shell>
        <BackLink />
        <h1 className="mb-2 text-2xl font-bold text-splash-navy">
          Schedule · {capitalize(code)}
        </h1>
        <p className="text-racecar-red">
          You don&rsquo;t have access to <strong>{code}</strong>.
        </p>
        <p className="mt-4">
          <Link
            href={`/login?return=${encodeURIComponent(returnPath)}`}
            className="inline-flex items-center gap-1.5 rounded-splash-sm bg-splash-blue px-5 py-2.5 text-sm font-bold text-white shadow-splash-btn transition-colors hover:bg-splash-blue-dark"
          >
            Sign In
          </Link>
        </p>
      </Shell>
    );
  }

  if (ctxResult.kind === "error") {
    return (
      <Shell>
        <BackLink />
        <h1 className="mb-2 text-2xl font-bold text-splash-navy">
          Schedule · {capitalize(code)}
        </h1>
        <div className="rounded-splash-lg border border-splash-deny/50 bg-splash-deny/10 px-6 py-6">
          <h2 className="text-base font-semibold text-splash-deny">
            Couldn&rsquo;t load this schedule
          </h2>
          <p className="mt-2 text-sm text-splash-navy/80">
            {ctxResult.message} (status {ctxResult.status}).
          </p>
        </div>
      </Shell>
    );
  }

  const context = ctxResult.data;

  // Current ET week + its shifts, fetched server-side to avoid a load flash.
  const monday = mondayOf(etToday());
  const { startIso, endIso } = weekQueryWindow(monday);
  const shiftsResult = await fetchScheduleShifts(code, startIso, endIso);
  const initialShifts: ShiftView[] =
    shiftsResult.kind === "ok" ? shiftsResult.data.shifts : [];
  const initialShiftsError =
    shiftsResult.kind === "error" ? shiftsResult.message : null;

  return (
    <Shell>
      <BackLink />
      <ScheduleWeekGrid
        locationCode={code}
        locationName={context.name || capitalize(code)}
        roster={context.roster}
        initialMonday={monday}
        initialShifts={initialShifts}
        initialShiftsError={initialShiftsError}
      />
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <section className="mx-auto w-full max-w-[1200px] px-5 py-9">
      {children}
    </section>
  );
}

function BackLink() {
  // print:hidden — the wall copy of the schedule carries the schedule and
  // nothing else; app navigation on a break-room page is noise.
  return (
    <div className="mb-3 text-sm print:hidden">
      <Link href="/schedule" className="text-splash-blue hover:underline">
        ← All locations
      </Link>
    </div>
  );
}

function capitalize(s: string): string {
  if (s.length === 0) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}
