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
      <section style={{ padding: 24, maxWidth: 480 }}>
        <h1>Pricing Admin</h1>
        <p style={{ color: "#dc2626" }}>
          You don&rsquo;t have access to Pricing Admin. Contact your administrator.
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
      <section style={{ padding: 24, maxWidth: 520 }}>
        <h1>Pricing Admin</h1>
        <p style={{ color: "#6b7280" }}>
          Your account has the Pricing Admin grant but no locations are assigned.
          Ask your administrator to add your email to the appropriate location
          rows in <code>pricing_simple</code> as Site, AM, or RM contact.
        </p>
      </section>
    );
  }

  if (locations.length === 1) {
    redirect(`/admin/pricing/${locations[0]!.location_code}`);
  }

  return (
    <section style={{ padding: 24, maxWidth: 720 }}>
      <h1 style={{ marginBottom: 12 }}>Pricing Admin</h1>
      <p style={{ color: "#6b7280", marginBottom: 18 }}>
        Pick a location to manage its MaxPass pricing.
      </p>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
          gap: 12
        }}
      >
        {locations.map((loc) => (
          <a
            key={loc.location_code}
            href={`/admin/pricing/${loc.location_code}`}
            style={{
              display: "block",
              padding: "16px 18px",
              border: "1.5px solid #dbdbdb",
              borderRadius: 10,
              textDecoration: "none",
              color: "#1c164e",
              background: "white"
            }}
          >
            <div style={{ fontWeight: 700, marginBottom: 4 }}>
              {loc.location_pretty}
            </div>
            <div style={{ fontSize: 13, color: "#6b7280" }}>
              Mode: {loc.pricing || "—"}
            </div>
          </a>
        ))}
      </div>
    </section>
  );
}
