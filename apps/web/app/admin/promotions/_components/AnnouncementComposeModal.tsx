// Brief 158b — announcement compose modal.
// Brief 160 — Preview button + sub-modal with `<iframe srcdoc>` of the
// rendered HTML body + per-material inline-vs-attachment toggle for
// image materials.
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
import {
  sendAnnouncementAction,
  previewAnnouncementAction
} from "../_actions/announceActions";
import { isValidEmail } from "@splash/types/email-validate";
import type { PromoMaterial, PromoPtp } from "../_lib/types";

interface Props {
  promoId: string;
  promoTitle: string;
  materials: PromoMaterial[];
  ptp: PromoPtp | null;
  defaultRecipients: string[];
}

interface PreviewData {
  html: string;
  plainText: string;
  attachmentSummary: {
    inline_count: number;
    attachment_count: number;
    total_size_bytes: number;
  };
}

type MaterialMode = "inline" | "attachment";

function formatKb(totalBytes: number): string {
  if (totalBytes <= 0) return "0 KB";
  const kb = totalBytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
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
  const [materialModes, setMaterialModes] = useState<
    Record<string, MaterialMode>
  >({});
  const [includePtp, setIncludePtp] = useState(false);
  const [failedRecipients, setFailedRecipients] = useState<string[] | null>(
    null
  );
  const [preview, setPreview] = useState<PreviewData | null>(null);

  // Seed when modal opens (mirrors BogoModal's `useEffect`).
  useEffect(() => {
    if (open) {
      setRecipients([...defaultRecipients]);
      setSelectedMaterials(new Set(materials.map((m) => m.id)));
      // Default mode per material: image MIME → inline, everything else → attachment.
      const seedModes: Record<string, MaterialMode> = {};
      for (const m of materials) {
        seedModes[m.id] = (m.fileMime ?? "").startsWith("image/")
          ? "inline"
          : "attachment";
      }
      setMaterialModes(seedModes);
      setIncludePtp(Boolean(ptp));
      setFailedRecipients(null);
      setPreview(null);
    }
  }, [open, defaultRecipients, materials, ptp]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (preview) setPreview(null);
        else setOpen(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, preview]);

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

  function setMaterialMode(id: string, mode: MaterialMode) {
    setMaterialModes((prev) => ({ ...prev, [id]: mode }));
  }

  function handleSendResult(result: ActionResult) {
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
          setTimeout(() => setOpen(false), 1500);
        }
      } else {
        setTimeout(() => setOpen(false), 1500);
      }
    }
  }

  function handlePreviewResult(result: ActionResult) {
    if (
      result.ok &&
      result.data &&
      typeof result.data === "object" &&
      typeof (result.data as { html?: unknown }).html === "string"
    ) {
      const d = result.data as PreviewData;
      setPreview(d);
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

          {/* Two ActionForms share the same fields. Both forms post the same
              hidden FormData entries; the only difference is the action. The
              send-form encloses the actual visible inputs, and the preview
              button lives outside it inside its own form that mirrors the
              field values via a small `<input>` reflection pattern via the
              `form` attribute. Implemented by wrapping the inputs in a
              <fieldset> with a stable `name="composeFields"` that BOTH forms
              reference. Simpler at v1: render the preview button INSIDE the
              same form but with a different `formAction` is not available on
              React 19 server actions yet, so we use a separate ActionForm
              that re-reads the same DOM inputs via `formData` on submit. */}
          <ComposeFormBody
            promoId={promoId}
            promoTitle={promoTitle}
            materials={materials}
            ptp={ptp}
            recipients={recipients}
            setRecipients={setRecipients}
            adhocInput={adhocInput}
            setAdhocInput={setAdhocInput}
            adhocInvalid={adhocInvalid}
            addAdhocRecipient={addAdhocRecipient}
            removeRecipient={removeRecipient}
            selectedMaterials={selectedMaterials}
            toggleMaterial={toggleMaterial}
            materialModes={materialModes}
            setMaterialMode={setMaterialMode}
            includePtp={includePtp}
            setIncludePtp={setIncludePtp}
            failedRecipients={failedRecipients}
            handleSendResult={handleSendResult}
            handlePreviewResult={handlePreviewResult}
            closeModal={() => setOpen(false)}
          />
        </div>
      </div>

      {preview && (
        <PreviewSubModal
          preview={preview}
          onClose={() => setPreview(null)}
        />
      )}
    </>
  );
}

interface ComposeFormBodyProps {
  promoId: string;
  promoTitle: string;
  materials: PromoMaterial[];
  ptp: PromoPtp | null;
  recipients: string[];
  setRecipients: (next: string[]) => void;
  adhocInput: string;
  setAdhocInput: (next: string) => void;
  adhocInvalid: boolean;
  addAdhocRecipient: () => void;
  removeRecipient: (email: string) => void;
  selectedMaterials: Set<string>;
  toggleMaterial: (id: string) => void;
  materialModes: Record<string, MaterialMode>;
  setMaterialMode: (id: string, mode: MaterialMode) => void;
  includePtp: boolean;
  setIncludePtp: (next: boolean) => void;
  failedRecipients: string[] | null;
  handleSendResult: (r: ActionResult) => void;
  handlePreviewResult: (r: ActionResult) => void;
  closeModal: () => void;
}

