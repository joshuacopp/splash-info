// Brief 158b — material upload modal.
//
// Overlay + centered card with a name input, kind select, file input.
// The form posts multipart/form-data through the uploadMaterialAction.
// Client-side size check matches the worker's 50 MB ceiling so operators
// don't wait for a slow upload only to be rejected.

"use client";

import { useEffect, useRef, useState } from "react";
import { ActionForm } from "../../_components/ActionForm";
import type { ActionResult } from "../../_components/ActionForm";
import { SubmitButton } from "../../_components/SubmitButton";
import { uploadMaterialAction } from "../_actions/materialActions";

const MATERIAL_KINDS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "image", label: "Image" },
  { value: "video", label: "Video" },
  { value: "copy_messaging", label: "Copy / messaging" },
  { value: "signage", label: "Signage" },
  { value: "email_asset", label: "Email asset" },
  { value: "other", label: "Other" }
];

const FILE_SIZE_MAX_BYTES = 50 * 1024 * 1024;

interface Props {
  promoId: string;
  triggerLabel?: string;
}

export default function MaterialUploadModal({
  promoId,
  triggerLabel = "+ Add material"
}: Props) {
  const [open, setOpen] = useState(false);
  const [clientError, setClientError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  function handleResult(result: ActionResult) {
    if (result.ok) {
      setOpen(false);
      setClientError(null);
    }
  }

  function onFileChange() {
    const file = fileInputRef.current?.files?.[0];
    if (!file) {
      setClientError(null);
      return;
    }
    if (file.size > FILE_SIZE_MAX_BYTES) {
      setClientError(
        `File is too large (${(file.size / (1024 * 1024)).toFixed(1)} MB; max 50 MB).`
      );
    } else {
      setClientError(null);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-splash-sm border border-splash-blue bg-white px-3 py-1.5 text-xs font-bold text-splash-blue hover:bg-splash-blue/5"
      >
        {triggerLabel}
      </button>
    );
  }

  return (
    <>
      <button
        type="button"
        className="rounded-splash-sm border border-splash-blue bg-splash-blue/5 px-3 py-1.5 text-xs font-bold text-splash-blue"
      >
        {triggerLabel}
      </button>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Upload material"
        className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/70 px-4 py-6"
        onClick={() => setOpen(false)}
      >
        <div
          className="w-full max-w-lg rounded-splash-lg bg-white p-6 shadow-splash-card"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-bold text-splash-navy">
              Upload material
            </h2>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-splash-sm px-2 py-1 text-splash-navy/70 hover:bg-gray-100"
              aria-label="Close"
            >
              ×
            </button>
          </div>
          <ActionForm
            action={uploadMaterialAction}
            onResult={handleResult}
            resetOnSuccess={false}
            encType="multipart/form-data"
            className="space-y-4"
          >
            <input type="hidden" name="promoId" value={promoId} />
            <div>
              <label className="mb-1 block text-sm font-semibold text-splash-navy">
                Material name <span className="text-splash-deny">*</span>
              </label>
              <input
                type="text"
                name="name"
                required
                maxLength={500}
                className="w-full rounded-splash-sm border border-gray-light bg-white px-3 py-2 text-sm focus:border-splash-blue focus:outline-none"
                placeholder="e.g. Family Plan window cling final"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-semibold text-splash-navy">
                Kind <span className="text-splash-deny">*</span>
              </label>
              <select
                name="kind"
                required
                defaultValue="image"
                className="w-full rounded-splash-sm border border-gray-light bg-white px-3 py-2 text-sm focus:border-splash-blue focus:outline-none"
              >
                {MATERIAL_KINDS.map((k) => (
                  <option key={k.value} value={k.value}>
                    {k.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-sm font-semibold text-splash-navy">
                File <span className="text-splash-deny">*</span>
              </label>
              <input
                ref={fileInputRef}
                type="file"
                name="file"
                required
                onChange={onFileChange}
                className="w-full text-sm"
              />
              <p className="mt-1 text-xs text-splash-navy/55">
                Max 50 MB. Images, videos, copy docs, signage, email assets.
              </p>
              {clientError && (
                <p
                  role="alert"
                  className="mt-1 text-xs font-semibold text-splash-deny"
                >
                  {clientError}
                </p>
              )}
            </div>
            <div className="flex items-center justify-end gap-3 border-t border-gray-light pt-3">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-splash-sm border border-gray-light bg-white px-4 py-2 text-sm font-bold text-splash-navy hover:bg-gray-100"
              >
                Cancel
              </button>
              <SubmitButton
                pendingText="Uploading…"
                disabled={Boolean(clientError)}
                className="rounded-splash-sm bg-splash-blue px-4 py-2 text-sm font-bold text-white shadow-splash-card hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Upload
              </SubmitButton>
            </div>
          </ActionForm>
        </div>
      </div>
    </>
  );
}
