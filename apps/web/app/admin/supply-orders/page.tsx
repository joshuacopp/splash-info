// Supply Orders -- list (/admin/supply-orders).
//
// Orders the caller placed, orders waiting on them to approve, and orders at
// their sites. The worker decides what each person sees; the site's RM does
// not need the supply_orders grant to see and approve orders at their sites.

import Link from "next/link";
import { getMe } from "../../_lib/me";
import NoAccessCard from "../forms/_components/NoAccessCard";
import { canOrderSupplies } from "./_lib/access";
import { listOrders } from "./_lib/worker-fetch";
import { STATUS_LABEL, STATUS_PILL, formatEt, money, type OrderListItem } from "./_lib/types";

export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function SupplyOrdersPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const session = await getMe().catch(() => null);
  if (!session) return <NoAccessCard reason="signin" returnPath="/admin/supply-orders" />;

  const status = sp.status === "all" ? "all" : "open";
  const data = await listOrders(status);
  const orders = data?.orders ?? [];
  const waiting = orders.filter((o) => o.awaiting_me);
  const rest = orders.filter((o) => !o.awaiting_me);
  const canOrder = data?.can_order ?? canOrderSupplies(session);

  return (
    <section className="mx-auto w-full max-w-[1200px] px-5 py-9">
      <div className="mb-2 text-sm">
        <Link href="/admin/dashboard/operations" className="text-splash-blue hover:underline">
          ← Operations
        </Link>
      </div>

      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="mb-1 text-xs font-semibold uppercase tracking-[0.18em] text-sudsy-blue">Operations</p>
          <h1 className="text-2xl font-bold text-splash-navy">Supply Orders</h1>
          <p className="mt-1 text-sm text-splash-navy/70">
            Order from Kleen-Rite. GM orders go to the site&apos;s Regional Manager for approval, then straight to
            Kleen-Rite.
          </p>
        </div>
        {canOrder && (
          <Link
            href="/admin/supply-orders/new"
            className="rounded-splash-sm bg-splash-blue px-4 py-2 text-sm font-semibold text-white hover:bg-splash-navy"
          >
            + New Kleen-Rite order
          </Link>
        )}
      </div>

      {!data && (
        <p className="mb-5 rounded-splash-md border border-racecar-red bg-white px-3 py-2 text-racecar-red">
          Could not load orders. Try again in a moment.
        </p>
      )}

      {waiting.length > 0 && (
        <div className="mb-8">
          <h2 className="mb-2 text-lg font-bold text-splash-navy">Waiting for your approval ({waiting.length})</h2>
          <OrderTable orders={waiting} />
        </div>
      )}

      <div className="mb-3 flex items-center gap-3 text-sm">
        <h2 className="text-lg font-bold text-splash-navy">{waiting.length > 0 ? "Other orders" : "Orders"}</h2>
        <Link
          href={status === "open" ? "/admin/supply-orders?status=all" : "/admin/supply-orders"}
          className="text-splash-blue hover:underline"
        >
          {status === "open" ? "Show all history" : "Show recent only"}
        </Link>
      </div>
      {rest.length === 0 ? (
        <div className="rounded-splash-md border border-gray-light bg-white px-4 py-8 text-center italic text-splash-navy/60">
          {status === "open"
            ? "No orders waiting and nothing decided in the last 14 days."
            : "No orders yet."}
          {!canOrder && data && (
            <p className="mt-2 not-italic">
              Orders at your sites appear here when your GMs place them. To place orders yourself, ask a super admin
              for the supply_orders tool.
            </p>
          )}
        </div>
      ) : (
        <OrderTable orders={rest} />
      )}
    </section>
  );
}

function OrderTable({ orders }: { orders: OrderListItem[] }) {
  return (
    <div className="overflow-x-auto rounded-splash-md border-[1.5px] border-splash-navy/15 bg-white shadow-splash-card">
      <table className="w-full text-left text-sm">
        <thead className="bg-gray-light/50 text-xs uppercase tracking-wide text-splash-navy/60">
          <tr>
            <th className="px-3 py-2">PO</th>
            <th className="px-3 py-2">Site</th>
            <th className="px-3 py-2">Items</th>
            <th className="px-3 py-2">Est.</th>
            <th className="px-3 py-2">Status</th>
            <th className="px-3 py-2">Ordered by</th>
            <th className="px-3 py-2">Placed</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-light">
          {orders.map((o) => (
            <tr key={o.id} className="align-top hover:bg-gray-light/30">
              <td className="whitespace-nowrap px-3 py-2 font-semibold">
                <Link href={`/admin/supply-orders/${o.id}`} className="text-splash-blue hover:underline">
                  {o.po_number}
                </Link>
              </td>
              <td className="whitespace-nowrap px-3 py-2">{o.site_name}</td>
              <td className="px-3 py-2">
                {o.line_count} item{o.line_count === 1 ? "" : "s"}
                <span className="text-splash-navy/50"> · {o.unit_count} units</span>
              </td>
              <td className="whitespace-nowrap px-3 py-2">{money(o.estimated_cents) || "-"}</td>
              <td className="px-3 py-2">
                <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_PILL[o.status]}`}>
                  {STATUS_LABEL[o.status]}
                </span>
              </td>
              <td className="px-3 py-2 text-splash-navy/80">{o.ordered_by_email}</td>
              <td className="whitespace-nowrap px-3 py-2 text-splash-navy/70">{formatEt(o.created_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
