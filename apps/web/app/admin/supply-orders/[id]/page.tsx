// Supply Orders -- one order (/admin/supply-orders/{id}).
//
// The RM lands here from the approval email: review, change quantities or
// remove items, then approve (sends to Kleen-Rite) or deny with a reason.
// The worker decides who may see and act; a 404 covers "not yours" too.

import Link from "next/link";
import { notFound } from "next/navigation";
import { getMe } from "../../../_lib/me";
import NoAccessCard from "../../forms/_components/NoAccessCard";
import { ActionForm } from "../../_components/ActionForm";
import { SubmitButton } from "../../_components/SubmitButton";
import { cancelOrderAction } from "../actions";
import { getOrderDetail } from "../_lib/worker-fetch";
import { STATUS_LABEL, STATUS_PILL, formatEt, money, type OrderEvent } from "../_lib/types";
import ApprovalPanel from "./ApprovalPanel";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const EVENT_LABEL: Record<string, string> = {
  created: "Order placed",
  edited: "Quantities changed",
  approved: "Approved and sent to Kleen-Rite",
  sent: "Sent to Kleen-Rite",
  denied: "Denied",
  cancelled: "Cancelled",
  send_failed: "Email to Kleen-Rite failed"
};

function eventDetail(e: OrderEvent): string | null {
  if (e.kind === "edited" && Array.isArray(e.details.changes)) {
    return (e.details.changes as Array<{ sku: string; from: number; to: number }>)
      .map((c) => (c.to === 0 ? `${c.sku} removed` : `${c.sku} ${c.from} → ${c.to}`))
      .join(", ");
  }
  if ((e.kind === "approved" || e.kind === "sent") && typeof e.details.to === "string") {
    const cc = Array.isArray(e.details.cc) && e.details.cc.length ? `, cc ${(e.details.cc as string[]).join(", ")}` : "";
    return `To ${e.details.to}${cc}${e.details.test ? " (test mode)" : ""}`;
  }
  if (e.kind === "created" && e.details.direct) return "No approval needed";
  return null;
}

