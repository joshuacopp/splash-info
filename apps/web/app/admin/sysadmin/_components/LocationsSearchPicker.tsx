"use client";

// Substring typeahead used by the "Update location" card on /admin/sysadmin
// (Brief 27). Hits /sysadmin/api/locations/search?q=... — the
// sysadmin-worker returns up to 50 rows matching across site, location,
// area_manager, regional_manager, plus an exact site_number.eq match
// when q is purely numeric.
//
// Mirrors the PackageSearchPicker pattern from Brief 26:
//   - debounced fetch (250ms)
//   - selection state held by the parent via `selected` + `onSelect` so
//     UpdateLocationCard can inflate the form with the row's full data
//   - empty query closes the dropdown without firing a request
//   - failure surfaces a small error note below the input
//   - combobox + listbox aria roles + arrow key nav + Esc + outside-click dismiss
//
// URL is relative ("/sysadmin/api/locations/search?q=..."): same posture
// as PackageSearchPicker / UserPicker — production is same-origin (CF
// route bindings), dev relies on next.config.mjs rewrites proxying
// /sysadmin/api/:path* to NEXT_PUBLIC_SYSADMIN_WORKER_URL when set.

import { useEffect, useId, useMemo, useRef, useState } from "react";

export interface LocationsSearchRow {
  id: number | string;
  site_number: number | null;
  site: string | null;
  location: string | null;
  area_manager: string | null;
  regional_manager: string | null;
  am_email: string | null;
  rm_email: string | null;
  site_email: string | null;
  hrt_email: string | null;
  rm_group: string | null;
  // Other columns the worker may pass through unchanged (mla_location,
  // hrt1, hrt2, fivestar, created_at, updated_at, ...). Optional so the
  // type stays accurate even when the schema evolves.
  mla_location?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  [key: string]: unknown;
}

interface LocationsSearchPickerProps {
  /** Currently selected row. Pass null to render an empty picker. */
  selected: LocationsSearchRow | null;
  /** Fired on row pick (row) and on Clear (null). */
  onSelect: (row: LocationsSearchRow | null) => void;
  /** Visible input placeholder. */
  placeholder?: string;
  /** Optional id forwarded to the visible input — pairs with FieldLabel htmlFor. */
  inputId?: string;
}

function formatUpdated(iso: string | null | undefined): string {
  if (!iso) return "";
  return iso.slice(0, 10);
}

