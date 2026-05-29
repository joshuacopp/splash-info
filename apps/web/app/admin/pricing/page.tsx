// Admin pricing entry point — location picker.
//
// - super_admin sees every location in pricing_simple
// - location_admin with the "pricing" tool grant sees their session.locations
// - One-location users get redirected straight into the per-location grid
//
// Server component — fetches /admin/api/locations on the worker.

import Link from "next/link";
import { redirect } from "next/navigation";
import { workerGetJson } from "./_lib/worker-fetch";
import { SignupAdminTabs } from "../_components/SignupAdminTabs";
import LocationSearchGrid, {
  type LocationItem
} from "../_components/LocationSearchGrid";

interface LocationSummary {
  location_code: string;
  location_pretty: string;
  pricing: string;
}
interface ListLocationsResponse {
  locations: LocationSummary[];
}

export default async function PricingAdminPage() {
  const data = await workerGetJson<ListLocationsResponse>("/admin/api/locations");
  if (!data) {
    return (
      <section className="mx-auto w-full max-w-[520px] px-5 py-9">
        <SignupAdminTabs locationCode={null} active="pricing" />
        <h1>Signup Admin · Pricing</h1>
        <p style={{ color: "#dc2626" }}>
          You don&rsquo;t have access to Signup Admin. Contact your administrator.
        </p>
        <p style={{ marginTop: 16 }}>
          <Link
            href="/login?return=%2Fadmin%2Fpricing"
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
      <section className="mx-auto w-full max-w-[520px] px-5 py-9">
        <SignupAdminTabs locationCode={null} active="pricing" />
        <h1>Signup Admin · Pricing</h1>
        <p style={{ color: "#6b7280" }}>
          Your account has the Signup Admin grant but no locations are assigned.
          Ask your administrator to add your email to the appropriate location
          rows in <code>pricing_simple</code> as Site, AM, or RM contact.
        </p>
      </section>
    );
  }

  if (locations.length === 1) {
    redirect(`/admin/pricing/${locations[0]!.location_code}`);
  }

  const items: LocationItem[] = locations.map((loc) => ({
    location_code: loc.location_code,
    location_pretty: loc.location_pretty,
    href: `/admin/pricing/${loc.location_code}`,
    secondaryLine: (
      <span className="text-xs text-splash-navy/60">
        Mode: {loc.pricing || "—"}
      </span>
    )
  }));

  return (
    <section className="mx-auto w-full max-w-[820px] px-5 py-9">
      <SignupAdminTabs locationCode={null} active="pricing" />
      <h1 style={{ marginBottom: 12 }}>Signup Admin · Pricing</h1>
      <p style={{ color: "#6b7280", marginBottom: 18 }}>
        Pick a location to manage its MaxPass pricing.
      </p>
      <LocationSearchGrid locations={items} />
    </section>
  );
}
