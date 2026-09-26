"use client";

// Find a chemical somebody has already set up, and add it to this site.
//
// THIS IS THE POINT OF THE CATALOGUE. Fifty sites hold unleaded gasoline and it
// is one chemical with one sheet. Picking the existing entry means this site
// inherits that sheet, its manufacturer and its revision date immediately --
// and, just as importantly, does NOT create a fifty-first near-duplicate that
// nobody can tell from the others on a printed index.
//
// Verified entries sort first and say so. Unverified ones are still offered: a
// site needing something nobody has got round to checking must not be stuck
// waiting for an administrator.

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import type { SdsCatalogSearchRow } from "../_lib/types";
import { addFromCatalogAction } from "../actions";

export default function CatalogSearch({
  locationCode,
  onDone
}: {
  locationCode: string;
  onDone: () => void;
}) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<SdsCatalogSearchRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // Debounced so typing does not fire a request per keystroke.
  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const r = await fetch(
          `/forms/api/sds/catalog?q=${encodeURIComponent(q)}`,
          { credentials: "include", cache: "no-store" }
        );
        if (!r.ok || cancelled) return;
        const data = (await r.json()) as { catalog?: SdsCatalogSearchRow[] };
        if (!cancelled) setRows(data.catalog ?? []);
      } catch {
        // An unreachable search leaves the list as it was; typing a new
        // chemical by hand still works and is right next to this.
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [q]);

  function add(row: SdsCatalogSearchRow) {
    setError(null);
    startTransition(async () => {
      const res = await addFromCatalogAction(locationCode, row.id);
      if (res.ok) {
        onDone();
        router.refresh();
      } else {
        setError(res.error);
      }
    });
  }

  return (
    <div className="mt-4 rounded-splash-md border border-splash-navy/30 bg-white p-4">
      <p className="text-xs font-semibold uppercase tracking-wider text-splash-navy/70">
        Find a chemical already set up
      </p>
      <p className="mb-3 mt-1 text-xs text-splash-navy/60">
        Adding one here brings its safety data sheet with it &mdash; nothing to
        re-upload. Check the name matches what is on your container.
      </p>

      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        autoFocus
        placeholder="Search by product or manufacturer…"
        className="mb-3 w-full rounded-splash-sm border border-gray-light px-2 py-1.5 text-sm"
      />

      {loading && rows.length === 0 ? (
        <p className="text-xs text-splash-navy/50">Searching…</p>
      ) : null}

      {!loading && rows.length === 0 ? (
        <p className="text-xs text-splash-navy/50">
          Nothing matches. Add it by hand and it becomes available to every
          other site.
        </p>
      ) : null}

      <ul className="max-h-72 space-y-1 overflow-y-auto">
        {rows.map((row) => (
          <li
            key={row.id}
            className="flex items-center justify-between gap-3 rounded-splash-sm border border-gray-light px-3 py-2"
          >
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold text-splash-navy">
                  {row.product_identifier}
                </span>
                {row.verified_at ? (
                  <span
                    title={`Verified${row.verified_by ? ` by ${row.verified_by}` : ""}`}
                    className="rounded-full bg-emerald-100 px-2 py-0.5 text-[0.6875rem] font-bold text-emerald-800"
                  >
                    ✓ Verified
                  </span>
                ) : null}
                {row.sds_r2_key ? (
                  <span className="rounded-full bg-gray-light px-2 py-0.5 text-[0.6875rem] font-semibold text-splash-navy/70">
                    Sheet on file
                  </span>
                ) : (
                  <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[0.6875rem] font-semibold text-amber-800">
                    No sheet yet
                  </span>
                )}
              </div>
              <div className="text-xs text-splash-navy/60">
                {row.manufacturer || "Manufacturer not recorded"}
                {row.site_count > 0 ? ` · used at ${row.site_count} sites` : ""}
              </div>
            </div>
            <button
              type="button"
              disabled={pending}
              onClick={() => add(row)}
              className="shrink-0 rounded-splash-sm bg-splash-navy px-3 py-1.5 text-xs font-bold text-white disabled:opacity-50"
            >
              Add
            </button>
          </li>
        ))}
      </ul>

      {error ? (
        <p role="alert" className="mt-2 text-xs text-racecar-red">
          {error}
        </p>
      ) : null}

      <button type="button" onClick={onDone} className="mt-3 text-xs text-splash-navy/60 underline">
        Cancel
      </button>
    </div>
  );
}
