"use client";

// Location typeahead used by both the filter bar and the new-submission
// form on /admin/performance. Hits /pertrack/api/locations?q=... — the
// performance-worker returns up to 20 matches.
//
// Posture: the only client-side interactivity in Brief 6. Stays small —
// debounced fetch, hidden id input that the surrounding <form> serializes
// when submitted.
//
// URL is relative ("/pertrack/api/locations?q=..."): in dev with
// NEXT_PUBLIC_PERFORMANCE_WORKER_URL set, next.config.mjs rewrites proxy
// it server-side so the browser stays same-origin and cookies follow; in
// prod the route binding sends it to the worker directly. This is the
// same posture as the cross-origin/same-origin fork in worker-fetch.ts.

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { SupabaseLocationRow } from "@splash/types/locations";

interface LocationPickerProps {
  /** Form field name for the hidden input that carries the selected id. */
  name: string;
  /** Pre-selected location id (e.g., from filter persistence on GET form). */
  defaultValue?: number;
  /** Pre-selected display label paired with defaultValue. */
  defaultLabel?: string;
  /** Visible input placeholder. */
  placeholder?: string;
  /** Hidden input is `required` when true (used in the new-submission form). */
  required?: boolean;
}

interface SelectedLocation {
  id: number;
  label: string;
}

function formatRowLabel(row: SupabaseLocationRow): string {
  // Prefer mla_location/site/location for the human-friendly label, then
  // suffix the site_number for uniqueness (matches the brief's example
  // "BINGHAMTON · 7042"). All Supabase location rows have a site_number.
  const name = row.mla_location || row.site || row.location || "(unnamed)";
  return `${name} · ${row.site_number}`;
}

export function LocationPicker({
  name,
  defaultValue,
  defaultLabel,
  placeholder,
  required
}: LocationPickerProps) {
  const listboxId = useId();
  const optionIdPrefix = useId();

  const [selected, setSelected] = useState<SelectedLocation | null>(() =>
    defaultValue !== undefined && defaultLabel
      ? { id: defaultValue, label: defaultLabel }
      : null
  );
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SupabaseLocationRow[]>([]);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const debounceRef = useRef<number | null>(null);
  const fetchSeqRef = useRef(0);
  const containerRef = useRef<HTMLDivElement>(null);

  // Debounced fetch on query change. Empty query closes the dropdown
  // without firing a request — avoids dumping the worker's 20-row floor.
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
        const url = `/pertrack/api/locations?q=${encodeURIComponent(trimmed)}`;
        const resp = await fetch(url, {
          method: "GET",
          credentials: "include",
          cache: "no-store"
        });
        if (seq !== fetchSeqRef.current) return; // stale response

        if (!resp.ok) {
          // 401/403 -> silent empty (matches GET helper posture); other
          // failures surface a small note below the input.
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

        const rows = (await resp.json()) as SupabaseLocationRow[];
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
        setErrorMessage(
          err instanceof Error ? err.message : "Search failed."
        );
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

  function pick(row: SupabaseLocationRow) {
    const label = formatRowLabel(row);
    setSelected({ id: row.id, label });
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
        pick(results[activeIndex]);
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
    "w-full rounded-splash-sm border border-gray-light bg-white px-3 py-2 text-sm text-splash-navy placeholder:text-splash-navy/40 focus:border-splash-blue focus:outline-none";

  return (
    <div ref={containerRef} className="relative">
      <input
        type="hidden"
        name={name}
        value={selected ? String(selected.id) : ""}
        // `required` on hidden inputs is honored by browsers; keeps the
        // new-submission form from posting without a location_id.
        required={required}
      />

      <input
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-activedescendant={activeOptionId}
        autoComplete="off"
        value={query}
        placeholder={
          placeholder ?? "Search by site number, name, or location code…"
        }
        className={inputCls}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
        onFocus={() => {
          if (results.length > 0) setOpen(true);
        }}
      />

      {selected ? (
        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-splash-navy/80">
          <span className="font-semibold text-splash-navy">Selected:</span>
          <span>{selected.label}</span>
          <button
            type="button"
            onClick={clear}
            className="text-splash-blue underline-offset-2 hover:text-splash-blue-dark hover:underline"
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
            return (
              <li
                key={row.id}
                id={`${optionIdPrefix}-opt-${idx}`}
                role="option"
                aria-selected={isActive}
                className={`cursor-pointer px-3 py-2 text-sm ${
                  isActive
                    ? "bg-sudsy-blue-soft text-splash-navy"
                    : "text-splash-navy hover:bg-sudsy-blue-soft/60"
                }`}
                onMouseDown={(e) => {
                  // mouseDown so the click fires before the input's blur
                  // can collapse the list.
                  e.preventDefault();
                  pick(row);
                }}
                onMouseEnter={() => setActiveIndex(idx)}
              >
                <div className="font-semibold">{formatRowLabel(row)}</div>
                <div className="text-xs text-splash-navy/60">
                  {row.location ?? row.site ?? "(no name)"}
                  {row.regional_manager ? ` · RM ${row.regional_manager}` : ""}
                  {row.area_manager ? ` · AM ${row.area_manager}` : ""}
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
