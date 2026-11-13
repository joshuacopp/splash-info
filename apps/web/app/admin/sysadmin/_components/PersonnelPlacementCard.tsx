// PersonnelPlacementCard — client island on /admin/sysadmin (Manage Tables).
// PLAN_FORMS_PERSONNEL.md phase 1.
//
// Search a Beekeeper employee by name, see the level the system currently
// gives them and where it comes from (placement / title / default), then set
// or clear the override. Empty selects mean "no override"; saving with
// everything empty removes the placement so the Beekeeper title decides.
//
// Search hits GET /sysadmin/api/personnel/search straight from the browser
// (same-origin path carve, same posture as LocationsSearchPicker). Saving goes
// through updatePlacementAction -> PATCH /sysadmin/api/personnel, which
// re-validates everything and writes sysadmin_audit_log.

"use client";

import { useEffect, useRef, useState } from "react";
import { ActionForm, type ActionResult } from "../../_components/ActionForm";
import { updatePlacementAction } from "../actions";

interface PersonRow {
  beekeeper_user_id: string;
  display_name: string | null;
  position: string | null;
  level: number;
  level_source: "placement" | "title" | "default";
  department: string | null;
  works_at: string;
  locations: string[];
  placement: {
    level: number | null;
    department: string | null;
    works_at: string | null;
    notes: string | null;
    updated_at?: string;
    updated_by?: string | null;
  } | null;
}

const LEVELS: [number, string][] = [
  [8, "8 · Board"],
  [7, "7 · Executive"],
  [6, "6 · Department head"],
  [5, "5 · Director / regional lead"],
  [4, "4 · Regional or corporate staff"],
  [3, "3 · Site manager"],
  [2, "2 · Assistant manager"],
  [1, "1 · Site staff"]
];
const DEPARTMENTS = [
  "Executive", "HR", "Finance", "CRD", "IT", "Maintenance", "Marketing",
  "Retail", "Incidents", "Legal", "Site Operations", "Other"
];
const WORKS_AT: [string, string][] = [
  ["site", "At their Beekeeper site"],
  ["office_011", "Office — SMG (011)"],
  ["office_101", "Office — Grubka area (101)"],
  ["regional", "Regional (several sites)"],
  ["left", "Left / not an employee"]
];
const SOURCE_LABEL: Record<PersonRow["level_source"], string> = {
  placement: "set here",
  title: "from their Beekeeper title",
  default: "default — no placement and title not recognised"
};

const labelCls =
  "mb-1 block text-xs font-semibold uppercase tracking-wider text-splash-navy/70";
const inputCls =
  "w-full rounded-splash-sm border border-gray-light bg-white px-3 py-2 text-sm text-splash-navy shadow-inner focus:border-splash-blue focus:outline-none focus:ring-1 focus:ring-splash-blue";
const submitCls =
  "inline-flex items-center gap-1.5 rounded-splash-sm bg-splash-blue px-5 py-2.5 text-sm font-bold text-white shadow-splash-btn transition-colors hover:bg-splash-blue-dark";
const linkCls =
  "text-sm font-semibold text-splash-blue underline-offset-2 hover:text-splash-blue-dark hover:underline";

