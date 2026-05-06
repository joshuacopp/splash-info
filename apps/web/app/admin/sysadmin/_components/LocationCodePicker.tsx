"use client";

// Location-code typeahead used by the Set role card on /admin/sysadmin
// (Brief 39). Replaces the free-text location_code input that required
// operators to remember the exact slug (~67 locations, with
// underscore-vs-no-separator drift). Hits
//   GET /sysadmin/api/pricing-simple/locations?q=...
// which returns DISTINCT (location_code, location_pretty, site) rows.
//
// Mirrors the UserPicker pattern (Brief 18):
//   - debounced fetch (250ms)
//   - hidden input carries the canonical location_code (form serializes it)
//   - empty query closes the dropdown without firing a request
//   - failure surfaces a small error note below the input
//   - combobox + listbox aria roles + arrow key nav + Esc + outside-click dismiss

import { useEffect, useId, useMemo, useRef, useState } from "react";

interface LocationCodePickerProps {
  /** Form field name for the hidden input that carries the selected location_code. */
  name: string;
  /** Forwarded to the visible input for FieldLabel htmlFor pairing. */
  inputId: string;
  /** Hidden input is `required` when true. */
  required?: boolean;
  /** Pre-fill (used by edit-style forms; unused on the Set role card today). */
  initialValue?: string;
}

interface LocationCodeSearchRow {
  location_code: string;
  location_pretty: string | null;
  site: string | null;
}

function formatChip(row: LocationCodeSearchRow): string {
  const sitePart = row.site ? `#${row.site}` : "";
  const prettyPart = row.location_pretty ?? row.location_code;
  return [sitePart, prettyPart].filter(Boolean).join(" ");
}

export function LocationCodePicker({
  name,
  inputId,
  required,
  initialValue
}: LocationCodePickerProps) {
  const listboxId = useId();
  const optionIdPrefix = useId();

  const [selected, setSelected] = useState<LocationCodeSearchRow | null>(() =>
    initialValue
      ? { location_code: initialValue, location_pretty: null, site: null }
      : null
  );
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<LocationCodeSearchRow[]>([]);
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
        const url = `/sysadmin/api/pricing-simple/locations?q=${encodeURIComponent(trimmed)}`;
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

        const rows = (await resp.json()) as LocationCodeSearchRow[];
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

  function pick(row: LocationCodeSearchRow) {
    setSelected(row);
    setQuery("");
    setResults([]);
    setOpen(false);
    setActiveIndex(-1);
  }

  function clear() {
    setSelected(null);
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
      setActiveIndex((idx) =>
        idx <= 0 ? results.length - 1 : idx - 1
      );
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
        type="hidden"
        name={name}
        value={selected ? selected.location_code : ""}
        required={required}
      />

      {selected ? (
        <div className="flex flex-wrap items-center gap-2 rounded-splash-sm border border-sudsy-blue/30 bg-sudsy-blue-soft/40 px-2.5 py-1.5 text-xs text-splash-navy">
          <span className="font-semibold">Selected:</span>
          <span>{formatChip(selected)}</span>
          <span className="font-mono text-[10px] text-splash-navy/60">
            {selected.location_code}
          </span>
          <button
            type="button"
            onClick={clear}
            className="ml-auto text-splash-blue underline-offset-2 hover:text-splash-blue-dark hover:underline"
          >
            × Clear
          </button>
        </div>
      ) : (
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
          placeholder="Type a site #, name, or code — e.g. 111, Binghamton, batavia_veterans…"
          className={inputCls}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          onFocus={() => {
            if (results.length > 0) setOpen(true);
          }}
        />
      )}

      {errorMessage ? (
        <div className="mt-1 text-xs text-splash-deny">{errorMessage}</div>
      ) : null}

      {open && results.length > 0 && !selected ? (
        <ul
          id={listboxId}
          role="listbox"
          className="absolute left-0 right-0 z-20 mt-1 max-h-72 overflow-y-auto rounded-splash-sm border border-gray-light bg-white shadow-splash-card"
        >
          {results.map((row, idx) => {
            const isActive = idx === activeIndex;
            return (
              <li
                key={row.location_code}
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
                <div className="flex flex-wrap items-baseline gap-x-2">
                  {row.site ? (
                    <span className="font-semibold">#{row.site}</span>
                  ) : null}
                  <span>{row.location_pretty ?? row.location_code}</span>
                  <span className="font-mono text-[11px] text-splash-navy/60">
                    {row.location_code}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
