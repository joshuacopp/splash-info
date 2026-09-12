"use client";

// Searchable, grouped parts directory. Read-only.
//
// Same interaction model as ../../../macneil-videos/_components/VideoGrid:
// the server hands over the entire list once and every keystroke filters it
// in memory. No round trip, no debounce, no loading state. That is the right
// trade here for the same reason it was there — the list is a few hundred
// rows of short strings, and the alternative (a request per keystroke) is
// slower AND worse on a phone in a wash bay with three bars of signal.
//
// Multi-word search is AND, not OR. "macneil bearing" should mean "the
// bearing we buy from MacNeil", so every term has to land somewhere in the
// row. OR would return every MacNeil part plus every bearing and be useless
// at exactly the moment it matters.
//
// The haystack is built once per list, not per keystroke, and includes the
// notes field — notes are where someone writes "same as the one on the 701,
// order two", which is the most searchable sentence on the card.
//
// Photos open in a lightbox rather than a new tab. A part photo is looked at
// to confirm "yes, that's the one" and then dismissed; a tab is a heavier
// gesture than the job deserves. Escape and a backdrop click both close it,
// and the trigger is a real <button> so it is reachable by keyboard.
//
// ADMIN CONTROLS (the pass the seam above was left for). Everything
// mutating lives in ./PartEditor; this component only decides WHEN to show a
// dialog, never how to save. The affordances render only when `canEdit` is
// true, which the server component resolves from
// `getMe().role === "super_admin"` — the exact predicate the worker enforces
// on writes. If the two ever drift, the symptom is a button that 403s, so
// change them together.
//
// `canEdit` is a UI convenience and NOTHING MORE. The route handlers under
// ../api/ re-check the session and the worker re-checks it again; a curious
// person with dev tools can flip this prop and get nothing for it.

import { useCallback, useEffect, useMemo, useState } from "react";
import { partPhotoUrl, type PartRow } from "../_lib/parts-shared";
import { PartDeleteConfirm, PartEditor } from "./PartEditor";

interface Props {
  parts: PartRow[];
  /** Distinct sorted parent_equipment over ALL rows — drives the filter and
   *  the order sections render in. */
  equipment: string[];
  /** Platform super_admin. Gates the Add/Edit/Delete affordances only — see
   *  the ADMIN CONTROLS note at the top of this file. Defaults to false so a
   *  caller that forgets to pass it gets the read-only page, not an open one. */
  canEdit?: boolean;
}

/** Which dialog, if any, is up. "new" is the create form. */
type EditorTarget = PartRow | "new" | null;

const ALL_EQUIPMENT = "__all__";

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD"
});

