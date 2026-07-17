"use client";

// Friendly permissions viewer for the Manage Users hub. Replaces the
// operator's need to eyeball the raw `auth_unified` view: pick a user by
// email, then see one human-readable panel of everything they can touch —
// role + pricing/schedule locations, granted tools, claims (dc) role +
// its locations, and promo role — with inline remove (✕) affordances.
//
// Reads (client-side, same posture as UserPicker):
//         GET /sysadmin/api/users?q=...                  (email typeahead, Brief 18)
//         GET /sysadmin/api/users/{userId}/permissions   (full auth_unified row)
//
// Writes (inline ✕) go through server actions in ../actions.ts —
// viewerRevokeToolAction / viewerRemoveLocationAction /
// viewerRemoveDcLocationAction — NOT direct client fetches. This reuses the
// proven sysadminPostJson transport (service binding in prod, Origin header
// set for the worker's isOriginAllowed CSRF gate), matching every other
// sysadmin mutation. On success the client re-runs the permissions GET so the
// removed chip disappears and trigger side effects are reflected.

import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  viewerRemoveDcLocationAction,
  viewerRemoveLocationAction,
  viewerRevokeToolAction
} from "../actions";

// Structural copy of the server actions' return shape. Kept local because a
// "use server" module can't export non-function values (see ../actions.ts).
interface ViewerActionResult {
  ok: boolean;
  error?: string;
  changed?: boolean;
}

interface UserSearchRow {
  user_id: string;
  email: string;
  role: string | null;
  tools: string[];
  must_change_password: boolean;
}

/** Normalized permissions panel. auth_unified array columns arrive as
 *  text-encoded JSON ("[\"a\",\"b\"]") from the view, so we parse defensively. */
interface Permissions {
  user_id: string;
  email: string;
  role: string | null;
  locations: string[];
  must_change_password: boolean;
  tools: string[];
  dc_role: string | null;
  dc_locations: string[];
  promo_role: string | null;
}

/** auth_unified array columns can come back as a real array or a JSON string. */
function parseArr(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  if (typeof value === "string" && value.trim().length > 0) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed.filter((v): v is string => typeof v === "string");
      }
    } catch {
      /* fall through */
    }
  }
  return [];
}

function normalize(raw: Record<string, unknown>): Permissions {
  return {
    user_id: typeof raw.user_id === "string" ? raw.user_id : "",
    email: typeof raw.email === "string" ? raw.email : "",
    role: typeof raw.role === "string" ? raw.role : null,
    locations: parseArr(raw.locations),
    must_change_password: raw.must_change_password === true,
    tools: parseArr(raw.tools),
    dc_role: typeof raw.dc_role === "string" ? raw.dc_role : null,
    dc_locations: parseArr(raw.dc_locations),
    promo_role: typeof raw.promo_role === "string" ? raw.promo_role : null
  };
}

const inputCls =
  "w-full rounded-splash-sm border border-gray-light bg-white px-3 py-2 text-sm text-splash-navy shadow-inner placeholder:text-splash-navy/40 focus:border-splash-blue focus:outline-none focus:ring-1 focus:ring-splash-blue";

