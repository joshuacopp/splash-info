// Brief 143 — shared client island for searchable location grids on
// /admin/pricing and /admin/signups.
//
// Replicates the legacy admin's `.toolbar` + `#locationSearch` +
// `#locationCount` filter (legacy/signupworker.js:1721-1756) on top of
// the apps/web grid that both Signup Admin landing pages render. Filter
// matches case-insensitive substring against `location_pretty` OR
// `location_code`. Count badge surfaces only when the query is
// non-empty — empty query shows the bare grid (parity with legacy).
//
// Tile styling follows signups/page.tsx (canonical block + hover
// treatment). Grid layout follows the inline-style preset both pages
// already use (`repeat(auto-fill, minmax(220px, 1fr))`, `gap: 12`).

"use client";

import Link from "next/link";
import {
  type ReactNode,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";

export interface LocationItem {
  location_code: string;
  location_pretty: string;
  /** Pre-resolved per-item link target — server component builds the
   *  string so the client doesn't receive a non-serializable closure. */
  href: string;
  /** Free-form secondary line. Pricing passes `Mode: <pricing>`;
   *  Signups passes the `location_code` slug. */
  secondaryLine: ReactNode;
}

export interface LocationSearchGridProps {
  locations: LocationItem[];
  /** Optional placeholder; defaults to "Search locations…". */
  placeholder?: string;
}

export default function LocationSearchGrid({
  locations,
  placeholder = "Search locations…"
}: LocationSearchGridProps) {
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const filtered = useMemo(() => {
    const q = deferredQuery.trim().toLowerCase();
    if (!q) return locations;
    return locations.filter(
      (loc) =>
        loc.location_pretty.toLowerCase().includes(q) ||
        loc.location_code.toLowerCase().includes(q)
    );
  }, [deferredQuery, locations]);

  const trimmedQuery = query.trim();
  const showCountBadge = trimmedQuery.length > 0;

  return (
    <div>
      <div className="mb-3 flex flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:gap-3">
        <input
          ref={inputRef}
          type="search"
          inputMode="search"
          autoComplete="off"
          spellCheck={false}
          placeholder={placeholder}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          aria-label="Search locations"
          className="w-full rounded-splash-sm border-[1.5px] border-gray-light bg-white px-3 py-2 text-sm text-splash-navy placeholder:text-splash-navy/40 focus:border-splash-navy focus:outline-none sm:max-w-[360px]"
        />
        {showCountBadge && (
          <span
            className="text-xs text-splash-navy/60"
            role="status"
            aria-live="polite"
          >
            {filtered.length} of {locations.length}
          </span>
        )}
      </div>

      {filtered.length === 0 ? (
        <p className="text-sm text-splash-navy/60">
          No locations match &lsquo;{trimmedQuery}&rsquo;.
        </p>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
            gap: 12
          }}
        >
          {filtered.map((loc) => (
            <Link
              key={loc.location_code}
              href={loc.href}
              className="block rounded-splash-md border border-gray-light bg-white px-4 py-3 text-splash-navy hover:border-splash-blue/50 hover:shadow-splash-card-hover"
            >
              <div className="font-bold">{loc.location_pretty}</div>
              <div className="mt-0.5">{loc.secondaryLine}</div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
