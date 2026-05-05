// DocumentEditDetails — client island wrapping the per-doc Edit affordance
// on /admin/damage/[id]. Briefs 5d + 20.
//
// Brief 20 fixes two bugs on the per-tile Edit reveal:
//   - Bug 5/6: Quote rows make amount + pay_to_type required; Quote+vendor
//     pay_to_type makes vendor + vendor_address required. Mirrors the
//     UploadDocumentCard policy.
//   - Bug 8: the surrounding <details> closes after a successful save. The
//     v1 implementation relied on ActionForm's React-key remount trick, but
//     that only resets uncontrolled inputs *inside* the form — the parent
//     <details open> state persisted through a save, leaving an empty edit
//     panel hanging open. We now own the details `open` state in this
//     client component and flip it to false via ActionForm's onResult
//     callback (Brief 20 addition to ActionForm).
//
// Receipt rows: pay_to_type/vendor/vendor_address are not rendered (mirrors
// the existing edit form). Amount stays optional on Receipts.

"use client";

import { useState } from "react";
import { ActionForm } from "../../_components/ActionForm";
import { editDocumentAction } from "../[id]/actions";
import type { ClaimPhotoRow, PayToType } from "@splash/types/claims";

const labelCls =
  "text-[10px] font-semibold uppercase tracking-wider text-splash-navy/70";
const inputCls =
  "w-full rounded-splash-sm border border-gray-light bg-white px-2 py-1 text-xs text-splash-navy placeholder:text-splash-navy/40 focus:border-splash-blue focus:outline-none";

type PayToValue = "" | PayToType;

interface Props {
  claimId: string;
  photo: ClaimPhotoRow;
}

export function DocumentEditDetails({ claimId, photo }: Props) {
  const [open, setOpen] = useState(false);
  const isQuote = photo.photo_type === "Quote";

  const initialPayTo: PayToValue = (photo.pay_to_type ?? "") as PayToValue;
  const [payToType, setPayToType] = useState<PayToValue>(initialPayTo);
  const isVendorPayTo = isQuote && payToType === "vendor";

  return (
    <details
      className="flex-1"
      open={open}
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
    >
      <summary className="cursor-pointer list-none rounded-splash-sm border border-gray-light bg-sudsy-blue-soft/40 px-2 py-1 text-center text-xs font-semibold text-splash-navy hover:bg-sudsy-blue-soft">
        Edit
      </summary>
      <div className="mt-2 rounded-splash-sm border border-gray-light bg-white p-3">
        <ActionForm
          action={editDocumentAction}
          className="flex flex-col gap-2"
          onResult={(result) => {
            // Brief 20 Bug 8 — close the <details> only on a clean save.
            // Errors keep the panel open so the operator can fix and retry.
            if (result.ok) setOpen(false);
          }}
        >
          <input type="hidden" name="claim_id" value={claimId} />
          <input type="hidden" name="doc_id" value={String(photo.id)} />

          <label className="flex flex-col gap-0.5">
            <span className={labelCls}>
              Vendor{isVendorPayTo ? "" : isQuote ? " (optional)" : ""}
            </span>
            <input
              type="text"
              name="vendor"
              maxLength={1000}
              required={isVendorPayTo}
              defaultValue={photo.vendor ?? ""}
              className={inputCls}
            />
          </label>

          <label className="flex flex-col gap-0.5">
            <span className={labelCls}>
              Amount ($){isQuote ? "" : " (optional)"}
            </span>
            <input
              type="number"
              name="amount"
              step="0.01"
              min="0"
              required={isQuote}
              defaultValue={
                photo.amount !== null && photo.amount !== undefined
                  ? String(photo.amount)
                  : ""
              }
              className={inputCls}
            />
          </label>

          {isQuote ? (
            <>
              <label className="flex flex-col gap-0.5">
                <span className={labelCls}>Pay to</span>
                <select
                  name="pay_to_type"
                  value={payToType}
                  onChange={(e) => setPayToType(e.target.value as PayToValue)}
                  required
                  className={inputCls}
                >
                  <option value="">Select…</option>
                  <option value="customer">Customer</option>
                  <option value="vendor">Vendor</option>
                </select>
              </label>
              <label className="flex flex-col gap-0.5">
                <span className={labelCls}>
                  Vendor address{isVendorPayTo ? "" : " (optional)"}
                </span>
                <input
                  type="text"
                  name="vendor_address"
                  maxLength={1000}
                  required={isVendorPayTo}
                  defaultValue={photo.vendor_address ?? ""}
                  className={inputCls}
                />
              </label>
            </>
          ) : null}

          <label className="flex flex-col gap-0.5">
            <span className={labelCls}>Notes</span>
            <textarea
              name="notes"
              maxLength={5000}
              rows={2}
              defaultValue={photo.notes ?? ""}
              className={inputCls}
            />
          </label>

          <div className="flex items-center gap-2">
            <button
              type="submit"
              className="rounded-splash-sm bg-splash-blue px-3 py-1 text-xs font-bold text-white shadow-splash-btn transition-colors hover:bg-splash-blue-dark"
            >
              Save changes
            </button>
            {/* Cancel = close the details without writing. */}
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="text-xs font-semibold text-splash-navy/70 hover:text-splash-navy"
            >
              Cancel
            </button>
          </div>
        </ActionForm>
      </div>
    </details>
  );
}
