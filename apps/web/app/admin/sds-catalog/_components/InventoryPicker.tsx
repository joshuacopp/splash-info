"use client";

// Stock the catalogue from the chemical inventory's own product list.
//
// WHY THIS EXISTS. Before it, building the catalogue meant typing product names
// from memory. "Presoak HWS 2X" and "Presoak HWS *2X*" are one chemical and two
// catalogue entries, and nothing downstream can tell them apart -- a site
// searching for what it actually stocks finds the wrong one, or neither. The
// names inventory holds are the names on the drums, so they are the ones worth
// having.
//
// ORDERED BY SITE COUNT, and that is the whole ergonomics of the screen. There
// are 469 products; about 106 are stocked anywhere at all. Alphabetical would
// present that as an undifferentiated wall. By site count it is a worklist: the
// chemical at 40 sites needs a sheet before the one at three, and the unused
// 363 stay behind a toggle rather than padding the list.
//
// Already-catalogued products are shown, not hidden -- disabled, with why. A
// missing row reads as a bug; a greyed one reads as done.

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import type { SdsInventoryProduct } from "../../../sds/_lib/types";
import { addFromInventoryAction } from "../actions";

export default function InventoryPicker({ onDone }: { onDone: () => void }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [includeUnused, setIncludeUnused] = useState(false);
  const [rows, setRows] = useState<SdsInventoryProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const qs = new URLSearchParams();
        if (q) qs.set("q", q);
        if (includeUnused) qs.set("include_unused", "1");
        const r = await fetch(`/forms/api/sds/inventory-products?${qs.toString()}`, {
          credentials: "include",
          cache: "no-store"
        });
        if (cancelled) return;
        if (!r.ok) {
          // An empty list and a broken request look identical to a reader, so
          // say which one this is rather than implying inventory holds nothing.
          setLoadFailed(true);
          return;
        }
        const data = (await r.json()) as { products?: SdsInventoryProduct[] };
        if (!cancelled) {
          setRows(data.products ?? []);
          setLoadFailed(false);
        }
      } catch {
        if (!cancelled) setLoadFailed(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [q, includeUnused]);

  const addable = rows.filter((r) => !r.catalog_id);

  function add() {
    setError(null);
    setNote(null);
    startTransition(async () => {
      const res = await addFromInventoryAction([...picked]);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setNote(
        res.created === picked.size
          ? `Added ${res.created} to the catalogue.`
          : `Added ${res.created}; the rest were already there.`
      );
      setPicked(new Set());
      router.refresh();
    });
  }

  return (
    <div className="mb-3 rounded-splash-md border border-splash-navy/30 bg-white p-4">
      <p className="text-xs font-semibold uppercase tracking-wider text-splash-navy/70">
        Add from chemical inventory
      </p>
      <p className="mt-1 text-xs text-splash-navy/60">
        These are the product names inventory actually uses, so the catalogue
        matches what is on the drums. Most-stocked first &mdash; those are the
        ones worth a sheet soonest. Inventory covers wash chemicals only;
        oil-lube, cleaning products and fuels still get added by hand.
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          autoFocus
          placeholder="Search products…"
          className="min-w-[16rem] flex-1 rounded-splash-sm border border-gray-light px-2 py-1.5 text-sm"
        />
        <label className="flex items-center gap-1.5 text-xs text-splash-navy/70">
          <input
            type="checkbox"
            checked={includeUnused}
            onChange={(e) => setIncludeUnused(e.target.checked)}
          />
          Include products no site stocks
        </label>
      </div>

      {loading ? (
        <p className="mt-3 text-xs text-splash-navy/50">Loading…</p>
      ) : null}

      {loadFailed ? (
        <p role="alert" className="mt-3 text-xs text-racecar-red">
          Could not reach the product list. This is the tool failing, not an
          empty inventory &mdash; adding a chemical by hand still works.
        </p>
      ) : null}

      {!loading && !loadFailed && rows.length === 0 ? (
        <p className="mt-3 text-xs text-splash-navy/50">
          No products match.
          {!includeUnused ? " Try including ones no site stocks." : ""}
        </p>
      ) : null}

      {rows.length > 0 ? (
        <>
          <div className="mt-3 flex items-center justify-between text-xs text-splash-navy/60">
            <span>
              {rows.length} shown · {addable.length} not yet in the catalogue
            </span>
            {addable.length > 0 ? (
              <button
                type="button"
                onClick={() =>
                  setPicked(
                    picked.size === addable.length
                      ? new Set()
                      : new Set(addable.map((r) => r.product_id))
                  )
                }
                className="underline"
              >
                {picked.size === addable.length ? "Clear all" : "Select all shown"}
              </button>
            ) : null}
          </div>

          <ul className="mt-2 max-h-80 space-y-1 overflow-y-auto">
            {rows.map((r) => {
              const already = Boolean(r.catalog_id);
              return (
                <li
                  key={r.product_id}
                  className={`flex items-center gap-2 rounded-splash-sm border border-gray-light px-3 py-1.5 ${
                    already ? "bg-splash-navy/[0.03]" : ""
                  }`}
                >
                  <input
                    type="checkbox"
                    disabled={already}
                    checked={picked.has(r.product_id)}
                    onChange={(e) => {
                      const next = new Set(picked);
                      if (e.target.checked) next.add(r.product_id);
                      else next.delete(r.product_id);
                      setPicked(next);
                    }}
                  />
                  <span
                    className={`min-w-0 flex-1 truncate text-sm ${
                      already ? "text-splash-navy/50" : "text-splash-navy"
                    }`}
                    title={r.description || r.product_name}
                  >
                    {r.product_name}
                  </span>
                  <span className="shrink-0 text-[0.6875rem] tabular-nums text-splash-navy/50">
                    {r.site_count === 0
                      ? "no sites"
                      : `${r.site_count} site${r.site_count === 1 ? "" : "s"}`}
                  </span>
                  {already ? (
                    <span
                      className={`shrink-0 rounded-full px-2 py-0.5 text-[0.6875rem] font-semibold ${
                        r.has_sheet
                          ? "bg-gray-light text-splash-navy/70"
                          : "bg-amber-100 text-amber-800"
                      }`}
                    >
                      {r.has_sheet ? "In catalogue" : "In catalogue · no sheet"}
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={pending || picked.size === 0}
          onClick={add}
          className="rounded-splash-sm bg-splash-navy px-3 py-1.5 text-xs font-bold text-white disabled:opacity-50"
        >
          {pending ? "Adding…" : `Add ${picked.size || ""} to the catalogue`.replace("  ", " ")}
        </button>
        <button type="button" onClick={onDone} className="text-xs text-splash-navy/60 underline">
          Done
        </button>
        {note ? <span className="text-xs text-emerald-700">{note}</span> : null}
      </div>

      {error ? (
        <p role="alert" className="mt-2 text-xs text-racecar-red">
          {error}
        </p>
      ) : null}
    </div>
  );
}
