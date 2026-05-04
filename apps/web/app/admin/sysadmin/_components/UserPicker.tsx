"use client";

// Email typeahead used by the four user-targeted forms on /admin/sysadmin
// (Set role, Grant tool, Revoke tool, Reset password). Hits
// /sysadmin/api/users?q=... — the sysadmin-worker returns up to 20 matches.
//
// Mirrors the LocationPicker pattern from Brief 6:
//   - debounced fetch
//   - hidden input carries the selected user_id (form serializes it)
//   - empty query closes the dropdown without firing a request
//   - failure surfaces a small error note below the input
//   - combobox + listbox aria roles + arrow key nav + Esc + outside-click dismiss
//
// URL is relative ("/sysadmin/api/users?q=..."): same posture as
// LocationPicker — production is same-origin, dev relies on next.config.mjs
// rewrites proxying /sysadmin/api/:path* to NEXT_PUBLIC_SYSADMIN_WORKER_URL
// when set.

import { useEffect, useId, useMemo, useRef, useState } from "react";

interface UserPickerProps {
  /** Form field name for the hidden input that carries the selected user_id. */
  name: string;
  /** Pre-selected user_id (for edit-style forms; unused on the v1 cards). */
  defaultValue?: string;
  /** Pre-selected display label paired with defaultValue (typically the email). */
  defaultLabel?: string;
  /** Visible input placeholder. */
  placeholder?: string;
  /** Hidden input is `required` when true (true on every sysadmin card). */
  required?: boolean;
  /** Optional id forwarded to the visible input — pairs with FieldLabel htmlFor. */
  inputId?: string;
}

interface UserSearchRow {
  user_id: string;
  email: string;
  role: string | null;
  tools: string[];
  must_change_password: boolean;
}

interface SelectedUser {
  user_id: string;
  email: string;
  role: string | null;
  tools: string[];
}

function summariseGrants(row: { role: string | null; tools: string[] }): string {
  const parts: string[] = [];
  parts.push(row.role ? row.role : "no role");
  if (row.tools && row.tools.length > 0) {
    parts.push(`tools: ${row.tools.join(", ")}`);
  } else {
    parts.push("no tools");
  }
  return parts.join(" · ");
}

export function UserPicker({
  name,
  defaultValue,
  defaultLabel,
  placeholder,
  required,
  inputId
}: UserPickerProps) {
  const listboxId = useId();
  const optionIdPrefix = useId();

  const [selected, setSelected] = useState<SelectedUser | null>(() =>
    defaultValue && defaultLabel
      ? { user_id: defaultValue, email: defaultLabel, role: null, tools: [] }
      : null
  );
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<UserSearchRow[]>([]);
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
        const url = `/sysadmin/api/users?q=${encodeURIComponent(trimmed)}`;
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

        const rows = (await resp.json()) as UserSearchRow[];
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

  function pick(row: UserSearchRow) {
    setSelected({
      user_id: row.user_id,
      email: row.email,
      role: row.role,
      tools: row.tools ?? []
    });
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
        value={selected ? selected.user_id : ""}
        required={required}
      />

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
        placeholder={placeholder ?? "Type an email — e.g. alice@splash…"}
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
          <span>{selected.email}</span>
          <span className="text-splash-navy/60">
            ({summariseGrants({ role: selected.role, tools: selected.tools })})
          </span>
          <span className="font-mono text-[10px] text-splash-navy/50">
            {selected.user_id}
          </span>
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
            return (
              <li
                key={row.user_id}
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
                <div className="font-semibold">{row.email}</div>
                <div className="text-xs text-splash-navy/60">
                  {summariseGrants(row)}
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
