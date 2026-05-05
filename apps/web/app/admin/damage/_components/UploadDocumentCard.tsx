// UploadDocumentCard — client island on /admin/damage/[id]. Briefs 5d + 20.
//
// Brief 20 — converted from a server component to a client component to
// drive doc_type / pay_to_type-conditional `required` attrs:
//   - amount: required when doc_type === "Quote"
//   - pay_to_type: required when doc_type === "Quote"
//   - vendor: required when doc_type === "Quote" && pay_to_type === "vendor"
//   - vendor_address: required when doc_type === "Quote" && pay_to_type === "vendor"
//
// Receipt rows stay loose — same fields are optional there.
//
// The worker enforces the same rules (apps/damage-worker/src/index.ts
// handleDocumentUpload) — this client-side gating is a UX layer; rejected
// uploads still surface inline via <ActionForm>'s error rendering.
//
// id="upload-document" on the card root is the anchor target for the
// "no quotes uploaded yet" hint card on the transition section (Brief 20
// Bug 4 fix).

"use client";

import { useState } from "react";
import { ActionForm } from "../../_components/ActionForm";
import { uploadDocumentAction } from "../[id]/actions";

const labelCls =
  "text-xs font-semibold uppercase tracking-wider text-splash-navy/70";
const inputCls =
  "w-full rounded-splash-sm border border-gray-light bg-white px-3 py-2 text-sm text-splash-navy placeholder:text-splash-navy/40 focus:border-splash-blue focus:outline-none";

type DocType = "" | "Quote" | "Receipt";
type PayToType = "" | "customer" | "vendor";

export function UploadDocumentCard({ claimId }: { claimId: string }) {
  const [docType, setDocType] = useState<DocType>("");
  const [payToType, setPayToType] = useState<PayToType>("");

  const isQuote = docType === "Quote";
  const isVendorPayTo = isQuote && payToType === "vendor";

  return (
    <div
      id="upload-document"
      className="mb-6 rounded-splash-lg border border-gray-light bg-white p-6 shadow-splash-card"
    >
      <h2 className="mb-4 text-lg font-bold text-splash-navy">Upload document</h2>
      <p className="mb-3 text-xs text-splash-navy/60">
        Attach a Quote or Receipt (PDF, JPG, PNG, or HEIC; up to 10 MB).
        Quote rows must include amount + pay-to so the check-request PDF can
        be generated; vendor pay-to additionally requires vendor name +
        vendor address. Receipt fields are optional.
      </p>
      <ActionForm
        action={uploadDocumentAction}
        encType="multipart/form-data"
        className="grid grid-cols-1 gap-3 md:grid-cols-2"
      >
        <input type="hidden" name="claim_id" value={claimId} />

        <label className="flex flex-col gap-1">
          <span className={labelCls}>Document type</span>
          <select
            name="doc_type"
            required
            value={docType}
            onChange={(e) => setDocType(e.target.value as DocType)}
            className={inputCls}
          >
            <option value="" disabled>
              Select type…
            </option>
            <option value="Quote">Quote</option>
            <option value="Receipt">Receipt</option>
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className={labelCls}>File</span>
          <input
            type="file"
            name="file"
            required
            accept="image/*,application/pdf"
            className={inputCls}
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className={labelCls}>
            Vendor{isVendorPayTo ? "" : " (optional)"}
          </span>
          <input
            type="text"
            name="vendor"
            maxLength={1000}
            required={isVendorPayTo}
            placeholder="Name of the shop, supplier, etc."
            className={inputCls}
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className={labelCls}>
            Amount ($){isQuote ? "" : " (optional)"}
          </span>
          <input
            type="number"
            name="amount"
            step="0.01"
            min="0"
            required={isQuote}
            placeholder="0.00"
            className={inputCls}
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className={labelCls}>
            Pay to{isQuote ? "" : " (optional)"}
          </span>
          <select
            name="pay_to_type"
            value={payToType}
            onChange={(e) => setPayToType(e.target.value as PayToType)}
            required={isQuote}
            className={inputCls}
          >
            <option value="">{isQuote ? "Select…" : "(unset)"}</option>
            <option value="customer">Customer</option>
            <option value="vendor">Vendor</option>
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className={labelCls}>
            Vendor address{isVendorPayTo ? "" : " (optional)"}
          </span>
          <input
            type="text"
            name="vendor_address"
            maxLength={1000}
            required={isVendorPayTo}
            placeholder="Required only when paying the vendor directly"
            className={inputCls}
          />
        </label>

        <label className="flex flex-col gap-1 md:col-span-2">
          <span className={labelCls}>Notes (optional)</span>
          <textarea
            name="notes"
            maxLength={5000}
            rows={2}
            className={inputCls}
          />
        </label>

        <div className="md:col-span-2">
          <button
            type="submit"
            className="inline-flex items-center gap-1.5 rounded-splash-sm bg-splash-blue px-5 py-2.5 text-sm font-bold text-white shadow-splash-btn transition-colors hover:bg-splash-blue-dark"
          >
            Upload document
          </button>
        </div>
      </ActionForm>
    </div>
  );
}
