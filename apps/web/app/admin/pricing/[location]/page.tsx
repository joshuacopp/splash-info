// Per-location pricing admin grid.
//
// Server component — fetches /admin/api/locations/{loc} on the worker
// (which performs the auth + scope check). Hands the data to the client
// `PricingGrid` component for interactive mode buttons + Quick Flip + the
// Special-price modal.

import Link from "next/link";
import { notFound } from "next/navigation";
import { workerGetJsonResult } from "../_lib/worker-fetch";
import { SignupAdminTabs } from "../../_components/SignupAdminTabs";
import { PricingGrid } from "./grid";

interface PageProps {
  params: Promise<{ location: string }>;
}

interface PricingSimpleRow {
  location_code: string;
  location_pretty: string;
  pkg: string;
  pricing: string | null;
  special: number | null;
  updated_at: string | null;
  site_email: string | null;
  am_email: string | null;
  rm_email: string | null;
  bogo?: boolean;
}

interface PricingResolvedRow {
  location_pretty: string;
  location_code: string;
  pkg: string;
  pretty_pkg: string;
  today: number | null;
  ongoing: number | null;
  sort: number | null;
  bogo?: boolean;
}

interface LocationDetailResponse {
  location_code: string;
  location_pretty: string;
  packages: PricingSimpleRow[];
  resolved: PricingResolvedRow[];
}

export default async function LocationPricingPage({ params }: PageProps) {
  const { location } = await params;

  const { data, status } = await workerGetJsonResult<LocationDetailResponse>(
    `/admin/api/locations/${encodeURIComponent(location)}`
  );

  // Not a location at all -- a stray path under this route, which middleware's
  // legacy /admin/{slug} -> /admin/pricing/{slug} redirect makes easy to reach.
  // A 404 is the honest answer; the sign-in page below would be telling a
  // signed-in operator to sign in again over a URL that was never a site.
  if (status === 404) {
    notFound();
  }

  if (!data) {
    const returnPath = `/admin/pricing/${encodeURIComponent(location)}`;
    return (
      <section className="mx-auto w-full max-w-[520px] px-5 py-9">
        <SignupAdminTabs locationCode={location} active="pricing" />
        <h1>Signup Admin · Pricing</h1>
        <p style={{ color: "#dc2626" }}>
          You don&rsquo;t have access to <strong>{location}</strong>.
        </p>
        <p style={{ marginTop: 16 }}>
          <Link
            href={`/login?return=${encodeURIComponent(returnPath)}`}
            className="inline-flex items-center gap-1.5 rounded-splash-sm bg-splash-blue px-5 py-2.5 text-sm font-bold text-white shadow-splash-btn transition-colors hover:bg-splash-blue-dark"
          >
            Sign In
          </Link>
        </p>
        <p style={{ marginTop: 12 }}>
          <a href="/admin/pricing">← Back to location picker</a>
        </p>
      </section>
    );
  }

  return (
    <section className="mx-auto w-full max-w-[880px] px-5 py-9">
      <SignupAdminTabs locationCode={location} active="pricing" />
      <p style={{ marginBottom: 8 }}>
        <a href="/admin/pricing" style={{ color: "#2b3491" }}>
          ← All locations
        </a>
      </p>
      <h1 style={{ marginBottom: 4 }}>{data.location_pretty}</h1>
      <p style={{ color: "#6b7280", marginBottom: 18, fontFamily: "monospace" }}>
        {data.location_code}
      </p>
      <PricingGrid
        locationCode={data.location_code}
        locationPretty={data.location_pretty}
        packages={data.packages}
        resolved={data.resolved}
      />
    </section>
  );
}
