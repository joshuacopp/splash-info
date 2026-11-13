"use client";

// The approver's view of a pending order: quantities are editable (0
// removes a line), then Approve sends to Kleen-Rite or Deny returns it to the
// GM with a reason. The worker records every quantity change on the timeline.

import { useMemo, useState } from "react";
import { ActionForm } from "../../_components/ActionForm";
import { SubmitButton } from "../../_components/SubmitButton";
import { approveOrderAction, denyOrderAction } from "../actions";
import { money, type Line } from "../_lib/types";

export default function ApprovalPanel({
  orderId,
  lines,
  live,
  vendorTo,
  isOwn
}: {
  orderId: string;
  lines: Line[];
  live: boolean;
  vendorTo: string | null;
  isOwn: boolean;
}) {
  const [qty, setQty] = useState<Record<number, number>>(() => Object.fromEntries(lines.map((l) => [l.line_no, l.qty])));
  const [denying, setDenying] = useState(false);

  const changed = lines.filter((l) => qty[l.line_no] !== l.qty);
  const remaining = lines.filter((l) => (qty[l.line_no] ?? 0) > 0);
  const total = useMemo(() => {
    const priced = remaining.filter((l) => l.unit_price_cents != null);
    return priced.length ? priced.reduce((n, l) => n + (qty[l.line_no] ?? 0) * (l.unit_price_cents ?? 0), 0) : null;
  }, [remaining, qty]);

  return (
    <div className="mb-6 rounded-splash-md border-2 border-splash-blue bg-white shadow-splash-card">
      <div className="border-b border-gray-light px-4 py-3">
        <h2 className="text-lg font-bold text-splash-navy">{isOwn ? "Send this order" : "Your approval is needed"}</h2>
        <p className="text-sm text-splash-navy/70">
          Change a quantity or set it to 0 to remove an item, then approve.{" "}
          {live ? `Approving emails the order to ${vendorTo ?? "Kleen-Rite"}.` : "Test mode: the email goes to the test inbox, not Kleen-Rite."}
        </p>
      </div>
      <div className="overflow-x-auto">
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
            {lines.map((l) => {
              const q = qty[l.line_no] ?? 0;
              return (
                <tr key={l.id} className={`align-top ${q === 0 ? "bg-red-50 text-splash-navy/40 line-through" : ""}`}>
                  <td className="whitespace-nowrap px-3 py-2 font-mono text-xs font-semibold">{l.sku}</td>
                  <td className="px-3 py-2">
                    {l.product_url ? (
                      <a href={l.product_url} target="_blank" rel="noopener noreferrer" className="hover:text-splash-blue hover:underline">
                        {l.name}
                      </a>
                    ) : (
                      l.name
                    )}
                    {l.source === "manual" && <span className="ml-2 text-xs text-splash-navy/50 no-underline">(typed in)</span>}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <input
                      type="number"
                      min={0}
                      max={9999}
                      value={q}
                      aria-label={`Quantity of ${l.sku}`}
                      onChange={(e) =>
                        setQty((prev) => ({
                          ...prev,
                          [l.line_no]: Math.max(0, Math.min(9999, Number.parseInt(e.target.value, 10) || 0))
                        }))
                      }
                      className="w-20 rounded-splash-sm border border-gray-light px-2 py-1 text-right text-sm no-underline"
                    />
                    {q !== l.qty && <div className="text-xs text-amber-700 no-underline">was {l.qty}</div>}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right">
                    {l.unit_price_cents != null && q > 0 ? money(l.unit_price_cents * q) : "-"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {total != null && (
        <p className="border-t border-gray-light px-4 py-2 text-right text-sm text-splash-navy">
          Estimated <strong>{money(total)}</strong> <span className="text-xs text-splash-navy/60">(Kleen-Rite public prices)</span>
        </p>
      )}

      <div className="grid gap-4 border-t border-gray-light p-4 md:grid-cols-2">
        <ActionForm action={approveOrderAction} resetOnSuccess={false}>
          <input type="hidden" name="id" value={orderId} />
          <input
            type="hidden"
            name="lines"
            value={JSON.stringify(changed.map((l) => ({ line_no: l.line_no, qty: qty[l.line_no] ?? 0 })))}
          />
          <label className="mb-1 block text-sm font-semibold text-splash-navy" htmlFor="approve-note">
            Note to the GM (optional)
          </label>
          <textarea id="approve-note" name="note" rows={2} maxLength={1000} className="mb-2 w-full rounded-splash-sm border border-gray-light px-3 py-2 text-sm" />
          <SubmitButton
            pendingText="Sending…"
            disabled={remaining.length === 0}
            className="w-full rounded-splash-sm bg-splash-success px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:bg-gray-light"
          >
            {isOwn ? "Send to Kleen-Rite" : changed.length ? `Approve with ${changed.length} change(s) and send` : "Approve and send to Kleen-Rite"}
          </SubmitButton>
          {remaining.length === 0 && <p className="mt-1 text-xs text-racecar-red">Every item is set to 0. Deny the order instead.</p>}
        </ActionForm>

        {!isOwn && (
        <div>
          {!denying ? (
            <button
              type="button"
              onClick={() => setDenying(true)}
              className="mt-7 w-full rounded-splash-sm border border-racecar-red px-4 py-2 text-sm font-semibold text-racecar-red hover:bg-racecar-red hover:text-white"
            >
              Deny…
            </button>
          ) : (
            <ActionForm action={denyOrderAction} resetOnSuccess={false}>
              <input type="hidden" name="id" value={orderId} />
              <label className="mb-1 block text-sm font-semibold text-splash-navy" htmlFor="deny-note">
                Why? (the GM sees this)
              </label>
              <textarea
                id="deny-note"
                name="note"
                rows={2}
                required
                maxLength={1000}
                className="mb-2 w-full rounded-splash-sm border border-gray-light px-3 py-2 text-sm"
              />
              <SubmitButton
                pendingText="Denying…"
                className="w-full rounded-splash-sm bg-racecar-red px-4 py-2 text-sm font-semibold text-white hover:opacity-90"
              >
                Deny order
              </SubmitButton>
            </ActionForm>
          )}
        </div>
        )}
      </div>
    </div>
  );
}