export default async function SupplyOrderPage({ params, searchParams }: PageProps) {
  const { id } = await params;
  const sp = await searchParams;
  const session = await getMe().catch(() => null);
  if (!session) return <NoAccessCard reason="signin" returnPath={`/admin/supply-orders/${id}`} />;

  const data = await getOrderDetail(id);
  if (!data) notFound();
  const { order, lines, events } = data;

  return (
    <section className="mx-auto w-full max-w-[1100px] px-5 py-9">
      <div className="mb-2 text-sm">
        <Link href="/admin/supply-orders" className="text-splash-blue hover:underline">
          ← Kleen-Rite Orders
        </Link>
      </div>

      {sp.placed === "1" && (
        <p className="mb-4 rounded-splash-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
          {order.status === "sent"
            ? "Order sent to Kleen-Rite."
            : order.status === "pending_approval" && order.approver_email === session.email.toLowerCase()
              ? "Order saved, but the email to Kleen-Rite could not be queued. Press Approve below to try again."
              : `Order sent to ${order.approver_email} for approval. You'll get an email when it's decided.`}
        </p>
      )}

      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="mb-1 text-xs font-semibold uppercase tracking-[0.18em] text-sudsy-blue">Kleen-Rite order</p>
          <h1 className="font-mono text-2xl font-bold text-splash-navy">PO {order.po_number}</h1>
          <p className="mt-1 text-sm text-splash-navy/70">
            {order.site_name} · placed by {order.ordered_by_email} · {formatEt(order.created_at)}
          </p>
        </div>
        <span className={`rounded-full px-3 py-1 text-sm font-semibold ${STATUS_PILL[order.status]}`}>
          {STATUS_LABEL[order.status]}
        </span>
      </div>

      {order.status === "pending_approval" && order.approver_email && !data.can_approve && (
        <p className="mb-4 text-sm text-splash-navy/80">
          Waiting on <strong>{order.approver_email}</strong>.
        </p>
      )}
      {order.decision_note && (
        <p className="mb-4 rounded-splash-md bg-amber-50 px-3 py-2 text-sm text-splash-navy">
          <strong>{order.status === "denied" ? "Reason" : "Note"} from {order.decided_by_email}:</strong>{" "}
          {order.decision_note}
        </p>
      )}
      {order.note && (
        <p className="mb-4 rounded-splash-md bg-sudsy-blue-soft px-3 py-2 text-sm text-splash-navy">
          <strong>Note from {order.ordered_by_email}:</strong> {order.note}
        </p>
      )}

      {data.can_approve ? (
        <ApprovalPanel
          orderId={order.id}
          lines={lines}
          live={data.live}
          vendorTo={data.vendor_to}
          isOwn={order.ordered_by_email === session.email.toLowerCase()}
        />
      ) : (
        <div className="mb-6 overflow-x-auto rounded-splash-md border-[1.5px] border-splash-navy/15 bg-white shadow-splash-card">
          <table className="w-full text-left text-sm">
            <thead className="bg-gray-light/50 text-xs uppercase tracking-wide text-splash-navy/60">
              <tr>
                <th className="px-3 py-2">Item #</th>
                <th className="px-3 py-2">Description</th>
                <th className="px-3 py-2 text-right">Qty</th>
                <th className="px-3 py-2 text-right">Est.</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-light">
              {lines.map((l) => (
                <tr key={l.id} className="align-top">
                  <td className="whitespace-nowrap px-3 py-2 font-mono text-xs font-semibold">{l.sku}</td>
                  <td className="px-3 py-2">
                    {l.product_url ? (
                      <a href={l.product_url} target="_blank" rel="noopener noreferrer" className="hover:text-splash-blue hover:underline">
                        {l.name}
                      </a>
                    ) : (
                      l.name
                    )}
                    {l.source === "manual" && <span className="ml-2 text-xs text-splash-navy/50">(typed in)</span>}
                  </td>
                  <td className="px-3 py-2 text-right">{l.qty}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-right">
                    {l.unit_price_cents != null ? money(l.unit_price_cents * l.qty) : "-"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.estimated_cents != null && (
            <p className="border-t border-gray-light px-3 py-2 text-right text-sm text-splash-navy">
              Estimated <strong>{money(data.estimated_cents)}</strong>{" "}
              <span className="text-xs text-splash-navy/60">(Kleen-Rite public prices)</span>
            </p>
          )}
        </div>
      )}

      <div className="grid gap-5 md:grid-cols-2">
        <div className="rounded-splash-md border border-gray-light bg-white p-4">
          <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-splash-navy/70">
            {order.status === "sent" ? "Email sent to Kleen-Rite" : "Email Kleen-Rite will get"}
          </h2>
          {order.status === "sent" ? (
            <p className="mb-2 text-xs text-splash-navy/60">
              To {order.vendor_email_to}
              {order.vendor_email_cc.length ? ` · CC ${order.vendor_email_cc.join(", ")}` : ""}
              {order.vendor_reply_to ? ` · replies to ${order.vendor_reply_to}` : ""} · {formatEt(order.sent_at)}
            </p>
          ) : (
            data.vendor_to && (
              <p className="mb-2 text-xs text-splash-navy/60">
                To {data.live ? data.vendor_to : "the test inbox (test mode)"} · CC the site · replies go to the RM
              </p>
            )
          )}
          {data.vendor_preview && (
            <>
              <p className="mb-1 text-xs font-semibold text-splash-navy">{data.vendor_preview.subject}</p>
              <pre className="whitespace-pre-wrap rounded-splash-sm bg-gray-light/30 p-3 font-sans text-sm text-splash-navy">
                {data.vendor_preview.text}
              </pre>
            </>
          )}
        </div>

        <div className="rounded-splash-md border border-gray-light bg-white p-4">
          <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-splash-navy/70">History</h2>
          <ol className="space-y-2 text-sm">
            {events.map((e) => {
              const detail = eventDetail(e);
              return (
                <li key={e.id}>
                  <span className="font-semibold text-splash-navy">{EVENT_LABEL[e.kind] ?? e.kind}</span>
                  <span className="text-splash-navy/60"> · {e.actor_email ?? "system"} · {formatEt(e.at)}</span>
                  {detail && <div className="text-xs text-splash-navy/70">{detail}</div>}
                  {e.note && e.kind !== "created" && <div className="text-xs italic text-splash-navy/70">{e.note}</div>}
                </li>
              );
            })}
          </ol>
          {data.can_cancel && (
            <ActionForm action={cancelOrderAction} className="mt-4">
              <input type="hidden" name="id" value={order.id} />
              <SubmitButton
                pendingText="Cancelling…"
                className="rounded-splash-sm border border-racecar-red px-3 py-1.5 text-sm font-semibold text-racecar-red hover:bg-racecar-red hover:text-white"
              >
                Cancel this order
              </SubmitButton>
            </ActionForm>
          )}
        </div>
      </div>
    </section>
  );
}
