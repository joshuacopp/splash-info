// Brief 158b — announcement compose modal.
//
// Largest single modal in 158b. Pre-populated recipients are passed in as
// a prop (resolved server-side in the parent via `_lib/locations.ts`).
// Operators can remove pre-filled recipients via × buttons and add ad-hoc
// ones via the input below. Materials checklist defaults all-checked.
// Include-PTP defaults to true when PTP exists.

"use client";

import { useEffect, useState } from "react";
import { ActionForm } from "../../_components/ActionForm";
import type { ActionResult } from "../../_components/ActionForm";
import { SubmitButton } from "../../_components/SubmitButton";
import { sendAnnouncementAction } from "../_actions/announceActions";
import { isValidEmail } from "@splash/types/email-validate";
import type { PromoMaterial, PromoPtp } from "../_lib/types";

interface Props {
  promoId: string;
  promoTitle: string;
  materials: PromoMaterial[];
  ptp: PromoPtp | null;
  defaultRecipients: string[];
}

export default function AnnouncementComposeModal({
  promoId,
  promoTitle,
  materials,
  ptp,
  defaultRecipients
}: Props) {
  const [open, setOpen] = useState(false);
  const [recipients, setRecipients] = useState<string[]>([]);
  const [adhocInput, setAdhocInput] = useState("");
  const [selectedMaterials, setSelectedMaterials] = useState<Set<string>>(
    new Set()
  );
  const [includePtp, setIncludePtp] = useState(false);
  const [failedRecipients, setFailedRecipients] = useState<string[] | null>(
    null
  );

  // Seed when modal opens (mirrors BogoModal's `useEffect`).
  useEffect(() => {
    if (open) {
      setRecipients([...defaultRecipients]);
      setSelectedMaterials(new Set(materials.map((m) => m.id)));
      setIncludePtp(Boolean(ptp));
      setFailedRecipients(null);
    }
  }, [open, defaultRecipients, materials, ptp]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  function removeRecipient(email: string) {
    setRecipients((prev) => prev.filter((r) => r !== email));
  }

  function addAdhocRecipient() {
    const trimmed = adhocInput.trim();
    if (!trimmed) return;
    if (!isValidEmail(trimmed)) return;
    const lower = trimmed.toLowerCase();
    if (recipients.some((r) => r.toLowerCase() === lower)) {
      setAdhocInput("");
      return;
    }
    setRecipients((prev) => [...prev, trimmed]);
    setAdhocInput("");
  }

  function toggleMaterial(id: string) {
    setSelectedMaterials((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleResult(result: ActionResult) {
    if (result.ok) {
      if (
        result.data &&
        typeof result.data === "object" &&
        Array.isArray((result.data as { failedRecipients?: unknown }).failedRecipients)
      ) {
        const failed = (result.data as { failedRecipients: string[] })
          .failedRecipients;
        setFailedRecipients(failed);
        if (failed.length === 0) {
          // Clean send — close after a brief delay so the success banner is visible.
          setTimeout(() => setOpen(false), 1500);
        }
      } else {
        setTimeout(() => setOpen(false), 1500);
      }
    }
  }

  const adhocInvalid = adhocInput.trim() !== "" && !isValidEmail(adhocInput.trim());

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-splash-sm border border-splash-blue bg-white px-3 py-1.5 text-xs font-bold text-splash-blue hover:bg-splash-blue/5"
      >
        Compose announcement email
      </button>
    );
  }

  return (
    <>
      <button
        type="button"
        className="rounded-splash-sm border border-splash-blue bg-splash-blue/5 px-3 py-1.5 text-xs font-bold text-splash-blue"
      >
        Compose announcement email
      </button>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Compose announcement"
        className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/70 px-4 py-6"
        onClick={() => setOpen(false)}
      >
        <div
          className="w-full max-w-3xl overflow-y-auto rounded-splash-lg bg-white p-6 shadow-splash-card"
          style={{ maxHeight: "90vh" }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-bold text-splash-navy">
              Compose announcement
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
            action={sendAnnouncementAction}
            onResult={handleResult}
            resetOnSuccess={false}
            className="space-y-5"
          >
            <input type="hidden" name="promoId" value={promoId} />
            <input
              type="hidden"
              name="recipientEmails"
              value={recipients.join(",")}
            />
            <input
              type="hidden"
              name="includePtp"
              value={includePtp ? "1" : "0"}
            />

            <section>
              <h3 className="mb-2 text-sm font-semibold text-splash-navy">
                Recipients ({recipients.length})
              </h3>
              {recipients.length === 0 ? (
                <p className="mb-2 text-xs italic text-splash-navy/55">
                  No recipients yet. Add at least one below.
                </p>
              ) : (
                <ul className="mb-2 flex flex-wrap gap-1.5">
                  {recipients.map((email) => (
                    <li
                      key={email}
                      className="inline-flex items-center gap-1 rounded-full border border-gray-light bg-gray-100 px-2 py-1 text-xs text-splash-navy"
                    >
                      <span className="font-mono">{email}</span>
                      <button
                        type="button"
                        onClick={() => removeRecipient(email)}
                        className="ml-0.5 text-splash-navy/55 hover:text-splash-deny"
                        aria-label={`Remove ${email}`}
                      >
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="email"
                  value={adhocInput}
                  onChange={(e) => setAdhocInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addAdhocRecipient();
                    }
                  }}
                  placeholder="add@another-recipient.com"
                  className="min-w-[200px] flex-1 rounded-splash-sm border border-gray-light bg-white px-3 py-1.5 text-sm focus:border-splash-blue focus:outline-none"
                />
                <button
                  type="button"
                  onClick={addAdhocRecipient}
                  disabled={adhocInput.trim() === "" || adhocInvalid}
                  className="rounded-splash-sm border border-gray-light bg-white px-3 py-1.5 text-xs font-semibold text-splash-navy hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Add
                </button>
              </div>
              {adhocInvalid && (
                <p className="mt-1 text-xs text-splash-deny">
                  That doesn't look like a valid email address.
                </p>
              )}
            </section>

            <section>
              <label className="mb-1 block text-sm font-semibold text-splash-navy">
                Subject <span className="text-splash-deny">*</span>
              </label>
              <input
                type="text"
                name="subject"
                required
                maxLength={500}
                defaultValue={`Promotion update: ${promoTitle}`}
                className="w-full rounded-splash-sm border border-gray-light bg-white px-3 py-2 text-sm focus:border-splash-blue focus:outline-none"
              />
            </section>

            <section>
              <label className="mb-1 block text-sm font-semibold text-splash-navy">
                Body <span className="text-splash-deny">*</span>
              </label>
              <textarea
                name="bodyText"
                required
                rows={8}
                maxLength={50000}
                className="w-full rounded-splash-sm border border-gray-light bg-white px-3 py-2 text-sm focus:border-splash-blue focus:outline-none"
                placeholder="Operator-authored body. Plain text."
              />
            </section>

            <section>
              <h3 className="mb-2 text-sm font-semibold text-splash-navy">
                Attach materials ({selectedMaterials.size} of {materials.length})
              </h3>
              {materials.length === 0 ? (
                <p className="text-xs italic text-splash-navy/55">
                  No materials uploaded to this promo yet.
                </p>
              ) : (
                <ul className="space-y-1">
                  {materials.map((m) => {
                    const checked = selectedMaterials.has(m.id);
                    return (
                      <li key={m.id}>
                        <label className="flex items-center gap-2 text-sm text-splash-navy">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleMaterial(m.id)}
                            className="h-4 w-4"
                          />
                          {checked && (
                            <input
                              type="hidden"
                              name="selectedMaterialId"
                              value={m.id}
                            />
                          )}
                          <span className="flex-1 truncate">{m.name}</span>
                          <span className="text-xs text-splash-navy/55">
                            {m.kind}
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            <section>
              <label className="flex items-start gap-2 text-sm text-splash-navy">
                <input
                  type="checkbox"
                  checked={includePtp}
                  onChange={(e) => setIncludePtp(e.target.checked)}
                  disabled={!ptp}
                  className="mt-0.5 h-4 w-4 disabled:cursor-not-allowed"
                />
                <span className="flex-1">
                  Include Purpose / Tools / Process
                  {!ptp && (
                    <span className="ml-1 italic text-splash-navy/55">
                      (PTP not built yet)
                    </span>
                  )}
                </span>
              </label>
            </section>

            {failedRecipients && failedRecipients.length > 0 && (
              <div
                role="alert"
                className="rounded-splash-sm border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
              >
                <p className="font-semibold">
                  Sent — but {failedRecipients.length} recipient
                  {failedRecipients.length === 1 ? "" : "s"} failed to enqueue:
                </p>
                <ul className="mt-1 list-inside list-disc text-xs">
                  {failedRecipients.map((r) => (
                    <li key={r} className="font-mono">
                      {r}
                    </li>
                  ))}
                </ul>
                <p className="mt-1 text-xs">
                  Retry via the email queue admin (/admin/email-queue).
                </p>
              </div>
            )}

            <div className="flex items-center justify-end gap-3 border-t border-gray-light pt-3">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-splash-sm border border-gray-light bg-white px-4 py-2 text-sm font-bold text-splash-navy hover:bg-gray-100"
              >
                Close
              </button>
              <SubmitButton
                pendingText="Sending…"
                disabled={recipients.length === 0}
                className="rounded-splash-sm bg-splash-blue px-5 py-2 text-sm font-bold text-white shadow-splash-card hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Send announcement
              </SubmitButton>
            </div>
          </ActionForm>
        </div>
      </div>
    </>
  );
}