/** Everything a search term is allowed to match, lowercased once. */
function searchText(part: PartRow): string {
  return [
    part.part_name,
    part.part_number,
    part.vendor,
    part.parent_equipment,
    part.notes
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

export function PartsDirectory({ parts, equipment, canEdit = false }: Props) {
  const [query, setQuery] = useState("");
  const [equipFilter, setEquipFilter] = useState<string>(ALL_EQUIPMENT);
  const [lightbox, setLightbox] = useState<PartRow | null>(null);
  const [editing, setEditing] = useState<EditorTarget>(null);
  const [deleting, setDeleting] = useState<PartRow | null>(null);

  // Built once per list, not per keystroke.
  const haystacks = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of parts) map.set(p.id, searchText(p));
    return map;
  }, [parts]);

  const needle = query.trim().toLowerCase();

  const matches = useMemo(() => {
    const terms = needle ? needle.split(/\s+/) : [];
    return parts.filter((p) => {
      if (equipFilter !== ALL_EQUIPMENT && p.parent_equipment !== equipFilter) {
        return false;
      }
      if (terms.length === 0) return true;
      const hay = haystacks.get(p.id) ?? "";
      return terms.every((t) => hay.includes(t));
    });
  }, [parts, haystacks, needle, equipFilter]);

  // Sections in the registry's order. Any parent_equipment the worker didn't
  // list (a row added between the two queries) is appended rather than
  // dropped — a part that exists should never be invisible.
  const sections = useMemo(() => {
    const order = [...equipment];
    const seen = new Set(order);
    for (const p of matches) {
      if (!seen.has(p.parent_equipment)) {
        seen.add(p.parent_equipment);
        order.push(p.parent_equipment);
      }
    }
    return order
      .map((label) => ({
        label,
        items: matches.filter((p) => p.parent_equipment === label)
      }))
      .filter((s) => s.items.length > 0);
  }, [equipment, matches]);

  const closeLightbox = useCallback(() => setLightbox(null), []);

  // Escape closes. Bound only while the overlay is up so the page has no
  // stray global key handler the rest of the time.
  useEffect(() => {
    if (!lightbox) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") closeLightbox();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [lightbox, closeLightbox]);

  const filtering = needle !== "" || equipFilter !== ALL_EQUIPMENT;

  return (
    <>
      <div className="mb-7 flex flex-wrap items-center gap-3">
        <div className="relative min-w-[260px] flex-1">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search — part number, name, vendor, notes…"
            aria-label="Search parts"
            className="w-full rounded-splash-md border-2 border-gray-light bg-white px-4 py-2.5 text-sm text-splash-navy outline-none focus:border-splash-blue"
          />
        </div>

        <select
          value={equipFilter}
          onChange={(e) => setEquipFilter(e.target.value)}
          aria-label="Filter by equipment"
          className="rounded-splash-md border-2 border-gray-light bg-white px-3 py-2.5 text-sm font-semibold text-splash-navy outline-none focus:border-splash-blue"
        >
          <option value={ALL_EQUIPMENT}>All equipment</option>
          {equipment.map((label) => (
            <option key={label} value={label}>
              {label}
            </option>
          ))}
        </select>

        <p className="text-sm font-semibold text-splash-navy/60">
          {filtering
            ? `${matches.length} of ${parts.length} part${parts.length === 1 ? "" : "s"}`
            : `${parts.length} part${parts.length === 1 ? "" : "s"}`}
        </p>

        {canEdit && (
          <button
            type="button"
            onClick={() => setEditing("new")}
            className="rounded-splash-md bg-splash-blue px-4 py-2.5 text-sm font-bold uppercase tracking-[0.08em] text-white shadow-splash-btn hover:bg-splash-blue-dark"
          >
            + Add part
          </button>
        )}
      </div>

      {sections.length === 0 ? (
        <div className="rounded-splash-md border border-gray-light bg-white px-4 py-8 text-center italic text-splash-navy/60">
          {parts.length === 0
            ? "No parts in the directory yet."
            : "Nothing matches that search. Try a part number, a vendor, or the machine it came off."}
        </div>
      ) : (
        sections.map(({ label, items }) => (
          <section key={label} className="mb-10">
            <div className="mb-4 flex items-baseline gap-3 border-b-2 border-gray-light pb-2">
              <h2 className="text-lg font-bold text-splash-navy">{label}</h2>
              <span className="text-xs font-semibold uppercase tracking-[0.14em] text-splash-navy/50">
                {items.length} {items.length === 1 ? "part" : "parts"}
              </span>
            </div>

            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {items.map((part) => (
                <PartCard
                  key={part.id}
                  part={part}
                  onOpenPhoto={() => setLightbox(part)}
                  onEdit={canEdit ? () => setEditing(part) : undefined}
                  onDelete={canEdit ? () => setDeleting(part) : undefined}
                />
              ))}
            </div>
          </section>
        ))
      )}

      {/* Dialogs are mounted here rather than inside the card so a card
          unmounting (a filter keystroke, a router.refresh()) can't tear the
          open form out from under the operator mid-edit. */}
      {canEdit && editing !== null && (
        <PartEditor
          // Remount on target change so every open starts from that row's
          // values instead of stale state left by the previous one.
          key={editing === "new" ? "new" : editing.id}
          part={editing === "new" ? null : editing}
          equipment={equipment}
          onClose={() => setEditing(null)}
        />
      )}

      {canEdit && deleting && (
        <PartDeleteConfirm
          key={deleting.id}
          part={deleting}
          onClose={() => setDeleting(null)}
        />
      )}

      {lightbox?.photo_r2_key && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`${lightbox.part_name} photo`}
          onClick={closeLightbox}
          className="fixed inset-0 z-50 flex items-center justify-center bg-splash-navy/80 p-6"
        >
          {/* Stop the click on the image itself from closing, so someone can
              drag/zoom the photo without it vanishing under them. */}
          <div
            onClick={(e) => e.stopPropagation()}
            className="relative max-h-full max-w-3xl overflow-hidden rounded-splash-lg bg-white shadow-splash-card"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={partPhotoUrl(lightbox.photo_r2_key)}
              alt={lightbox.part_name}
              className="max-h-[75vh] w-full object-contain"
            />
            <div className="flex items-center justify-between gap-4 border-t border-gray-light px-4 py-3">
              <div>
                <p className="text-sm font-bold text-splash-navy">
                  {lightbox.part_name}
                </p>
                {lightbox.part_number && (
                  <p className="font-mono text-xs text-splash-navy/70">
                    {lightbox.part_number}
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={closeLightbox}
                autoFocus
                className="rounded-splash-sm border-2 border-gray-light px-3 py-1.5 text-xs font-bold uppercase tracking-[0.08em] text-splash-navy hover:border-splash-blue"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function PartCard({
  part,
  onOpenPhoto,
  onEdit,
  onDelete
}: {
  part: PartRow;
  onOpenPhoto: () => void;
  /** Both undefined for a non-admin viewer — the footer row is then only
   *  rendered at all if there's a vendor link to put in it. */
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  return (
    <div className="flex flex-col overflow-hidden rounded-splash-lg border-[3px] border-splash-navy bg-white shadow-splash-card">
      <div className="relative aspect-[4/3] bg-splash-navy/5">
        {part.photo_r2_key ? (
          <button
            type="button"
            onClick={onOpenPhoto}
            aria-label={`View photo of ${part.part_name}`}
            className="group absolute inset-0 h-full w-full"
          >
            {/* Plain <img>, not next/image: this is a Worker-served R2 object
                behind auth, and routing it through the optimizer buys nothing
                — the same reason VideoGrid uses a plain tag for YouTube
                thumbnails. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={partPhotoUrl(part.photo_r2_key)}
              alt=""
              loading="lazy"
              className="h-full w-full object-cover transition-transform duration-150 group-hover:scale-[1.03]"
            />
          </button>
        ) : (
          // Neutral block, never a broken <img>. A missing photo is normal.
          <div
            aria-hidden="true"
            className="absolute inset-0 flex items-center justify-center text-xs font-semibold uppercase tracking-[0.14em] text-splash-navy/30"
          >
            No photo
          </div>
        )}
      </div>

      <div className="flex flex-1 flex-col gap-1.5 px-5 pb-4 pt-4">
        <h3 className="text-[0.9375rem] font-bold leading-snug text-splash-navy">
          {part.part_name}
        </h3>

        {/* Monospace and boxed: this number gets read off the screen character
            by character into a vendor's order form, and a proportional font
            makes 1/l and 0/O a coin flip. */}
        {part.part_number && (
          <p className="select-all rounded-splash-sm bg-splash-navy/5 px-2 py-1 font-mono text-sm font-bold tracking-tight text-splash-navy">
            {part.part_number}
          </p>
        )}

        {(part.vendor || part.unit_cost != null) && (
          <p className="text-sm text-splash-navy/70">
            {part.vendor}
            {part.vendor && part.unit_cost != null && " · "}
            {part.unit_cost != null && (
              <span className="font-semibold text-splash-navy">
                {usd.format(part.unit_cost)}
              </span>
            )}
          </p>
        )}

        {part.location_codes.length > 0 && (
          <ul className="flex flex-wrap gap-1 pt-0.5">
            {part.location_codes.map((code) => (
              <li
                key={code}
                className="rounded-splash-sm bg-sudsy-blue-soft px-1.5 py-0.5 text-[0.6875rem] font-bold uppercase tracking-[0.06em] text-splash-navy/80"
              >
                {code}
              </li>
            ))}
          </ul>
        )}

        {part.notes && (
          <p className="whitespace-pre-line text-xs leading-relaxed text-splash-navy/60">
            {part.notes}
          </p>
        )}

        {(part.vendor_url || onEdit) && (
          <div className="mt-auto flex flex-wrap items-center gap-3 pt-2">
            {part.vendor_url && (
              <a
                href={part.vendor_url}
                target="_blank"
                rel="noreferrer noopener"
                className="text-xs font-bold uppercase tracking-[0.08em] text-splash-blue hover:underline"
              >
                Order ↗
              </a>
            )}

            {/* Pushed right so "Order" keeps the position a tech looks for;
                the admin controls are the rarer gesture on this card. */}
            {onEdit && onDelete && (
              <span className="ml-auto flex items-center gap-2">
                <button
                  type="button"
                  onClick={onEdit}
                  aria-label={`Edit ${part.part_name}`}
                  className="rounded-splash-sm border-2 border-gray-light px-2 py-1 text-[0.6875rem] font-bold uppercase tracking-[0.08em] text-splash-navy hover:border-splash-blue"
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={onDelete}
                  aria-label={`Delete ${part.part_name}`}
                  className="rounded-splash-sm border-2 border-gray-light px-2 py-1 text-[0.6875rem] font-bold uppercase tracking-[0.08em] text-racecar-red hover:border-racecar-red"
                >
                  Delete
                </button>
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
