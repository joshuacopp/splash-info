"use client";

import type { FormMetaState } from "./reducer";
import FormQrButton from "../../_components/FormQrButton";

type SaveState = "idle" | "saving" | "saved" | "error";
type PublishState = "idle" | "publishing" | "done" | "error";

interface Props {
  formId: string;
  formMeta: FormMetaState;
  status: "draft" | "published" | "archived";
  currentVersionNumber: number | null;
  dirty: boolean;
  saving: SaveState;
  publishing: PublishState;
  errorMsg: string | null;
  onSaveDraft: () => void;
  onPublish: () => void;
  onTitleChange: (title: string) => void;
}

export default function TopBar({
  formId,
  formMeta,
  status,
  currentVersionNumber,
  dirty,
  saving,
  publishing,
  errorMsg,
  onSaveDraft,
  onPublish,
  onTitleChange
}: Props) {
  const saveLabel =
    saving === "saving"
      ? "Saving…"
      : saving === "saved"
        ? "Saved ✓"
        : saving === "error"
          ? "Save failed"
          : dirty
            ? "Save Draft"
            : "Saved";

  const publishLabel =
    publishing === "publishing"
      ? "Publishing…"
      : publishing === "done"
        ? "Published ✓"
        : publishing === "error"
          ? "Publish failed"
          : "Publish";

  return (
    // Sticky below lg so Save / Publish stay in reach while scrolling a long
    // form on a phone; static on desktop, as before.
    <header className="sticky top-0 z-30 -mx-4 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-gray-light bg-white px-4 py-2 lg:static lg:mx-0 lg:bg-transparent lg:px-0 lg:pb-3 lg:pt-0">
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
        <input
          type="text"
          value={formMeta.title}
          onChange={(e) => onTitleChange(e.currentTarget.value)}
          placeholder="Untitled form"
          className="min-w-0 basis-full rounded-splash-sm border border-transparent bg-transparent px-2 py-1 text-base sm:basis-auto sm:flex-1 font-bold text-splash-navy focus:border-gray-light focus:bg-white sm:min-w-[240px] sm:text-lg"
        />
        <code className="hidden font-mono text-xs text-splash-navy/60 sm:inline">
          /forms/{formMeta.slug}
        </code>
        <StatusBadge status={status} versionNumber={currentVersionNumber} />
        {dirty && (
          <span className="text-xs font-semibold text-amber-700">
            Unsaved changes
          </span>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2">
        {errorMsg && (
          <span
            role="alert"
            className="rounded-splash-sm border border-racecar-red bg-racecar-red/10 px-2 py-1 text-xs text-racecar-red"
          >
            {errorMsg}
          </span>
        )}
        {status === "published" && (
          <FormQrButton
            formId={formId}
            slug={formMeta.slug}
            title={formMeta.title}
            audience={formMeta.audience}
            size="md"
          />
        )}
        <button
          type="button"
          onClick={onSaveDraft}
          disabled={saving === "saving" || (!dirty && saving !== "error")}
          className="inline-flex items-center rounded-splash-sm border border-splash-blue bg-white px-4 py-1.5 text-sm font-bold text-splash-blue hover:bg-splash-blue/5 disabled:opacity-50"
        >
          {saveLabel}
        </button>
        <button
          type="button"
          onClick={onPublish}
          disabled={publishing === "publishing"}
          className="inline-flex items-center rounded-splash-sm bg-splash-blue px-4 py-1.5 text-sm font-bold text-white shadow-splash-btn hover:bg-splash-blue-dark disabled:opacity-50"
        >
          {publishLabel}
        </button>
      </div>
    </header>
  );
}

function StatusBadge({
  status,
  versionNumber
}: {
  status: "draft" | "published" | "archived";
  versionNumber: number | null;
}) {
  const cls =
    status === "published"
      ? "bg-splash-success/15 text-splash-success"
      : status === "draft"
        ? "bg-amber-100 text-amber-800"
        : "bg-gray-light text-splash-navy/70";
  const label =
    status === "published" && versionNumber != null
      ? `Published v${versionNumber}`
      : status;
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-bold ${cls}`}
    >
      {label}
    </span>
  );
}
