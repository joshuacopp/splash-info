"use client";

// Create / edit / delete a directory part. super_admin only — PartsDirectory
// renders none of this unless the server component resolved `canEdit`, and the
// route handlers + the worker both re-check independently.
//
// WHY NOT @splash/ui's ModalShell. It exists and it is the right frame for
// what it was built for — the signup flow's four short confirmations: 420px,
// centre-aligned, inline-styled, no scroll handling. This form is nine fields
// plus a file picker and has to survive a phone in landscape, so it gets a
// local frame built from the same Tailwind tokens the directory page already
// uses (rounded-splash-lg / shadow-splash-card / border-gray-light /
// text-splash-navy). The delete confirmation below is a shape ModalShell WOULD
// have fitted, but pairing it with a hand-rolled edit frame would have meant
// two different-looking dialogs on one page.
//
// EQUIPMENT IS A LIST, AND IT IS OPTIONAL. `parent_equipment` used to be one
// machine per part, which forced an operator to create the same bearing once
// for the wrap, once for the top brush and once for the conveyor. It is now an
// array, so the field is a tag input (see EquipmentTagInput below) rather than
// a text box. Zero machines is a VALID submission — logging a part before you
// know where it fits is a real workflow, and the directory shows those rows
// under an "Unassigned" heading rather than hiding them.
//
// PHOTO IS A SEPARATE ROUND TRIP, ON PURPOSE. Picking a file uploads it
// immediately to ../api/photo and the form then carries only the returned
// `r2_key`. That keeps the part write itself pure JSON, which is what the
// worker's CSRF barrier depends on (see ../_lib/write-proxy.ts). The visible
// consequence is that a photo uploaded and then abandoned leaves an orphan in
// R2; the invisible one is that the form never has to hold megabytes of image
// in memory while the operator finishes typing.
//
// VALIDATION IS THE WORKER'S. Only the one genuinely required field is
// checked here, to spare an obvious round trip. Everything else — the http(s)
// vendor_url rule, the unit_cost coercion, the length caps, and the 409 on a
// part number the same VENDOR already uses — is answered upstream, and its
// `{ error }` message is routed back to the field it names.

import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent, ReactNode } from "react";
import { useRouter } from "next/navigation";
import { partPhotoUrl, type PartRow } from "../_lib/parts-shared";

const API_PARTS = "/admin/parts/directory/api/parts";
const API_PHOTO = "/admin/parts/directory/api/photo";

/** The nine writable columns, in the order the worker documents them. */
const FIELD_KEYS = [
  "parent_equipment",
  "part_name",
  "part_number",
  "vendor",
  "photo_r2_key",
  "unit_cost",
  "vendor_url",
  "location_codes",
  "notes"
] as const;
type FieldKey = (typeof FIELD_KEYS)[number];

type FieldErrors = Partial<Record<FieldKey, string>>;

const inputClass =
  "w-full rounded-splash-md border-2 border-gray-light bg-white px-3 py-2 text-sm text-splash-navy outline-none focus:border-splash-blue disabled:bg-splash-navy/5";
const labelClass =
  "mb-1 block text-xs font-bold uppercase tracking-[0.1em] text-splash-navy/70";
const errorClass = "mt-1 text-xs font-semibold text-racecar-red";

/* ============================================================
 * Shared error plumbing
 * ============================================================ */

/**
 * Pull `{ error }` off a failed response. Every one of our handlers answers
 * JSON — ../_lib/write-proxy.ts normalizes even a non-JSON upstream into that
 * shape — but a network-level HTML page could still land here, so parsing is
 * defensive.
 */
async function readError(resp: Response): Promise<string> {
  try {
    const body = (await resp.json()) as { error?: unknown };
    if (typeof body.error === "string" && body.error) return body.error;
  } catch {
    // Fall through to the status-only message.
  }
  return `That didn't go through (error ${resp.status}).`;
}