export function PersonnelPlacementCard() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PersonRow[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<PersonRow | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      setError(null);
      return;
    }
    const mine = ++seq.current;
    const t = window.setTimeout(async () => {
      setSearching(true);
      try {
        const resp = await fetch(
          `/sysadmin/api/personnel/search?q=${encodeURIComponent(q)}`,
          { credentials: "include", cache: "no-store" }
        );
        if (mine !== seq.current) return;
        if (!resp.ok) {
          setResults([]);
          setError(`Search failed (${resp.status}).`);
          return;
        }
        setResults((await resp.json()) as PersonRow[]);
        setError(null);
      } catch (e) {
        if (mine === seq.current) setError(e instanceof Error ? e.message : "Search failed.");
      } finally {
        if (mine === seq.current) setSearching(false);
      }
    }, 250);
    return () => window.clearTimeout(t);
  }, [query]);

  function onResult(result: ActionResult) {
    if (result.ok) {
      setSelected(null);
      setQuery("");
      setResults([]);
    }
  }

  if (selected) {
    const p = selected.placement;
    return (
      <div className="space-y-4">
        <div className="rounded-splash-sm border border-gray-light bg-gray-light/30 px-4 py-3 text-sm text-splash-navy">
          <div className="font-bold">{selected.display_name}</div>
          <div className="text-splash-navy/70">{selected.position || "No Beekeeper title"}</div>
          <div className="text-splash-navy/70">
            {selected.locations.length ? selected.locations.join(", ") : "No Beekeeper location"}
          </div>
          <div className="mt-1">
            Level now: <strong>{selected.level}</strong>{" "}
            <span className="text-splash-navy/60">({SOURCE_LABEL[selected.level_source]})</span>
          </div>
          {p?.updated_by && (
            <div className="mt-0.5 text-xs text-splash-navy/50">Last set by {p.updated_by}</div>
          )}
        </div>

        <ActionForm
          key={selected.beekeeper_user_id}
          action={updatePlacementAction}
          onResult={onResult}
          resetOnSuccess={false}
          className="space-y-4"
        >
          <input type="hidden" name="beekeeper_user_id" value={selected.beekeeper_user_id} />
          <input type="hidden" name="display_name" value={selected.display_name ?? ""} />

          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <div>
              <label htmlFor="pp-level" className={labelCls}>Level</label>
              <select id="pp-level" name="level" defaultValue={p?.level ?? ""} className={inputCls}>
                <option value="">Use title default</option>
                {LEVELS.map(([n, label]) => (
                  <option key={n} value={n}>{label}</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="pp-dept" className={labelCls}>Department</label>
              <select id="pp-dept" name="department" defaultValue={p?.department ?? ""} className={inputCls}>
                <option value="">None</option>
                {DEPARTMENTS.map((d) => (
                  <option key={d} value={d}>{d}</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="pp-works" className={labelCls}>Works at</label>
              <select id="pp-works" name="works_at" defaultValue={p?.works_at ?? ""} className={inputCls}>
                <option value="">Use Beekeeper location</option>
                {WORKS_AT.map(([v, label]) => (
                  <option key={v} value={v}>{label}</option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label htmlFor="pp-notes" className={labelCls}>Notes</label>
            <input
              id="pp-notes"
              name="notes"
              type="text"
              maxLength={1000}
              defaultValue={p?.notes ?? ""}
              className={inputCls}
              placeholder="Optional — e.g. why this person is placed here"
            />
          </div>

          <p className="text-xs text-splash-navy/60">
            Level only decides who sits above whom on confidential forms; it grants no access by
            itself. Leave everything empty and save to remove the override.
          </p>

          <div className="flex items-center gap-4">
            <button type="submit" className={submitCls}>Save</button>
            <button type="button" className={linkCls} onClick={() => setSelected(null)}>
              Cancel
            </button>
          </div>
        </ActionForm>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <label htmlFor="pp-search" className={labelCls}>Find an employee</label>
      <input
        id="pp-search"
        type="search"
        autoComplete="off"
        value={query}
        onChange={(e) => setQuery(e.currentTarget.value)}
        placeholder="Name (2+ letters)…"
        className={inputCls}
      />
      {error && <p role="alert" className="text-xs text-racecar-red">{error}</p>}
      {searching && results.length === 0 && (
        <p className="text-xs text-splash-navy/60">Searching…</p>
      )}
      {!searching && query.trim().length >= 2 && results.length === 0 && !error && (
        <p className="text-xs text-splash-navy/60">No current employee matches.</p>
      )}
      {results.length > 0 && (
        <ul className="divide-y divide-gray-light rounded-splash-sm border border-gray-light">
          {results.map((r) => (
            <li key={r.beekeeper_user_id}>
              <button
                type="button"
                onClick={() => setSelected(r)}
                className="flex w-full items-start justify-between gap-3 px-3 py-2 text-left hover:bg-splash-blue/5"
              >
                <span>
                  <span className="block text-sm font-semibold text-splash-navy">{r.display_name}</span>
                  <span className="block text-xs text-splash-navy/60">
                    {r.position || "No title"}
                    {r.locations.length ? ` · ${r.locations.join(", ")}` : ""}
                  </span>
                </span>
                <span className="shrink-0 text-xs text-splash-navy/70">
                  Level {r.level}
                  {r.level_source === "placement" ? " · set" : ""}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