export function PermissionsViewer() {
  const listboxId = useId();
  const optionIdPrefix = useId();

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<UserSearchRow[]>([]);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);

  const [perms, setPerms] = useState<Permissions | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const debounceRef = useRef<number | null>(null);
  const fetchSeqRef = useRef(0);
  const containerRef = useRef<HTMLDivElement>(null);

  // Email typeahead (mirrors UserPicker).
  useEffect(() => {
    if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      setResults([]);
      setOpen(false);
      setActiveIndex(-1);
      return;
    }
    debounceRef.current = window.setTimeout(async () => {
      const seq = ++fetchSeqRef.current;
      try {
        const resp = await fetch(`/sysadmin/api/users?q=${encodeURIComponent(trimmed)}`, {
          method: "GET",
          credentials: "include",
          cache: "no-store"
        });
        if (seq !== fetchSeqRef.current) return;
        if (!resp.ok) {
          setResults([]);
          setOpen(false);
          setActiveIndex(-1);
          return;
        }
        const rows = (await resp.json()) as UserSearchRow[];
        if (seq !== fetchSeqRef.current) return;
        setResults(rows);
        setOpen(rows.length > 0);
        setActiveIndex(rows.length > 0 ? 0 : -1);
      } catch {
        if (seq !== fetchSeqRef.current) return;
        setResults([]);
        setOpen(false);
        setActiveIndex(-1);
      }
    }, 250);
    return () => {
      if (debounceRef.current !== null) {
        window.clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    };
  }, [query]);

  // Close typeahead on outside click.
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

  async function loadPermissions(userId: string) {
    setLoading(true);
    setError(null);
    try {
      const resp = await fetch(
        `/sysadmin/api/users/${encodeURIComponent(userId)}/permissions`,
        { method: "GET", credentials: "include", cache: "no-store" }
      );
      if (!resp.ok) {
        setPerms(null);
        setError(
          resp.status === 404
            ? "No permissions row for this user."
            : `Load failed (${resp.status}).`
        );
        return;
      }
      const raw = (await resp.json()) as Record<string, unknown>;
      setPerms(normalize(raw));
    } catch (err) {
      setPerms(null);
      setError(err instanceof Error ? err.message : "Load failed.");
    } finally {
      setLoading(false);
    }
  }

  function pick(row: UserSearchRow) {
    setQuery("");
    setResults([]);
    setOpen(false);
    setActiveIndex(-1);
    void loadPermissions(row.user_id);
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

  // Shared runner for the inline ✕ actions. Calls a server action (which
  // runs the sysadminPostJson transport), then re-loads the panel on success
  // so the removed chip disappears and any trigger side effects are reflected.
  async function runAction(
    key: string,
    confirmMsg: string,
    fn: () => Promise<ViewerActionResult>
  ) {
    if (!perms) return;
    if (!window.confirm(confirmMsg)) return;
    setBusyKey(key);
    setError(null);
    try {
      const res = await fn();
      if (!res.ok) {
        setError(`Action failed: ${res.error ?? "unknown error"}`);
        return;
      }
      await loadPermissions(perms.user_id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed.");
    } finally {
      setBusyKey(null);
    }
  }

  function removeTool(tool: string) {
    if (!perms) return;
    const userId = perms.user_id;
    void runAction(
      `tool:${tool}`,
      `Revoke the "${tool}" tool from ${perms.email}?`,
      () => viewerRevokeToolAction(userId, tool)
    );
  }

  function removeLocation(code: string) {
    if (!perms) return;
    const userId = perms.user_id;
    void runAction(
      `loc:${code}`,
      `Remove pricing/schedule access to "${code}" from ${perms.email}?`,
      () => viewerRemoveLocationAction(userId, code)
    );
  }

  function removeDcLocation(code: string) {
    if (!perms || !perms.dc_role) return;
    const userId = perms.user_id;
    const dcRole = perms.dc_role;
    const remaining = perms.dc_locations.filter((c) => c !== code);
    void runAction(
      `dc:${code}`,
      `Remove claims access to "${code}" from ${perms.email}?`,
      () => viewerRemoveDcLocationAction(userId, dcRole, remaining)
    );
  }

  const activeOptionId = useMemo(
    () =>
      open && activeIndex >= 0 ? `${optionIdPrefix}-opt-${activeIndex}` : undefined,
    [open, activeIndex, optionIdPrefix]
  );

  return (
    <div className="space-y-4">
      {/* Email typeahead */}
      <div ref={containerRef} className="relative">
        <input
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={activeOptionId}
          autoComplete="off"
          value={query}
          placeholder="Search a user by email…"
          className={inputCls}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          onFocus={() => {
            if (results.length > 0) setOpen(true);
          }}
        />
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
                    {row.role ?? "no role"}
                    {row.tools && row.tools.length > 0
                      ? ` · ${row.tools.join(", ")}`
                      : " · no tools"}
                  </div>
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>

      {loading ? (
        <div className="text-sm text-splash-navy/60">Loading permissions…</div>
      ) : null}

      {error ? (
        <div className="rounded-splash-sm border border-splash-deny/30 bg-splash-deny/5 px-3 py-2 text-xs text-splash-deny">
          {error}
        </div>
      ) : null}

      {perms ? <PermissionsPanel
        perms={perms}
        busyKey={busyKey}
        onRemoveTool={removeTool}
        onRemoveLocation={removeLocation}
        onRemoveDcLocation={removeDcLocation}
      /> : null}
    </div>
  );
}

/* ---------- presentational panel ---------- */

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-splash-navy/70">
        {title}
      </div>
      {children}
    </div>
  );
}

