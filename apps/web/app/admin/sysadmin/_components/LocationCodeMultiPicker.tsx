"use client";

// Multi-select location-code typeahead — sibling to Brief 39's
// LocationCodePicker. Drives the Set DC Role card (Brief 61) where
// gm/rm users need to be scoped to N locations.
//
// Hits GET /sysadmin/api/pricing-simple/locations?q=... (the same Brief 39
// endpoint) for both the typeahead and the on-mount resolution of any
// pre-filled defaultValues.
//
// Submit shape: emits one <input type="hidden" name={name} value={code}>
// per selected location_code so the server-side action reads the array
// via formData.getAll(name).

import { useEffect, useId, useMemo, useRef, useState } from "react";

interface LocationCodeMultiPickerProps {
  /** Form field name; rendered as repeated hidden inputs. */
  name: string;
  /** Forwarded to the visible input's `id` for FieldLabel htmlFor pairing. */
  inputId: string;
  /** Pre-fill (used when editing an existing user's dc_locations). */
  defaultValues?: string[];
  /** Optional placeholder for the search input. */
  placeholder?: string;
  /** Disabled state — used when the chosen role bypasses scoping. */
  disabled?: boolean;
  /**
   * Show the "add a whole region" row above the typeahead. Off by default
   * so the DC-role card keeps its existing, narrower affordance; the
   * user_permissions cards opt in, because that is where somebody gets
   * scoped to thirty sites at once.
   */
  enableRegionAdd?: boolean;
}

interface LocationCodeSearchRow {
  location_code: string;
  location_pretty: string | null;
  site: string | null;
}

interface RegionRosterEntry {
  role: "area_manager" | "regional_manager";
  name: string;
  roleLabel: string;
  count: number;
}

/** Round-trip key for the <select>; the API needs role and name separately. */
function regionKey(r: RegionRosterEntry): string {
  return `${r.role}|${r.name}`;
}

function chipLabel(row: LocationCodeSearchRow): string {
  const sitePart = row.site ? `#${row.site}` : "";
  const prettyPart = row.location_pretty ?? row.location_code;
  return [sitePart, prettyPart].filter(Boolean).join(" ");
}

