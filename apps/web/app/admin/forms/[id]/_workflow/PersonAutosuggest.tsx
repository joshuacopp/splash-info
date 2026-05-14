// Brief 125 — org directory autosuggest input.
//
// Queries the new `GET /forms/admin/api/users/search?q=` endpoint. Used
// inside the "Who approves?" picker when the operator picks Specific
// person or Multiple people. 200 ms debounce on input changes.

"use client";

import { useEffect, useRef, useState } from "react";

export interface UserSuggestion {
  email: string;
  full_name?: string | null;
  dc_role?: string | null;
}

interface Props {
  placeholder?: string;
  initialQuery?: string;
  onPick: (email: string) => void;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function PersonAutosuggest({
  placeholder,
  initialQuery = "",
  onPick
}: Props) {
  const [query, setQuery] = useState(initialQuery);
  const [results, setResults] = useState<UserSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!query || query.length < 2) {
      setResults([]);
      setErr(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const resp = await fetch(
          `/forms/admin/api/users/search?q=${encodeURIComponent(query)}`,
          { credentials: "same-origin", cache: "no-store" }
        );
        if (!resp.ok) {
          if (!cancelled) {
            setErr(`HTTP ${resp.status}`);
            setResults([]);
          }
          return;
        }
        const data = (await resp.json()) as { users?: UserSuggestion[] };
        if (!cancelled) {
          setResults(Array.isArray(data.users) ? data.users : []);
          setErr(null);
        }
      } catch (e) {
        if (!cancelled) {
          setErr(e instanceof Error ? e.message : String(e));
          setResults([]);
        }
      }
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  // Click-outside closes the popover.
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (!boxRef.current) return;
      if (e.target instanceof Node && !boxRef.current.contains(e.target)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  function commitRaw() {
    const raw = query.trim().toLowerCase();
    if (!EMAIL_RE.test(raw)) return;
    onPick(raw);
    setQuery("");
    setResults([]);
    setOpen(false);
  }

  return (
    <div ref={boxRef} className="relative">
      <input
        type="text"
        value={query}
        onChange={(e) => {
          setQuery(e.currentTarget.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commitRaw();
          }
        }}
        placeholder={placeholder ?? "Type a name or email…"}
        className="w-full rounded-splash-sm border border-gray-light bg-white px-2 py-1.5 text-sm text-splash-navy"
        spellCheck={false}
        autoComplete="off"
      />
      {open && (results.length > 0 || err) && (
        <ul className="absolute z-10 mt-1 max-h-64 w-full overflow-auto rounded-splash-sm border border-gray-light bg-white shadow-lg">
          {err && (
            <li className="px-2 py-1.5 text-xs text-racecar-red">
              Search failed: {err}
            </li>
          )}
          {results.map((u) => (
            <li key={u.email}>
              <button
                type="button"
                onClick={() => {
                  onPick(u.email);
                  setQuery("");
                  setResults([]);
                  setOpen(false);
                }}
                className="block w-full px-2 py-1.5 text-left text-sm text-splash-navy hover:bg-splash-blue/10"
              >
                <span className="font-semibold">{u.email}</span>
                {u.full_name && (
                  <span className="ml-2 text-xs text-splash-navy/60">
                    {u.full_name}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
      {query && EMAIL_RE.test(query.trim()) && results.length === 0 && !err && (
        <p className="mt-1 text-[0.65rem] text-splash-navy/60">
          Press Enter to add <code className="font-mono">{query.trim().toLowerCase()}</code>.
        </p>
      )}
    </div>
  );
}