function Chip({
  label,
  onRemove,
  busy,
  tone = "blue"
}: {
  label: string;
  onRemove?: () => void;
  busy?: boolean;
  tone?: "blue" | "green" | "amber";
}) {
  const tones: Record<string, string> = {
    blue: "border-sudsy-blue/30 bg-sudsy-blue-soft/40 text-splash-navy",
    green: "border-emerald-300 bg-emerald-50 text-emerald-800",
    amber: "border-amber-300 bg-amber-50 text-amber-800"
  };
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs ${tones[tone]}`}
    >
      <span className="font-mono">{label}</span>
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          disabled={busy}
          aria-label={`Remove ${label}`}
          className="ml-0.5 text-splash-navy/50 hover:text-splash-deny disabled:opacity-40"
        >
          {busy ? "…" : "✕"}
        </button>
      ) : null}
    </span>
  );
}

function RoleBadge({ role }: { role: string | null }) {
  if (!role) return <span className="text-sm text-splash-navy/50">No role</span>;
  const isSuper = role === "super_admin";
  return (
    <span
      className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold ${
        isSuper
          ? "border-amber-300 bg-amber-50 text-amber-800"
          : "border-sudsy-blue/30 bg-sudsy-blue-soft/40 text-splash-navy"
      }`}
    >
      {role}
    </span>
  );
}

function PermissionsPanel({
  perms,
  busyKey,
  onRemoveTool,
  onRemoveLocation,
  onRemoveDcLocation
}: {
  perms: Permissions;
  busyKey: string | null;
  onRemoveTool: (tool: string) => void;
  onRemoveLocation: (code: string) => void;
  onRemoveDcLocation: (code: string) => void;
}) {
  const isSuper = perms.role === "super_admin";
  const dcIsGlobal = perms.dc_role === "super_admin" || perms.dc_role === "admin";

  return (
    <div className="space-y-5 rounded-splash-lg border border-gray-light bg-sudsy-blue-soft/10 p-4">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-base font-bold text-splash-navy">{perms.email}</span>
        <RoleBadge role={perms.role} />
        {perms.must_change_password ? (
          <span className="inline-flex rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[0.6875rem] font-semibold text-amber-800">
            must change password
          </span>
        ) : null}
        <span className="font-mono text-[10px] text-splash-navy/40">{perms.user_id}</span>
      </div>

      {/* Pricing & schedule */}
      <Section title="Pricing & schedule locations">
        {isSuper ? (
          <span className="text-sm text-splash-navy/70">All locations (super admin)</span>
        ) : perms.role === "location_admin" ? (
          perms.locations.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {perms.locations.map((code) => (
                <Chip
                  key={code}
                  label={code}
                  busy={busyKey === `loc:${code}`}
                  onRemove={() => onRemoveLocation(code)}
                />
              ))}
            </div>
          ) : (
            <span className="text-sm text-splash-navy/50">
              location_admin with no locations assigned
            </span>
          )
        ) : (
          <span className="text-sm text-splash-navy/50">No pricing/schedule scope</span>
        )}
      </Section>

      {/* Tools */}
      <Section title="Tools">
        {perms.tools.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {perms.tools.map((tool) => (
              <Chip
                key={tool}
                label={tool}
                tone="green"
                busy={busyKey === `tool:${tool}`}
                onRemove={() => onRemoveTool(tool)}
              />
            ))}
          </div>
        ) : (
          <span className="text-sm text-splash-navy/50">No tools granted</span>
        )}
      </Section>

      {/* Claims (damage) */}
      <Section title="Claims access">
        {perms.dc_role ? (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-xs text-splash-navy/60">Role:</span>
              <span className="inline-flex rounded-full border border-amber-300 bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-800">
                {perms.dc_role}
              </span>
            </div>
            {dcIsGlobal ? (
              <span className="text-sm text-splash-navy/70">All locations ({perms.dc_role})</span>
            ) : perms.dc_locations.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {perms.dc_locations.map((code) => (
                  <Chip
                    key={code}
                    label={code}
                    tone="amber"
                    busy={busyKey === `dc:${code}`}
                    onRemove={() => onRemoveDcLocation(code)}
                  />
                ))}
              </div>
            ) : (
              <span className="text-sm text-splash-navy/50">No claims locations</span>
            )}
          </div>
        ) : (
          <span className="text-sm text-splash-navy/50">No claims role</span>
        )}
      </Section>

      {/* Promotions */}
      <Section title="Promotions">
        {perms.promo_role ? (
          <span className="inline-flex rounded-full border border-sudsy-blue/30 bg-sudsy-blue-soft/40 px-2.5 py-1 text-xs font-semibold text-splash-navy">
            {perms.promo_role}
          </span>
        ) : (
          <span className="text-sm text-splash-navy/50">No promo role</span>
        )}
      </Section>

      <p className="text-[0.6875rem] text-splash-navy/40">
        Removing a pricing/schedule location that was assigned via a site-email
        trigger may be re-added on the next locations/pricing edit. Tool and
        claims changes take effect on the user&rsquo;s next sign-in.
      </p>
    </div>
  );
}