export function LocationCodeMultiPicker({
  name,
  inputId,
  defaultValues,
  placeholder,
  disabled,
  enableRegionAdd
}: LocationCodeMultiPickerProps) {
  const listboxId = useId();
  const optionIdPrefix = useId();
  const regionSelectId = useId();

  const [selected, setSelected] = useState<LocationCodeSearchRow[]>(() =>
    (defaultValues ?? []).map((code) => ({
      location_code: code,
      location_pretty: null,
      site: null
    }))
  );
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<LocationCodeSearchRow[]>([]);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [roster, setRoster] = useState<RegionRosterEntry[]>([]);
  const [regionChoice, setRegionChoice] = useState("");
  const [regionBusy, setRegionBusy] = useState(false);
  const [regionNote, setRegionNote] = useState<string | null>(null);

  const debounceRef = useRef<number | null>(null);
  const fetchSeqRef = useRef(0);
  const containerRef = useRef<HTMLDivElement>(null);

  // Resolve pretty labels for any pre-filled defaultValues. One call on
  // mount; uses a per-code prefix query and stitches the matching rows
  // back onto the selection state.
  useEffect(() => {
    const codes = (defaultValues ?? []).filter((c) => c.length > 0);
    if (codes.length === 0) return;

    let cancelled = false;
    (async () => {
      try {
        // The search endpoint matches by ilike substring; querying for
        // each unique code-prefix and merging is the simplest way to get
        // the pretty label for an arbitrary list. Failures are silent —
        // the chip falls back to the raw code.
        const merged: Record<string, LocationCodeSearchRow> = {};
        for (const code of codes) {
          const url = `/sysadmin/api/pricing-simple/locations?q=${encodeURIComponent(code)}`;
          const resp = await fetch(url, {
            method: "GET",
            credentials: "include",
            cache: "no-store"
          });
          if (!resp.ok) continue;
          const rows = (await resp.json()) as LocationCodeSearchRow[];
          for (const row of rows) {
            if (codes.includes(row.location_code)) {
              merged[row.location_code] = row;
            }
          }
        }
        if (cancelled) return;
        setSelected((prev) =>
          prev.map((existing) => merged[existing.location_code] ?? existing)
        );
      } catch {
        // Fail-soft — chips fall back to the raw code.
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  function add(row: LocationCodeSearchRow) {
    setSelected((prev) =>
      prev.some((p) => p.location_code === row.location_code)
        ? prev
        : [...prev, row]
    );
    setQuery("");
    setResults([]);
    setOpen(false);
    setActiveIndex(-1);
  }

  function remove(code: string) {
    setSelected((prev) => prev.filter((p) => p.location_code !== code));
  }

  // Region roster — one fetch on mount, only when the affordance is on.
  // Fail-soft: no roster means the <select> stays hidden and the operator
  // falls back to the typeahead rather than seeing a broken control.
  useEffect(() => {
    if (!enableRegionAdd) return;
    let cancelled = false;
    (async () => {
      try {
        const resp = await fetch("/sysadmin/api/pricing-simple/regions", {
          method: "GET",
          credentials: "include",
          cache: "no-store"
        });
        if (!resp.ok || cancelled) return;
        const rows = (await resp.json()) as RegionRosterEntry[];
        if (!cancelled && Array.isArray(rows)) setRoster(rows);
      } catch {
        // Fail-soft.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enableRegionAdd]);

  // Adds every location in a region to the existing selection. Additive by
  // construction — it merges, and each chip keeps its own ✕ — so the
  // operator can pull one site back out rather than restarting.
  async function addRegion() {
    const [role, ...rest] = regionChoice.split("|");
    const name = rest.join("|");
    if (!role || !name) return;

    setRegionBusy(true);
    setRegionNote(null);
    try {
      const url =
        `/sysadmin/api/pricing-simple/regions` +
        `?role=${encodeURIComponent(role)}&name=${encodeURIComponent(name)}`;
      const resp = await fetch(url, {
        method: "GET",
        credentials: "include",
        cache: "no-store"
      });
      if (!resp.ok) {
        setRegionNote(`Could not load that region (${resp.status}).`);
        return;
      }
      const rows = (await resp.json()) as LocationCodeSearchRow[];
      // Diffed against `selected` here rather than inside the updater on
      // purpose: StrictMode invokes a functional updater twice, so a counter
      // assigned in there reads 0 on the second pass and the note lies.
      const have = new Set(selected.map((p) => p.location_code));
      const fresh = rows.filter((r) => !have.has(r.location_code));
      setSelected((prev) => {
        const seen = new Set(prev.map((p) => p.location_code));
        return [...prev, ...fresh.filter((r) => !seen.has(r.location_code))];
      });
      // Report both numbers: "30 sites, 4 already selected" is the difference
      // between a working button and one the operator thinks did nothing.
      const dupes = rows.length - fresh.length;
      setRegionNote(
        fresh.length === 0
          ? `All ${rows.length} already selected.`
          : `Added ${fresh.length} location${fresh.length === 1 ? "" : "s"}` +
            (dupes > 0 ? ` — ${dupes} already selected.` : ".")
      );
    } catch (err) {
      setRegionNote(err instanceof Error ? err.message : "Region add failed.");
    } finally {
      setRegionBusy(false);
    }
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
        add(results[activeIndex]!);
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

  const selectedCodes = new Set(selected.map((s) => s.location_code));
  const filteredResults = results.filter(
    (r) => !selectedCodes.has(r.location_code)
  );

  const inputCls =
    "w-full rounded-splash-sm border border-gray-light bg-white px-3 py-2 text-sm text-splash-navy shadow-inner placeholder:text-splash-navy/40 focus:border-splash-blue focus:outline-none focus:ring-1 focus:ring-splash-blue disabled:cursor-not-allowed disabled:bg-gray-light/40 disabled:text-splash-navy/40";

  return (
    <div ref={containerRef} className="relative">
      {selected.map((row) => (
        <input
          key={row.location_code}
          type="hidden"
          name={name}
          value={row.location_code}
        />
      ))}

      {enableRegionAdd && roster.length > 0 && !disabled ? (
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <label
            htmlFor={regionSelectId}
            className="text-xs font-semibold text-splash-navy/70"
          >
            Add a whole region
          </label>
          <select
            id={regionSelectId}
            value={regionChoice}
            onChange={(e) => {
              setRegionChoice(e.target.value);
              setRegionNote(null);
            }}
            className="rounded-splash-sm border border-gray-light bg-white px-2 py-1.5 text-sm text-splash-navy focus:border-splash-blue focus:outline-none focus:ring-1 focus:ring-splash-blue"
          >
            <option value="">Select a manager…</option>
            {roster.map((r) => (
              <option key={regionKey(r)} value={regionKey(r)}>
                {r.roleLabel}: {r.name} ({r.count})
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={addRegion}
            disabled={regionChoice.length === 0 || regionBusy}
            className="rounded-splash-sm bg-splash-blue px-3 py-1.5 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:bg-gray-light disabled:text-splash-navy/40"
          >
            {regionBusy ? "Adding…" : "Add all"}
          </button>
          {regionNote ? (
            <span className="text-xs text-splash-navy/60">{regionNote}</span>
          ) : null}
        </div>
      ) : null}

      {selected.length > 0 ? (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {selected.map((row) => (
            <span
              key={row.location_code}
              className="inline-flex items-center gap-1.5 rounded-full bg-splash-blue px-2.5 py-1 text-xs font-semibold text-white"
            >
              <span>{chipLabel(row)}</span>
              <span className="font-mono text-[10px] text-white/70">
                {row.location_code}
              </span>
              {!disabled ? (
                <button
                  type="button"
                  onClick={() => remove(row.location_code)}
                  aria-label={`Remove ${row.location_code}`}
                  className="text-white/80 hover:text-white"
                >
                  ×
                </button>
              ) : null}
            </span>
          ))}
        </div>
      ) : null}

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
          placeholder ??
          "Type a site #, name, or code — e.g. 111, Binghamton, batavia_veterans…"
        }
        className={inputCls}
        disabled={disabled}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
        onFocus={() => {
          if (filteredResults.length > 0) setOpen(true);
        }}
      />

      {errorMessage ? (
        <div className="mt-1 text-xs text-splash-deny">{errorMessage}</div>
      ) : null}

      {open && filteredResults.length > 0 && !disabled ? (
        <ul
          id={listboxId}
          role="listbox"
          className="absolute left-0 right-0 z-20 mt-1 max-h-72 overflow-y-auto rounded-splash-sm border border-gray-light bg-white shadow-splash-card"
        >
          {filteredResults.map((row, idx) => {
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
                  add(row);
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
