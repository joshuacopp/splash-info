// Signup Admin · Recent Signups landing page (Brief 56).
//
// Mirror of /admin/pricing/page.tsx — fetches the user's accessible
// locations from signup-worker /admin/api/locations and renders a grid
// of cards linking to /admin/signups/{loc}.

import Link from "next/link";
import { workerGetJson } from "../pricing/_lib/worker-fetch";
import { SignupAdminTabs } from "../_components/SignupAdminTabs";

interface LocationSummary {
  location_code: string;
  location_pretty: string;
  pricing: string;
}
interface ListLocationsResponse {
  locations: LocationSummary[];
}

export default async function SignupsLandingPage() {
  const data = await workerGetJson<ListLocationsResponse>(
    "/admin/api/locations"
  );

  if (!data) {
    return (
      <section className="mx-auto w-full max-w-[640px] px-5 py-9">
        <SignupAdminTabs locationCode={null} active="signups" />
        <h1 className="mb-3 text-2xl font-bold text-splash-navy">
          Signup Admin · Recent Signups
        </h1>
        <p className="text-racecar-red">
          You don&rsquo;t have access to Signup Admin. Contact your
          administrator.
        </p>
        <p className="mt-4">
          <Link
            href="/login?return=%2Fadmin%2Fsignups"
            className="inline-flex items-center gap-1.5 rounded-splash-sm bg-splash-blue px-5 py-2.5 text-sm font-bold text-white shadow-splash-btn transition-colors hover:bg-splash-blue-dark"
          >
            Sign In
          </Link>
        </p>
      </section>
    );
  }

  const { locations } = data;

  if (locations.length === 0) {
    return (
      <section className="mx-auto w-full max-w-[640px] px-5 py-9">
        <SignupAdminTabs locationCode={null} active="signups" />
        <h1 className="mb-3 text-2xl font-bold text-splash-navy">
          Signup Admin · Recent Signups
        </h1>
        <p className="text-splash-navy/70">
          Your account has the Signup Admin grant but no locations are
          assigned. Ask your administrator to add your email to the
          appropriate location rows in <code>pricing_simple</code> as Site,
          AM, or RM contact.
        </p>
      </section>
    );
  }

  return (
    <section className="mx-auto w-full max-w-[820px] px-5 py-9">
      <SignupAdminTabs locationCode={null} active="signups" />

      <h1 className="mb-2 text-2xl font-bold text-splash-navy">
        Signup Admin · Recent Signups
      </h1>
      <p className="mb-5 text-sm text-splash-navy/70">
        Pick a location to see its recent customer submissions.
      </p>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
          gap: 12
        }}
      >
        {locations.map((loc) => (
          <Link
            key={loc.location_code}
            href={`/admin/signups/${encodeURIComponent(loc.location_code)}`}
            className="block rounded-splash-md border border-gray-light bg-white px-4 py-3 text-splash-navy hover:border-splash-blue/50 hover:shadow-splash-card-hover"
          >
            <div className="font-bold">{loc.location_pretty}</div>
            <div className="mt-0.5 font-mono text-xs text-splash-navy/60">
              {loc.location_code}
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}