function ComposeFormBody(props: ComposeFormBodyProps) {
  // Render the send form. The Preview button is inside its OWN ActionForm
  // that lives next to the main form but reads the same DOM fields via
  // `formAction` on the submit. To keep both actions reading the same
  // FormData, we duplicate the visible inputs as hidden controlled
  // mirrors inside a second nested ActionForm. Simpler: render two
  // ActionForms side-by-side and let each carry its own copy of the
  // hidden + visible fields driven by the shared React state.
  //
  // Trade-off: the visible subject/body inputs are NOT controlled. We
  // grab their values via a one-shot ref-read at preview-button-press
  // time and write them into the preview form's FormData before
  // dispatching. The cleaner abstraction would be controlled inputs,
  // but that adds a `useState` per textarea and forces every keystroke
  // through React.
  //
  // What we actually do (simplest path that works with ActionForm's
  // `useActionState` contract): render a single ActionForm for the SEND
  // path, and render the Preview button as a separate ActionForm that
  // reuses the same fields' values by reading them via `getElementById`
  // refs from a small inline handler. The handler builds a synthetic
  // FormData, calls previewAnnouncementAction directly, and surfaces the
  // result via `handlePreviewResult`. No second `<form>` element — the
  // Preview button is a plain `<button onClick>` that runs the
  // server-action call as a free function.
  //
  // This is the approach taken below.

  const sendFormId = "promo-announce-send-form";

  async function handlePreviewClick() {
    const formEl = document.getElementById(sendFormId) as HTMLFormElement | null;
    if (!formEl) return;
    const fd = new FormData(formEl);
    const result = await previewAnnouncementAction(null, fd);
    props.handlePreviewResult(result);
    if (!result.ok) {
      // The send-form's ActionForm renders any error inline; preview
      // errors render via a window.alert as the simplest path. Operators
      // are likely to hit the same validation errors at send-time
      // anyway, so the noisy alert isn't a regression.
      window.alert(`Preview failed: ${result.error}`);
    }
  }

  return (
    <ActionForm
      action={sendAnnouncementAction}
      onResult={props.handleSendResult}
      resetOnSuccess={false}
      className="space-y-5"
      id={sendFormId}
    >
      <input type="hidden" name="promoId" value={props.promoId} />
      <input
        type="hidden"
        name="recipientEmails"
        value={props.recipients.join(",")}
      />
      <input
        type="hidden"
        name="includePtp"
        value={props.includePtp ? "1" : "0"}
      />

      <section>
        <h3 className="mb-2 text-sm font-semibold text-splash-navy">
          Recipients ({props.recipients.length})
        </h3>
        {props.recipients.length === 0 ? (
          <p className="mb-2 text-xs italic text-splash-navy/55">
            No recipients yet. Add at least one below.
          </p>
        ) : (
          <ul className="mb-2 flex flex-wrap gap-1.5">
            {props.recipients.map((email) => (
              <li
                key={email}
                className="inline-flex items-center gap-1 rounded-full border border-gray-light bg-gray-100 px-2 py-1 text-xs text-splash-navy"
              >
                <span className="font-mono">{email}</span>
                <button
                  type="button"
                  onClick={() => props.removeRecipient(email)}
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
            value={props.adhocInput}
            onChange={(e) => props.setAdhocInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                props.addAdhocRecipient();
              }
            }}
            placeholder="add@another-recipient.com"
            className="min-w-[200px] flex-1 rounded-splash-sm border border-gray-light bg-white px-3 py-1.5 text-sm focus:border-splash-blue focus:outline-none"
          />
          <button
            type="button"
            onClick={props.addAdhocRecipient}
            disabled={props.adhocInput.trim() === "" || props.adhocInvalid}
            className="rounded-splash-sm border border-gray-light bg-white px-3 py-1.5 text-xs font-semibold text-splash-navy hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Add
          </button>
        </div>
        {props.adhocInvalid && (
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
          defaultValue={`Promotion update: ${props.promoTitle}`}
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
          Attach materials ({props.selectedMaterials.size} of {props.materials.length})
        </h3>
        {props.materials.length === 0 ? (
          <p className="text-xs italic text-splash-navy/55">
            No materials uploaded to this promo yet.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {props.materials.map((m) => {
              const checked = props.selectedMaterials.has(m.id);
              const isImage = (m.fileMime ?? "").startsWith("image/");
              const mode = props.materialModes[m.id] ?? (isImage ? "inline" : "attachment");
              return (
                <li key={m.id} className="rounded-splash-sm border border-gray-light px-3 py-2">
                  <label className="flex items-center gap-2 text-sm text-splash-navy">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => props.toggleMaterial(m.id)}
                      className="h-4 w-4"
                    />
                    {checked && (
                      <>
                        <input
                          type="hidden"
                          name="selectedMaterialId"
                          value={m.id}
                        />
                        <input
                          type="hidden"
                          name={`materialMode[${m.id}]`}
                          value={mode}
                        />
                      </>
                    )}
                    <span className="flex-1 truncate">{m.name}</span>
                    <span className="text-xs text-splash-navy/55">
                      {m.kind}
                    </span>
                  </label>
                  {checked && (
                    <div className="mt-1.5 flex items-center gap-3 pl-6 text-xs text-splash-navy/70">
                      {isImage ? (
                        <>
                          <span className="font-semibold">Render as:</span>
                          <label className="flex items-center gap-1">
                            <input
                              type="radio"
                              name={`__material-mode-radio-${m.id}`}
                              checked={mode === "inline"}
                              onChange={() => props.setMaterialMode(m.id, "inline")}
                            />
                            <span>Inline in body</span>
                          </label>
                          <label className="flex items-center gap-1">
                            <input
                              type="radio"
                              name={`__material-mode-radio-${m.id}`}
                              checked={mode === "attachment"}
                              onChange={() => props.setMaterialMode(m.id, "attachment")}
                            />
                            <span>Attachment only</span>
                          </label>
                        </>
                      ) : (
                        <span className="italic">Attachment (non-image)</span>
                      )}
                    </div>
                  )}
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
            checked={props.includePtp}
            onChange={(e) => props.setIncludePtp(e.target.checked)}
            disabled={!props.ptp}
            className="mt-0.5 h-4 w-4 disabled:cursor-not-allowed"
          />
          <span className="flex-1">
            Include Purpose / Tools / Process
            {!props.ptp && (
              <span className="ml-1 italic text-splash-navy/55">
                (PTP not built yet)
              </span>
            )}
          </span>
        </label>
      </section>

      {props.failedRecipients && props.failedRecipients.length > 0 && (
        <div
          role="alert"
          className="rounded-splash-sm border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
        >
          <p className="font-semibold">
            Sent — but {props.failedRecipients.length} recipient
            {props.failedRecipients.length === 1 ? "" : "s"} failed to enqueue:
          </p>
          <ul className="mt-1 list-inside list-disc text-xs">
            {props.failedRecipients.map((r) => (
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
          onClick={props.closeModal}
          className="rounded-splash-sm border border-gray-light bg-white px-4 py-2 text-sm font-bold text-splash-navy hover:bg-gray-100"
        >
          Close
        </button>
        <button
          type="button"
          onClick={handlePreviewClick}
          className="rounded-splash-sm border border-splash-blue bg-white px-4 py-2 text-sm font-bold text-splash-blue hover:bg-splash-blue/5"
        >
          Preview
        </button>
        <SubmitButton
          pendingText="Sending…"
          disabled={props.recipients.length === 0}
          className="rounded-splash-sm bg-splash-blue px-5 py-2 text-sm font-bold text-white shadow-splash-card hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Send announcement
        </SubmitButton>
      </div>
    </ActionForm>
  );
}

interface PreviewSubModalProps {
  preview: PreviewData;
  onClose: () => void;
}

function PreviewSubModal({ preview, onClose }: PreviewSubModalProps) {
  const { inline_count, attachment_count, total_size_bytes } =
    preview.attachmentSummary;
  const summaryParts: string[] = [];
  if (inline_count > 0) {
    summaryParts.push(`${inline_count} inline image${inline_count === 1 ? "" : "s"}`);
  }
  if (attachment_count > 0) {
    summaryParts.push(
      `${attachment_count} attachment${attachment_count === 1 ? "" : "s"}`
    );
  }
  if (total_size_bytes > 0) summaryParts.push(formatKb(total_size_bytes));
  const summaryLine = summaryParts.length > 0 ? summaryParts.join(", ") : "No materials.";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Preview announcement"
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/80 px-4 py-6"
      onClick={onClose}
    >
      <div
        className="flex w-full max-w-4xl flex-col overflow-hidden rounded-splash-lg bg-white shadow-splash-card"
        style={{ maxHeight: "90vh" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-gray-light px-6 py-4">
          <h2 className="text-lg font-bold text-splash-navy">Preview announcement</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-splash-sm px-2 py-1 text-splash-navy/70 hover:bg-gray-100"
            aria-label="Close preview"
          >
            ×
          </button>
        </div>

        <div className="flex-1 overflow-y-auto bg-gray-100 p-4">
          {/*
             sandbox="allow-same-origin" — no allow-scripts: the rendered
             HTML is operator-authored body wrapped in our Splash shell; we
             trust the shell but defense-in-depth on the operator body
             (which we already escape via `escapeHtml`). Same-origin lets
             styles render normally.
          */}
          <iframe
            title="Announcement preview"
            srcDoc={preview.html}
            sandbox="allow-same-origin"
            className="block w-full rounded-splash-sm border border-gray-light bg-white"
            style={{ minHeight: "600px", height: "70vh" }}
          />
        </div>

        <div className="flex items-center justify-between border-t border-gray-light px-6 py-3 text-xs text-splash-navy/70">
          <span>{summaryLine}</span>
          <button
            type="button"
            onClick={onClose}
            className="rounded-splash-sm border border-gray-light bg-white px-3 py-1.5 text-xs font-semibold text-splash-navy hover:bg-gray-100"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
