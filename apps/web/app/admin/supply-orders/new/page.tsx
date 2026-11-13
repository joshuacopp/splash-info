// Supply Orders -- place a Kleen-Rite order (/admin/supply-orders/new).

import Link from "next/link";
import { getMe } from "../../../_lib/me";
import NoAccessCard from "../../forms/_components/NoAccessCard";
import { canOrderSupplies } from "../_lib/access";
import { getMeta } from "../_lib/worker-fetch";
import OrderBuilder from "./OrderBuilder";

export const dynamic = "force-dynamic";

export default async function NewSupplyOrderPage() {
  const session = await getMe().catch(() => null);
  if (!session) return <NoAccessCard reason="signin" returnPath="/admin/supply-orders/new" />;

  const meta = canOrderSupplies(session) ? await getMeta() : null;

  return (
    <section className="mx-auto w-full max-w-[1280px] px-5 py-9">
      <div className="mb-2 text-sm">
        <Link href="/admin/supply-orders" className="text-splash-blue hover:underline">
          ← Supply Orders
        </Link>
      </div>
      <p className="mb-1 text-xs font-semibold uppercase tracking-[0.18em] text-sudsy-blue">Supply Orders</p>
      <h1 className="mb-5 text-2xl font-bold text-splash-navy">New Kleen-Rite order</h1>

      {!canOrderSupplies(session) ? (
        <p className="rounded-splash-md border border-gray-light bg-white px-4 py-8 text-center text-splash-navy/70">
          Ordering isn&apos;t turned on for your login. Ask a super admin for the supply_orders tool.
        </p>
      ) : !meta ? (
        <p className="rounded-splash-md border border-racecar-red bg-white px-3 py-2 text-racecar-red">
          Could not load your sites. Try again in a moment.
        </p>
      ) : meta.sites.length === 0 ? (
        <p className="rounded-splash-md border border-gray-light bg-white px-4 py-8 text-center text-splash-navy/70">
          Your login isn&apos;t linked to any site, so there is nowhere to ship an order. Ask a super admin to add your
          email or location to your site.
        </p>
      ) : (
        <OrderBuilder meta={meta} />
      )}
    </section>
  );
}