/**
 * The worker's 400 messages lead with the offending column name
 * ("vendor_url must be a valid http(s) URL"), so the message can be parked on
 * the field it is about instead of in a banner the operator has to map back to
 * an input themselves.
 */
function fieldFromMessage(message: string): FieldKey | null {
  const first = message.split(/[\s:]+/)[0] ?? "";
  return (FIELD_KEYS as readonly string[]).includes(first)
    ? (first as FieldKey)
    : null;
}

/** Sentence-case a worker message that starts with a snake_case column name. */
function humanize(message: string): string {
  const field = fieldFromMessage(message);
  if (!field) return message;
  const rest = message.slice(field.length).trim();
  const label = field.replace(/_/g, " ");
  return `${label.charAt(0).toUpperCase()}${label.slice(1)} ${rest}`.trim();
}

/* ============================================================
 * Modal frame
 * ============================================================ */

function Backdrop({
  children,
  onDismiss,
  labelledBy,
  busy
}: {
  children: ReactNode;
  onDismiss: () => void;
  labelledBy: string;
  /** While a write is in flight, Escape and backdrop clicks are inert — losing
   *  a half-saved form to a stray click is worse than an extra button press. */
  busy: boolean;
}) {
  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === "Escape" && !busy) onDismiss();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, onDismiss]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={labelledBy}
      // mousedown, not click: a selection drag that starts inside the card and
      // ends on the backdrop shouldn't throw the form away.
      onMouseDown={() => {
        if (!busy) onDismiss();
      }}
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-splash-navy/80 p-4 sm:p-8"
    >
      <div onMouseDown={(e) => e.stopPropagation()} className="w-full max-w-2xl">
        {children}
      </div>
    </div>
  );
}

/* ============================================================
 * Equipment tag input
 * ============================================================ */

/** Case-insensitive membership — "Top Brush" and "top brush" are one machine. */
function containsEquipment(list: string[], candidate: string): boolean {
  const needle = candidate.trim().toLowerCase();
  return list.some((v) => v.toLowerCase() === needle);
}

/**
 * Multi-value machine picker: chips for what's chosen, one text box for
 * adding more, and a <datalist> of the machines already in the directory so
 * "MacNeil RS701 Wrap" doesn't acquire a second spelling.
 *
 * NO NEW DEPENDENCY, deliberately — this is plain state plus a native
 * datalist. A combobox library would be a third of the bundle for a field
 * that is used a few times a week.
 *
 * COMMIT RULES:
 *   Enter      — commits the draft. preventDefault first, or the browser
 *                submits the whole form on the first machine name typed.
 *   comma      — handled in onChange rather than onKeyDown, so pasting
 *                "wrap, top brush, conveyor" splits into three chips too.
 *   Backspace  — on an EMPTY box only, removes the last chip. Guarded on
 *                empty so it never eats a chip mid-word.
 *   blur       — also commits. Typing a machine and going straight for Save
 *                must not silently discard it.
 *
 * Duplicates are rejected case-insensitively and silently: the draft clears,
 * the existing chip stays. An error for "you already picked that" would be
 * noise.
 *
 * The draft lives in the PARENT so submit can flush a half-typed value that
 * never blurred. That is the only reason this isn't fully self-contained.
 */