export function LocationsSearchPicker({
  selected,
  onSelect,
  placeholder,
  inputId
}: LocationsSearchPickerProps) {
  const listboxId = useId();
  const optionIdPrefix = useId();

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<LocationsSearchRow[]>([]);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const debounceRef = useRef<number | null>(null);
  const fetchSeqRef = useRef(0);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (debounceRef.current !== null) {
      window.clearTimeout(debounceRef.current);
    }
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      setResults([]);
      setOpen(false);
      setActiveIndex(-1);
      setErrorMessage(null);
      return;
    }

    debounceRef.current = window.setTimeout(async () => {
      const seq = ++fetchSeqRef.current;
      try {
        const url = `/sysadmin/api/locations/search?q=${encodeURIComponent(trimmed)}`;
        const resp = await fetch(url, {
          method: "GET",
          credentials: "include",
          cache: "no-store"
        });
        if (seq !== fetchSeqRef.current) return;

        if (!resp.ok) {
          setResults([]);
          setOpen(false);
          setActiveIndex(-1);
          if (resp.status !== 401 && resp.status !== 403) {
            setErrorMessage(`Search failed (${resp.status}).`);
          } else {
            setErrorMessage(null);
          }
          return;
        }

        const rows = (await resp.json()) as LocationsSearchRow[];
        if (seq !== fetchSeqRef.current) return;
        setResults(rows);
        setOpen(rows.length > 0);
        setActiveIndex(rows.length > 0 ? 0 : -1);
        setErrorMessage(null);
      } catch (err) {
        if (seq !== fetchSeqRef.current) return;
        setResults([]);
        setOpen(false);
        setActiveIndex(-1);
        setErrorMessage(err instanceof Error ? err.message : "Search failed.");
      }
    }, 250);

    return () => {
      if (debounceRef.current !== null) {
        window.clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    };
  }, [query]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (
        containerRef.current &&
        e.target instanceof Node &&
        !containerRef.current.contains(e.target)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  function pick(row: LocationsSearchRow) {
    onSelect(row);
    setQuery("");
    setResults([]);
    setOpen(false);
    setActiveIndex(-1);
  }

  function clear() {
    onSelect(null);
    setQuery("");
    setResults([]);
    setOpen(false);
    setActiveIndex(-1);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      if (results.length === 0) return;
      e.preventDefault();
      setOpen(true);
      setActiveIndex((idx) => (idx + 1) % results.length);
    } else if (e.key === "ArrowUp") {
      if (results.length === 0) return;
      e.preventDefault();
      setOpen(true);
      setActiveIndex((idx) => (idx <= 0 ? results.length - 1 : idx - 1));
    } else if (e.key === "Enter") {
      if (open && activeIndex >= 0 && results[activeIndex]) {
        e.preventDefault();
        pick(results[activeIndex]!);
      }
    } else if (e.key === "Escape") {
      if (open) {
        e.preventDefault();
        setOpen(false);
      }
    }
  }

  const activeOptionId = useMemo(
    () =>
      open && activeIndex >= 0
        ? `${optionIdPrefix}-opt-${activeIndex}`
        : undefined,
    [open, activeIndex, optionIdPrefix]
  );

  const inputCls =
    "w-full rounded-splash-sm border border-gray-light bg-white px-3 py-2 text-sm text-splash-navy shadow-inner placeholder:text-splash-navy/40 focus:border-splash-blue focus:outline-none focus:ring-1 focus:ring-splash-blue";

  return (
    <div ref={containerRef} className="relative">
      <input
        id={inputId}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-activedescendant={activeOptionId}
        autoComplete="off"
        value={query}
        placeholder={
          placeholder ?? "Type a site number, name, address, or manager…"
        }
        className={inputCls}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
        onFocus={() => {
          if (results.length > 0) setOpen(true);
        }}
      />

      {selected ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-2 rounded-splash-sm border border-sudsy-blue/30 bg-sudsy-blue-soft/40 px-2.5 py-1.5 text-xs text-splash-navy">
          <span className="font-semibold">Selected:</span>
          <span className="font-mono">
            #{selected.site_number ?? "?"}
          </span>
          {selected.site ? <span>· {selected.site}</span> : null}
          {selected.area_manager || selected.regional_manager ? (
            <span className="text-splash-navy/60">
              ({selected.area_manager ?? "—"} / {selected.regional_manager ?? "—"})
            </span>
          ) : null}
          <button
            type="button"
            onClick={clear}
            className="ml-auto text-splash-blue underline-offset-2 hover:text-splash-blue-dark hover:underline"
          >
            Clear
          </button>
        </div>
      ) : null}

      {errorMessage ? (
        <div className="mt-1 text-xs text-splash-deny">{errorMessage}</div>
      ) : null}

      {open && results.length > 0 ? (
        <ul
          id={listboxId}
          role="listbox"
          className="absolute left-0 right-0 z-20 mt-1 max-h-72 overflow-y-auto rounded-splash-sm border border-gray-light bg-white shadow-splash-card"
        >
          {results.map((row, idx) => {
            const isActive = idx === activeIndex;
            const updated = formatUpdated(row.updated_at);
            const am = row.area_manager ?? "—";
            const rm = row.regional_manager ?? "—";
            return (
              <li
                key={String(row.id)}
                id={`${optionIdPrefix}-opt-${idx}`}
                role="option"
                aria-selected={isActive}
                className={`cursor-pointer px-3 py-2 text-sm ${
                  isActive
                    ? "bg-sudsy-blue-soft text-splash-navy"
                    : "text-splash-navy hover:bg-sudsy-blue-soft/60"
                }`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(row);
                }}
                onMouseEnter={() => setActiveIndex(idx)}
              >
                <div className="flex items-baseline justify-between gap-3">
                  <div className="font-mono font-semibold">
                    #{row.site_number ?? "?"} · {row.site ?? "(no site name)"}
                  </div>
                  {updated ? (
                    <div className="shrink-0 text-[10px] uppercase tracking-wider text-splash-navy/50">
                      Updated {updated}
                    </div>
                  ) : null}
                </div>
                <div className="text-xs text-splash-navy/60">
                  {am} / {rm}
                  {row.location ? <span> · {row.location}</span> : null}
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
