// /admin/sds-catalog — the shared chemical catalogue, curated centrally.
//
// WHY THIS EXISTS SEPARATELY FROM /sds. The catalogue is ORG-WIDE: WD-40 is one
// chemical with one sheet whether forty sites hold it or one does. Building it
// through the per-site add flow means opening a site you have no business in
// just to enter a chemical that has nothing to do with it, and then another,
// and then another. This is the surface for the person whose job is the
// catalogue rather than a binder.
//
// Admin tier, because curating the shared record is not a site's job and a
// verified entry is admin-only to edit. The worker re-checks both; this gate is
// a UX hint, not the control.

import { getMe } from "../../_lib/me";
import NoAccessCard from "../forms/_components/NoAccessCard";
import { searchSdsCatalog } from "../../sds/_lib/worker-fetch";
import CatalogAdmin from "./_components/CatalogAdmin";

export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<{ q?: string }>;
}

export default async function SdsCatalogPage({ searchParams }: PageProps) {
  const { q } = await searchParams;
  const session = await getMe().catch(() => null);
  if (!session) {
    return (
      <NoAccessCard
        reason="signin"
        returnPath="/admin/sds-catalog"
        title="SDS Catalogue"
        signinMessage="Sign in to manage the shared chemical catalogue."
      />
    );
  }

  const isAdmin =
    session.role === "super_admin" ||
    session.dcRole === "admin" ||
    session.dcRole === "super_admin";
  if (!isAdmin) {
    return (
      <NoAccessCard
        reason="forbidden"
        title="SDS Catalogue"
        signinMessage="The shared chemical catalogue is managed by administrators."
      />
    );
  }

  const rows = await searchSdsCatalog(q ?? "");

  return (
    <section className="mx-auto w-full max-w-[1100px] px-5 py-9">
      <div className="mb-5">
        <p className="mb-1 text-xs font-semibold uppercase tracking-[0.18em] text-sudsy-blue">
          Safety
        </p>
        <h1 className="text-2xl font-bold text-splash-navy">SDS Catalogue</h1>
        <p className="mt-1 text-sm text-splash-navy/70">
          Every chemical the company holds, with one safety data sheet each.
          Sites add from this list, so a sheet uploaded here reaches every binder
          that uses it.
        </p>
      </div>

      <CatalogAdmin initialRows={rows} initialQuery={q ?? ""} />
    </section>
  );
}
