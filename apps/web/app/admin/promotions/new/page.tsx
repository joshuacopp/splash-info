// Brief 158b — /admin/promotions/new create form.
//
// SSR shell: gates the page (super_admin / it / marketing only — matches
// the worker's `POST /promo/api/promos` role requirement), pre-loads the
// location options, then hands off to the client form.

import Link from "next/link";
import { getMe } from "../../../_lib/me";
import { listAllLocations } from "../_lib/worker-fetch";
import NoAccessCard from "../_components/NoAccessCard";
import CreatePromoForm from "./_components/CreatePromoForm";

export const dynamic = "force-dynamic";

export default async function NewPromoPage() {
  const session = await getMe().catch(() => null);
  if (!session) {
    return <NoAccessCard reason="signin" returnPath="/admin/promotions/new" />;
  }
  if (
    session.promoRole !== "super_admin" &&
    session.promoRole !== "it" &&
    session.promoRole !== "marketing"
  ) {
    return <NoAccessCard reason="no-promo-role" />;
  }

  const locations = await listAllLocations();

  return (
    <section className="mx-auto w-full max-w-[860px] px-5 py-9">
      <div className="mb-3 text-sm">
        <Link
          href="/admin/promotions"
          className="text-splash-blue hover:underline"
        >
          ← Promotions
        </Link>
      </div>
      <h1 className="mb-1 text-2xl font-bold text-splash-navy">
        New promotion
      </h1>
      <p className="mb-6 text-sm text-splash-navy/70">
        Submit the request. IT will scope, assign, set a ready-by date, and
        flip the status to <span className="font-semibold">Scoped</span>.
      </p>

      <CreatePromoForm locations={locations} />
    </section>
  );
}