function EquipmentTagInput({
  value,
  draft,
  options,
  disabled,
  inputId,
  hintId,
  listId,
  onChange,
  onDraftChange
}: {
  value: string[];
  draft: string;
  /** Known machines, for the suggestion list. */
  options: string[];
  disabled: boolean;
  inputId: string;
  hintId: string;
  listId: string;
  onChange: (next: string[]) => void;
  onDraftChange: (next: string) => void;
}) {
  function commit(raw: string) {
    const next = raw.trim();
    if (!next) return;
    if (containsEquipment(value, next)) return;
    onChange([...value, next]);
  }

  function handleChange(raw: string) {
    if (!raw.includes(",")) {
      onDraftChange(raw);
      return;
    }
    // Everything before the last comma is committed; the tail stays in the box
    // so a trailing "top bru" isn't thrown away.
    const parts = raw.split(",");
    const tail = parts.pop() ?? "";
    const accepted = [...value];
    for (const piece of parts) {
      const trimmed = piece.trim();
      if (trimmed && !containsEquipment(accepted, trimmed)) {
        accepted.push(trimmed);
      }
    }
    if (accepted.length !== value.length) onChange(accepted);
    onDraftChange(tail);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      // Without this the form submits with one machine typed and none saved.
      e.preventDefault();
      commit(draft);
      onDraftChange("");
      return;
    }
    if (e.key === "Backspace" && draft === "" && value.length > 0) {
      e.preventDefault();
      onChange(value.slice(0, -1));
    }
  }

  // Don't suggest what's already a chip.
  const suggestions = options.filter((o) => !containsEquipment(value, o));

  return (
    <div>
      {value.length > 0 && (
        <ul
          aria-label="Selected machines"
          className="mb-2 flex flex-wrap gap-2"
        >
          {value.map((label) => (
            <li
              key={label.toLowerCase()}
              className="flex items-center gap-1.5 rounded-splash-sm border-2 border-gray-light bg-splash-navy/5 py-1 pl-3 pr-1 text-sm font-semibold text-splash-navy"
            >
              <span>{label}</span>
              <button
                type="button"
                disabled={disabled}
                onClick={() => onChange(value.filter((v) => v !== label))}
                aria-label={`Remove ${label}`}
                // Deliberately oversized for a gloved thumb on a shop floor.
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-splash-sm text-base leading-none text-splash-navy/60 hover:bg-racecar-red hover:text-white disabled:opacity-40"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      <input
        id={inputId}
        list={listId}
        value={draft}
        onChange={(e) => handleChange(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={() => {
          commit(draft);
          onDraftChange("");
        }}
        disabled={disabled}
        autoFocus
        autoComplete="off"
        aria-describedby={hintId}
        placeholder="e.g. Macneil RS701 Wrap"
        className={inputClass}
      />
      <datalist id={listId}>
        {suggestions.map((label) => (
          <option key={label} value={label} />
        ))}
      </datalist>
      <p id={hintId} className="mt-1 text-xs text-splash-navy/50">
        Pick from the list or type a new machine. Enter or a comma adds it;
        Backspace on an empty box removes the last one. A part used on several
        machines belongs on one row listing all of them. Leave it empty if you
        don&apos;t know yet.
      </p>
    </div>
  );
}

/* ============================================================
 * Editor
 * ============================================================ */

export interface PartEditorProps {
  /** null = create a new part; a row = edit that row. */
  part: PartRow | null;
  /** Known parent_equipment values — the flattened facet from the list call,
   *  offered as suggestions so machine names stay consistent instead of
   *  sprouting "MacNeil" and "macneil". */
  equipment: string[];
  onClose: () => void;
}

export function PartEditor({ part, equipment, onClose }: PartEditorProps) {
  const router = useRouter();
  const titleId = useId();
  const equipListId = useId();
  const equipHintId = useId();
  const fileInput = useRef<HTMLInputElement>(null);

  const [parentEquipment, setParentEquipment] = useState<string[]>(
    part?.parent_equipment ?? []
  );
  // The half-typed machine name. Lives here, not in the tag input, so submit
  // can flush it — see the note on EquipmentTagInput.
  const [equipDraft, setEquipDraft] = useState("");
  const [partName, setPartName] = useState(part?.part_name ?? "");
  const [partNumber, setPartNumber] = useState(part?.part_number ?? "");
  const [vendor, setVendor] = useState(part?.vendor ?? "");
  const [unitCost, setUnitCost] = useState(
    part?.unit_cost != null ? String(part.unit_cost) : ""
  );
  const [vendorUrl, setVendorUrl] = useState(part?.vendor_url ?? "");
  const [locationCodes, setLocationCodes] = useState(
    (part?.location_codes ?? []).join(", ")
  );
  const [notes, setNotes] = useState(part?.notes ?? "");
  const [photoKey, setPhotoKey] = useState<string | null>(
    part?.photo_r2_key ?? null
  );

  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});

  const busy = saving || uploading;
  const dismiss = useCallback(() => {
    if (!busy) onClose();
  }, [busy, onClose]);

  async function handlePhotoPick(file: File) {
    setUploading(true);
    setBanner(null);
    setFieldErrors((prev) => ({ ...prev, photo_r2_key: undefined }));

    try {
      const fd = new FormData();
      fd.append("file", file);
      const resp = await fetch(API_PHOTO, { method: "POST", body: fd });
      if (!resp.ok) {
        // Resolve the message BEFORE the updater — a setState callback can't be
        // async, and awaiting inside one is a compile error, not a subtle bug.
        const message = await readError(resp);
        setFieldErrors((prev) => ({ ...prev, photo_r2_key: message }));
        return;
      }
      const body = (await resp.json()) as { r2_key?: unknown };
      if (typeof body.r2_key !== "string" || !body.r2_key) {
        setFieldErrors((prev) => ({
          ...prev,
          photo_r2_key: "The upload came back without a key. Try again."
        }));
        return;
      }
      setPhotoKey(body.r2_key);
    } catch {
      setFieldErrors((prev) => ({
        ...prev,
        photo_r2_key: "Couldn't reach the server to upload that photo."
      }));
    } finally {
      setUploading(false);
      // Clear the picker so re-choosing the SAME file fires onChange again.
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;

    // Flush a machine name that was typed but never committed (submitted by
    // keyboard from another field, so the tag input's blur never fired).
    // setState wouldn't be visible in this tick, so it's computed locally.
    const pending = equipDraft.trim();
    const effectiveEquipment =
      pending && !containsEquipment(parentEquipment, pending)
        ? [...parentEquipment, pending]
        : parentEquipment;

    // part_name is now the ONLY locally-required field. An empty equipment
    // list is a legitimate save — see the header note.
    const local: FieldErrors = {};
    if (!partName.trim()) local.part_name = "Give the part a name.";
    if (Object.keys(local).length > 0) {
      setFieldErrors(local);
      setBanner(null);
      return;
    }

    setSaving(true);
    setBanner(null);
    setFieldErrors({});

    // Every field is sent every time, including the nulls. PATCH is partial on
    // the worker's side, so omitting a cleared field would silently keep the
    // old value — "I deleted the vendor and it came back" is a bug report
    // nobody should have to file. That applies to clearing the LAST machine
    // off a part too, which is why the empty array is sent rather than skipped.
    const payload = {
      parent_equipment: effectiveEquipment,
      part_name: partName.trim(),
      part_number: partNumber.trim() || null,
      vendor: vendor.trim() || null,
      photo_r2_key: photoKey,
      unit_cost: unitCost.trim() || null,
      vendor_url: vendorUrl.trim() || null,
      location_codes: locationCodes
        .split(/[\s,]+/)
        .map((c) => c.trim())
        .filter(Boolean),
      notes: notes.trim() || null
    };

    try {
      const resp = await fetch(part ? `${API_PARTS}/${part.id}` : API_PARTS, {
        method: part ? "PATCH" : "POST",
        // Required by the worker and enforced again by the proxy — this header
        // is the CSRF barrier, not a formality.
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      if (resp.ok) {
        // Re-run the server component so the new row (or the edit) shows up
        // without a full navigation.
        router.refresh();
        onClose();
        return;
      }

      if (resp.status === 409) {
        // The unique index is now on (lower(vendor), lower(part_number)) —
        // NOT on equipment. It used to mean "this number is already on this
        // machine", which stopped making sense the moment a part could be on
        // several machines at once. A part number is a VENDOR's identifier,
        // so one vendor gets one part per number.
        const vendorName = vendor.trim();
        setFieldErrors({
          part_number: vendorName
            ? `${vendorName} already has a part with this number.`
            : "This vendor already has a part with this number."
        });
        setBanner(
          `That part number is already on the list for ${
            vendorName || "this vendor"
          }. Edit the existing part instead of adding a second one — if it's genuinely a different part, check the number.`
        );
        return;
      }

      const message = await readError(resp);
      const field = fieldFromMessage(message);
      if (field) {
        const next: FieldErrors = {};
        next[field] = humanize(message);
        setFieldErrors(next);
        setBanner(null);
      } else {
        setBanner(message);
      }
    } catch {
      setBanner("Couldn't reach the server. Check your connection and retry.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Backdrop onDismiss={dismiss} labelledBy={titleId} busy={busy}>
      <form
        onSubmit={handleSubmit}
        className="overflow-hidden rounded-splash-lg border-[3px] border-splash-navy bg-white shadow-splash-card"
      >
        <div className="flex items-start justify-between gap-4 border-b-2 border-gray-light px-5 py-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-sudsy-blue">
              Parts Directory
            </p>
            <h2 id={titleId} className="text-lg font-bold text-splash-navy">
              {part ? "Edit part" : "Add a part"}
            </h2>
          </div>
          <button
            type="button"
            onClick={dismiss}
            disabled={busy}
            aria-label="Close"
            className="rounded-splash-sm border-2 border-gray-light px-2.5 py-1 text-sm font-bold text-splash-navy hover:border-splash-blue disabled:opacity-50"
          >
            ✕
          </button>
        </div>

        <div className="grid grid-cols-1 gap-4 px-5 py-5 sm:grid-cols-2">
          {/* Full width: the chip row grows, and machine names are long. */}
          <div className="sm:col-span-2">
            <label className={labelClass} htmlFor={`${titleId}-equip`}>
              Machines it&apos;s used on
            </label>
            <EquipmentTagInput
              value={parentEquipment}
              draft={equipDraft}
              options={equipment}
              disabled={busy}
              inputId={`${titleId}-equip`}
              hintId={equipHintId}
              listId={equipListId}
              onChange={setParentEquipment}
              onDraftChange={setEquipDraft}
            />
            {fieldErrors.parent_equipment && (
              <p className={errorClass}>{fieldErrors.parent_equipment}</p>
            )}
          </div>

          <div>
            <label className={labelClass} htmlFor={`${titleId}-name`}>
              Part name *
            </label>
            <input
              id={`${titleId}-name`}
              value={partName}
              onChange={(e) => setPartName(e.target.value)}
              disabled={busy}
              placeholder="e.g. Idler bearing"
              className={inputClass}
            />
            {fieldErrors.part_name && (
              <p className={errorClass}>{fieldErrors.part_name}</p>
            )}
          </div>

          <div>
            <label className={labelClass} htmlFor={`${titleId}-number`}>
              Part number
            </label>
            <input
              id={`${titleId}-number`}
              value={partNumber}
              onChange={(e) => setPartNumber(e.target.value)}
              disabled={busy}
              className={`${inputClass} font-mono`}
            />
            {fieldErrors.part_number && (
              <p className={errorClass}>{fieldErrors.part_number}</p>
            )}
          </div>

          <div>
            <label className={labelClass} htmlFor={`${titleId}-vendor`}>
              Vendor
            </label>
            <input
              id={`${titleId}-vendor`}
              value={vendor}
              onChange={(e) => setVendor(e.target.value)}
              disabled={busy}
              className={inputClass}
            />
            {fieldErrors.vendor && (
              <p className={errorClass}>{fieldErrors.vendor}</p>
            )}
          </div>

          <div>
            <label className={labelClass} htmlFor={`${titleId}-cost`}>
              Unit cost (USD)
            </label>
            <input
              id={`${titleId}-cost`}
              type="number"
              min="0"
              step="0.01"
              inputMode="decimal"
              value={unitCost}
              onChange={(e) => setUnitCost(e.target.value)}
              disabled={busy}
              className={inputClass}
            />
            {fieldErrors.unit_cost && (
              <p className={errorClass}>{fieldErrors.unit_cost}</p>
            )}
          </div>

          <div className="sm:col-span-2">
            <label className={labelClass} htmlFor={`${titleId}-url`}>
              Vendor link
            </label>
            <input
              id={`${titleId}-url`}
              type="url"
              value={vendorUrl}
              onChange={(e) => setVendorUrl(e.target.value)}
              disabled={busy}
              placeholder="https://…"
              className={inputClass}
            />
            {fieldErrors.vendor_url && (
              <p className={errorClass}>{fieldErrors.vendor_url}</p>
            )}
          </div>

          <div className="sm:col-span-2">
            <label className={labelClass} htmlFor={`${titleId}-locations`}>
              Sites that use it
            </label>
            <input
              id={`${titleId}-locations`}
              value={locationCodes}
              onChange={(e) => setLocationCodes(e.target.value)}
              disabled={busy}
              placeholder="binghamton, vestal, johnson-city"
              className={inputClass}
            />
            <p className="mt-1 text-xs text-splash-navy/50">
              Comma or space separated. Descriptive only — this never restricts
              who can see the part.
            </p>
            {fieldErrors.location_codes && (
              <p className={errorClass}>{fieldErrors.location_codes}</p>
            )}
          </div>

          <div className="sm:col-span-2">
            <label className={labelClass} htmlFor={`${titleId}-notes`}>
              Notes
            </label>
            <textarea
              id={`${titleId}-notes`}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              disabled={busy}
              rows={3}
              placeholder="Same as the one on the 701 — order two."
              className={`${inputClass} resize-y`}
            />
            {fieldErrors.notes && (
              <p className={errorClass}>{fieldErrors.notes}</p>
            )}
          </div>

          <div className="sm:col-span-2">
            <span className={labelClass}>Photo</span>
            <div className="flex flex-wrap items-start gap-4">
              <div className="h-28 w-36 shrink-0 overflow-hidden rounded-splash-md border-2 border-gray-light bg-splash-navy/5">
                {photoKey ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={partPhotoUrl(photoKey)}
                    alt="Part photo preview"
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <span className="flex h-full w-full items-center justify-center text-[0.6875rem] font-semibold uppercase tracking-[0.12em] text-splash-navy/30">
                    No photo
                  </span>
                )}
              </div>

              <div className="flex flex-col gap-2">
                <input
                  ref={fileInput}
                  type="file"
                  accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif"
                  disabled={busy}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void handlePhotoPick(file);
                  }}
                  className="text-xs text-splash-navy file:mr-3 file:rounded-splash-sm file:border-2 file:border-gray-light file:bg-white file:px-3 file:py-1.5 file:text-xs file:font-bold file:uppercase file:tracking-[0.08em] file:text-splash-navy"
                />
                {uploading && (
                  <p className="text-xs font-semibold text-sudsy-blue">
                    Uploading…
                  </p>
                )}
                {photoKey && !uploading && (
                  <button
                    type="button"
                    onClick={() => setPhotoKey(null)}
                    className="self-start text-xs font-bold uppercase tracking-[0.08em] text-racecar-red hover:underline"
                  >
                    Remove photo
                  </button>
                )}
                <p className="max-w-[20rem] text-xs text-splash-navy/50">
                  JPEG, PNG, WebP, or HEIC. Up to 8 MB.
                </p>
              </div>
            </div>
            {fieldErrors.photo_r2_key && (
              <p className={errorClass}>{fieldErrors.photo_r2_key}</p>
            )}
          </div>
        </div>

        <div className="border-t-2 border-gray-light px-5 py-4">
          {banner && (
            <p
              role="alert"
              className="mb-3 rounded-splash-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900"
            >
              {banner}
            </p>
          )}
          <div className="flex flex-wrap items-center justify-end gap-3">
            <button
              type="button"
              onClick={dismiss}
              disabled={busy}
              className="rounded-splash-md border-2 border-gray-light px-4 py-2 text-sm font-bold uppercase tracking-[0.08em] text-splash-navy hover:border-splash-blue disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy}
              className="rounded-splash-md bg-splash-blue px-5 py-2 text-sm font-bold uppercase tracking-[0.08em] text-white shadow-splash-btn hover:bg-splash-blue-dark disabled:opacity-60"
            >
              {saving ? "Saving…" : part ? "Save changes" : "Add part"}
            </button>
          </div>
        </div>
      </form>
    </Backdrop>
  );
}

/* ============================================================
 * Delete confirmation
 * ============================================================ */

export interface PartDeleteConfirmProps {
  part: PartRow;
  onClose: () => void;
}

/**
 * Deliberately a separate step rather than a `confirm()`. The delete is a hard
 * delete — there is no soft-delete column on parts_directory — so the operator
 * gets to read the part name and number back before it stops existing.
 *
 * Now that one row can cover several machines, the confirmation lists ALL of
 * them: deleting the shared bearing takes it off the wrap AND the top brush,
 * and that had better be on screen before the button is pressed.
 */
export function PartDeleteConfirm({ part, onClose }: PartDeleteConfirmProps) {
  const router = useRouter();
  const titleId = useId();
  const [deleting, setDeleting] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);

  const dismiss = useCallback(() => {
    if (!deleting) onClose();
  }, [deleting, onClose]);

  async function handleDelete() {
    if (deleting) return;
    setDeleting(true);
    setBanner(null);
    try {
      const resp = await fetch(`${API_PARTS}/${part.id}`, { method: "DELETE" });
      if (resp.ok) {
        router.refresh();
        onClose();
        return;
      }
      setBanner(await readError(resp));
    } catch {
      setBanner("Couldn't reach the server. Check your connection and retry.");
    } finally {
      setDeleting(false);
    }
  }

  const machines = part.parent_equipment;

  return (
    <Backdrop onDismiss={dismiss} labelledBy={titleId} busy={deleting}>
      <div className="overflow-hidden rounded-splash-lg border-[3px] border-splash-navy bg-white shadow-splash-card">
        <div className="px-5 py-5">
          <h2 id={titleId} className="text-lg font-bold text-splash-navy">
            Delete this part?
          </h2>
          <p className="mt-2 text-sm text-splash-navy/70">
            <span className="font-bold text-splash-navy">{part.part_name}</span>
            {part.part_number && (
              <>
                {" — "}
                <span className="font-mono">{part.part_number}</span>
              </>
            )}
            <br />
            {machines.length > 0 ? (
              machines.join(", ")
            ) : (
              <span className="italic">No machine recorded</span>
            )}
          </p>
          <p className="mt-3 text-sm text-splash-navy/70">
            {machines.length > 1
              ? `This removes the row and its photo for good — off all ${machines.length} machines. There is no undo.`
              : "This removes the row and its photo for good. There is no undo."}
          </p>

          {banner && (
            <p
              role="alert"
              className="mt-3 rounded-splash-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900"
            >
              {banner}
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-end gap-3 border-t-2 border-gray-light px-5 py-4">
          <button
            type="button"
            onClick={dismiss}
            disabled={deleting}
            className="rounded-splash-md border-2 border-gray-light px-4 py-2 text-sm font-bold uppercase tracking-[0.08em] text-splash-navy hover:border-splash-blue disabled:opacity-50"
          >
            Keep it
          </button>
          <button
            type="button"
            onClick={() => void handleDelete()}
            disabled={deleting}
            autoFocus
            className="rounded-splash-md bg-racecar-red px-5 py-2 text-sm font-bold uppercase tracking-[0.08em] text-white shadow-splash-btn hover:opacity-90 disabled:opacity-60"
          >
            {deleting ? "Deleting…" : "Delete part"}
          </button>
        </div>
      </div>
    </Backdrop>
  );
}
