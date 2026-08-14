"use client";

// Reset MFA card (lost-device recovery) for the Manage Users hub.
//
// Standalone from Reset password (Josh's call): losing a phone and needing a
// password reset are unrelated events, and bundling them would force an
// unnecessary password change on every device swap.
//
// Flow: pick a user by email → we read their current factor status
// (enrolled / none) so the operator sees what they're about to clear → a
// destructive "Reset MFA" button (guarded by window.confirm) calls the
// resetMfaAction server action, which deletes ALL of the user's factors. With
// no verified factor left, the enrollment countdown forces a fresh enroll on
// the user's next login.
//
// super_admin-only: the sysadmin-worker's single gate at the top of fetch()
// covers both the status read and the reset. This component is only rendered
// on /admin/sysadmin, which is already super_admin-gated.
//
// Reads (client-side, same posture as UserPicker / PermissionsViewer):
//   GET /sysadmin/api/users?q=...                    (email typeahead)
//   GET /sysadmin/api/users/{userId}/mfa-factors     (factor status)
// Write goes through the resetMfaAction server action (sysadminPostJson
// transport — service binding in prod, Origin header set for the worker's
// CSRF gate), NOT a direct client fetch.

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { resetMfaAction } from "../actions";
import type { ActionResult } from "../../_components/ActionForm";

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
}

/** Shape of GET /sysadmin/api/users/{id}/mfa-factors (handleGetMfaFactors). */
interface FactorStatus {
  enrolled: boolean;
  count: number;
}

const inputCls =
  "w-full rounded-splash-sm border border-gray-light bg-white px-3 py-2 text-sm text-splash-navy shadow-inner placeholder:text-splash-navy/40 focus:border-splash-blue focus:outline-none focus:ring-1 focus:ring-splash-blue";

export function ResetMfaCard() {
  const listboxId = useId();
  const optionIdPrefix = useId();

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<UserSearchRow[]>([]);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);

  const [selected, setSelected] = useState<SelectedUser | null>(null);
  const [status, setStatus] = useState<FactorStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);

  const [result, setResult] = useState<ActionResult | null>(null);
  const [resetting, setResetting] = useState(false);

  const debounceRef = useRef<number | null>(null);
  const fetchSeqRef = useRef(0);
  const containerRef = useRef<HTMLDivElement>(null);

  // Email typeahead (mirrors UserPicker / PermissionsViewer).
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

  async function loadStatus(userId: string) {
    setStatusLoading(true);
    setStatusError(null);
    setStatus(null);
    try {
      const resp = await fetch(
        `/sysadmin/api/users/${encodeURIComponent(userId)}/mfa-factors`,
        { method: "GET", credentials: "include", cache: "no-store" }
      );
      if (!resp.ok) {
        setStatusError(`Couldn't read MFA status (${resp.status}).`);
        return;
      }
      const raw = (await resp.json()) as { enrolled?: boolean; count?: number };
      setStatus({
        enrolled: raw.enrolled === true,
        count: typeof raw.count === "number" ? raw.count : 0
      });
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : "Couldn't read MFA status.");
    } finally {
      setStatusLoading(false);
    }
  }

  function pick(row: UserSearchRow) {
    setSelected({ user_id: row.user_id, email: row.email });
    setQuery("");
    setResults([]);
    setOpen(false);
    setActiveIndex(-1);
    setResult(null);
    void loadStatus(row.user_id);
  }

  function clear() {
    setSelected(null);
    setStatus(null);
    setStatusError(null);
    setResult(null);
  }

  async function onReset() {
    if (!selected) return;
    const confirmed = window.confirm(
      `Reset MFA for ${selected.email}?\n\n` +
        "This deletes all of their authenticator factors. They'll be required " +
        "to set up MFA again the next time they sign in. Use this only when " +
        "the user has lost access to their authenticator device."
    );
    if (!confirmed) return;

    setResetting(true);
    setResult(null);
    try {
      const fd = new FormData();
      fd.set("user_id", selected.user_id);
      const res = await resetMfaAction(null, fd);
      setResult(res);
      if (res.ok) {
        // Re-read so the status line reflects the now-cleared factors.
        await loadStatus(selected.user_id);
      }
    } catch (err) {
      setResult({
        ok: false,
        error: err instanceof Error ? err.message : "Reset failed."
      });
    } finally {
      setResetting(false);
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
    () => (open && activeIndex >= 0 ? `${optionIdPrefix}-opt-${activeIndex}` : undefined),
    [open, activeIndex, optionIdPrefix]
  );

  // Nothing to delete → disable the destructive button (idempotent no-op, but
  // clearer UX to gray it out and say so).
  const nothingToReset = status !== null && status.count === 0;

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
                  </div>
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>

      {selected ? (
        <div className="space-y-3 rounded-splash-lg border border-gray-light bg-sudsy-blue-soft/10 p-4">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="text-sm font-bold text-splash-navy">{selected.email}</span>
            <button
              type="button"
              onClick={clear}
              className="ml-auto text-xs text-splash-blue underline-offset-2 hover:text-splash-blue-dark hover:underline"
            >
              Clear
            </button>
          </div>

          {/* MFA status line */}
          <div className="text-sm">
            <span className="text-xs font-semibold uppercase tracking-wider text-splash-navy/70">
              MFA:{" "}
            </span>
            {statusLoading ? (
              <span className="text-splash-navy/60">checking…</span>
            ) : statusError ? (
              <span className="text-splash-deny">{statusError}</span>
            ) : status ? (
              status.enrolled ? (
                <span className="inline-flex rounded-full border border-emerald-300 bg-emerald-50 px-2.5 py-0.5 text-xs font-semibold text-emerald-800">
                  Enrolled
                  {status.count > 1 ? ` · ${status.count} factors` : ""}
                </span>
              ) : status.count > 0 ? (
                <span className="inline-flex rounded-full border border-amber-300 bg-amber-50 px-2.5 py-0.5 text-xs font-semibold text-amber-800">
                  Enrollment started (unverified)
                </span>
              ) : (
                <span className="inline-flex rounded-full border border-gray-light bg-gray-50 px-2.5 py-0.5 text-xs font-semibold text-splash-navy/60">
                  None
                </span>
              )
            ) : null}
          </div>

          <button
            type="button"
            onClick={onReset}
            disabled={resetting || statusLoading || nothingToReset}
            className="h-10 rounded-splash-sm border border-splash-deny bg-splash-deny px-4 text-sm font-bold text-white shadow-splash-btn transition-colors hover:bg-splash-deny/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {resetting ? "Resetting…" : "Reset MFA"}
          </button>

          {nothingToReset ? (
            <p className="text-xs text-splash-navy/50">
              This user has no MFA factors — nothing to reset.
            </p>
          ) : null}

          {result?.ok ? (
            <p role="status" className="text-sm font-semibold text-splash-success">
              {result.message ?? "MFA reset."}
            </p>
          ) : null}
          {result && !result.ok ? (
            <p
              role="alert"
              className="rounded-splash-sm border border-splash-deny/40 bg-splash-deny/10 px-3 py-2 text-sm font-medium text-splash-deny"
            >
              {result.error}
            </p>
          ) : null}
        </div>
      ) : (
        <p className="text-xs text-splash-navy/50">
          Search for a user to see their MFA status and reset it if they&rsquo;ve
          lost their authenticator device.
        </p>
      )}
    </div>
  );
}
