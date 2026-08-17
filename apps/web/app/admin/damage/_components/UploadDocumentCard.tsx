// UploadDocumentCard — client island on /admin/damage/[id]. Briefs 5d + 20 + 37.
//
// Brief 37: bypasses the apps/web server action entirely. The form posts
// multipart directly to damage-worker's POST /manage/api/claim/{id}/document
// (relative URL — works in prod via CF same-zone routing, in dev via the
// /manage/api/:path* rewrite in next.config.mjs when
// NEXT_PUBLIC_DAMAGE_WORKER_URL is set). The worker responds with a 303
// redirect back to /admin/damage/{claimId} (with ?upload_error=... on
// validation failure) and the browser performs a top-level navigation,
// re-SSRing the detail page with the new photo present. This mirrors the
// legacy info-signup-worker upload path (legacy/damagemanager.js:2446 ->
// 2620 303 redirect) which "just worked" on iPhone Safari while the
// previous server-action path threw the digest 924441341@e394 white-page
// (Brief 36 Part B). Removing Next 15's server-action runtime from the
// multipart pipeline is the fix; the form is otherwise unchanged.
//
// Brief 20 — kept the client component for doc_type / pay_to_type-driven
// `required` attrs:
//   - amount: required when doc_type === "Quote"
//   - pay_to_type: required when doc_type === "Quote"
//   - vendor: required when doc_type === "Quote" && pay_to_type === "vendor"
//   - vendor_address: required when doc_type === "Quote" && pay_to_type === "vendor"
//
// Receipt rows stay loose — same fields are optional there. The worker
// enforces the same rules (apps/damage-worker/src/index.ts
// handleDocumentUpload); this client-side gating is a UX layer.
//
// id="upload-document" on the card root is the anchor target for both the
// "no quotes uploaded yet" hint card on the transition section (Brief 20
// Bug 4 fix) and the "Add Document" anchor button at the top of the page
// (Brief 37 Phase 3).

"use client";

import { useState } from "react";

const labelCls =
  "text-xs font-semibold uppercase tracking-wider text-splash-navy/70";
const inputCls =
  "w-full rounded-splash-sm border border-gray-light bg-white px-3 py-2 text-sm text-splash-navy placeholder:text-splash-navy/40 focus:border-splash-blue focus:outline-none";

type DocType = "" | "Quote" | "Receipt";
type PayToType = "" | "customer" | "vendor";

export function UploadDocumentCard({
  claimId,
  filterQs = ""
}: {
  claimId: string;
  /**
   * The claims-list filter querystring currently on the detail page's URL
   * (already built + encoded by listFilterQuery in ../[id]/page.tsx; empty
   * when no filters are set).
   *
   * Because this form posts straight to the worker rather than through a
   * server action, the worker's 303 — not Next — decides where the browser
   * lands afterwards. Hanging the filters on the action URL is the only way
   * they can survive the round trip; the worker echoes back the keys in its
   * own allow-list (UPLOAD_RETURN_FILTER_KEYS in damage-worker/src/index.ts).
   * The worker ignores this querystring for routing — it dispatches on the
   * pathname only.
   */
  filterQs?: string;
}) {
  const [docType, setDocType] = useState<DocType>("");
  const [payToType, setPayToType] = useState<PayToType>("");

  const isQuote = docType === "Quote";
  const isVendorPayTo = isQuote && payToType === "vendor";

  // Relative URL — resolved against the page origin. In production / staging
  // both apps/web and damage-worker share splashcarwashes.info, so CF routes
  // the POST directly to the damage-worker. In dev the next.config.mjs
  // rewrite under /manage/api/:path* proxies to NEXT_PUBLIC_DAMAGE_WORKER_URL
  // when set.
  const action =
    `/manage/api/claim/${encodeURIComponent(claimId)}/document` +
    (filterQs ? `?${filterQs}` : "");

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
      <form
        action={action}
        method="POST"
        encType="multipart/form-data"
        className="grid grid-cols-1 gap-3 md:grid-cols-2"
      >
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
      </form>
    </div>
  );
}
