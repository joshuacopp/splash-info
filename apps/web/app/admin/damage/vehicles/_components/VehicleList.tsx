"use client";

// The entry list on /admin/damage/vehicles, with a search box that filters as
// you type. Client-side because the whole list is already on the page (a few
// hundred entries at most) -- a round trip per keystroke would only add lag.
//
// Matching is the SAME rule as the staff page (src/render/vehicle-guide-page.ts
// in damage-worker): every word must appear in make / model / issue type /
// issue / solution, except a 4-digit word, which matches when the entry's year
// range covers it. Keep the two in step, or "2021 tahoe" finds different
// things for the person writing the guide and the person reading it.
//
// The query survives the save / delete redirects (sessionStorage), so "search,
// edit, save" lands back on the same filtered list.

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  formatVehicleYears,
  vehicleIssueTypeLabel,
  type VehicleIssue
} from "@splash/types/vehicle-guide";
import { RedirectForm } from "../../../_components/RedirectForm";
import { ConfirmDeleteButton } from "./ConfirmDeleteButton";
import { deleteVehicleIssueAction } from "../actions";

const LIST_PATH = "/admin/damage/vehicles";
const STORAGE_KEY = "vehicle-guide.admin.q";

const TYPE_PILL: Record<string, string> = {
  neutral: "bg-sudsy-blue-soft text-splash-navy",
  park: "bg-amber-100 text-amber-900",
  safety: "bg-splash-deny/10 text-splash-deny",
  other: "bg-splash-navy/10 text-splash-navy/80"
};

const CARD_CLS = "rounded-splash-lg border border-gray-light bg-white p-5 shadow-splash-card";

function matches(i: VehicleIssue, words: string[], openYear: number): boolean {
  const hay = [i.make, i.model, vehicleIssueTypeLabel(i.issue_type), i.issue, i.solution]
    .join(" ")
    .toLowerCase();
  return words.every((w) => {
    if (/^\d{4}$/.test(w)) {
      const y = Number(w);
      return y >= i.year_from && y <= (i.year_to ?? openYear);
    }
    return hay.includes(w);
  });
}

export function VehicleList({ issues, canEdit }: { issues: VehicleIssue[]; canEdit: boolean }) {
  const [q, setQ] = useState("");

  useEffect(() => {
    const saved = window.sessionStorage.getItem(STORAGE_KEY);
    if (saved) setQ(saved);
  }, []);

  function update(v: string) {
    setQ(v);
    if (v.trim()) window.sessionStorage.setItem(STORAGE_KEY, v);
    else window.sessionStorage.removeItem(STORAGE_KEY);
  }

  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  // Open-ended ("2019+") entries cover through next model year, as on the
  // staff page.
  const openYear = new Date().getFullYear() + 1;
  const shown = words.length ? issues.filter((i) => matches(i, words, openYear)) : issues;

  // Group by make, then model. The worker stores one spelling per make/model
  // (it reuses whatever is on file), so plain string keys are safe here.
  const byMake = new Map<string, Map<string, VehicleIssue[]>>();
  for (const i of shown) {
    const models = byMake.get(i.make) ?? new Map<string, VehicleIssue[]>();
    const list = models.get(i.model) ?? [];
    list.push(i);
    models.set(i.model, list);
    byMake.set(i.make, models);
  }
  const makes = Array.from(byMake.keys()).sort((a, b) => a.localeCompare(b));

  if (issues.length === 0) {
    return (
      <div className={CARD_CLS}>
        <p className="text-splash-navy/80">No vehicles yet.{canEdit ? " Add the first one above." : ""}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <label className="relative flex-1">
          <span className="sr-only">Search the vehicle guide</span>
          <input
            type="search"
            value={q}
            onChange={(e) => update(e.target.value)}
            placeholder="Search make, model, year or problem"
            autoComplete="off"
            enterKeyHint="search"
            className="w-full rounded-splash-sm border border-gray-light bg-white px-3 py-2.5 text-sm text-splash-navy placeholder:text-splash-navy/40 focus:border-splash-blue focus:outline-none"
          />
        </label>
        <div className="flex items-center gap-3 text-sm text-splash-navy/70">
          <span aria-live="polite">
            {words.length
              ? `${shown.length} of ${issues.length} ${issues.length === 1 ? "entry" : "entries"}`
              : `${issues.length} ${issues.length === 1 ? "entry" : "entries"}`}
          </span>
          {q ? (
            <button
              type="button"
              onClick={() => update("")}
              className="font-semibold text-splash-blue underline"
            >
              Clear
            </button>
          ) : null}
        </div>
      </div>

      {shown.length === 0 ? (
        <div className={CARD_CLS}>
          <p className="text-splash-navy/80">No matches. Try just the make or model.</p>
        </div>
      ) : (
        makes.map((make) => {
          const models = byMake.get(make)!;
          return (
            <section key={make} className={CARD_CLS}>
              <h2 className="mb-3 text-lg font-bold text-splash-navy">{make}</h2>
              <div className="flex flex-col divide-y divide-gray-light">
                {Array.from(models.keys())
                  .sort((a, b) => a.localeCompare(b))
                  .flatMap((model) =>
                    models.get(model)!.map((i) => (
                      <div key={i.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start sm:gap-4">
                        <div className="sm:w-48 sm:flex-none">
                          <div className="font-bold text-splash-navy">{model}</div>
                          <div className="text-sm text-splash-navy/70">
                            {formatVehicleYears(i.year_from, i.year_to)}
                          </div>
                          <span
                            className={`mt-1 inline-block rounded-full px-2 py-0.5 text-[11px] font-bold ${TYPE_PILL[i.issue_type] ?? TYPE_PILL.other}`}
                          >
                            {vehicleIssueTypeLabel(i.issue_type)}
                          </span>
                        </div>
                        <div className="min-w-0 flex-1 text-sm">
                          <p className="whitespace-pre-wrap text-splash-navy">{i.issue}</p>
                          <p className="mt-1.5 whitespace-pre-wrap border-l-4 border-splash-success/60 pl-3 text-splash-navy/80">
                            {i.solution}
                          </p>
                          <p className="mt-1.5 text-xs text-splash-navy/50">
                            {i.media.length
                              ? `${i.media.length} photo${i.media.length === 1 ? "" : "s"}/video${i.media.length === 1 ? "" : "s"} · `
                              : ""}
                            {i.youtube_links.length
                              ? `${i.youtube_links.length} YouTube link${i.youtube_links.length === 1 ? "" : "s"} · `
                              : ""}
                            Updated {i.updated_at.slice(0, 10)}
                            {i.updated_by ? ` by ${i.updated_by}` : ""}
                          </p>
                        </div>
                        {canEdit ? (
                          <div className="flex flex-none items-center gap-2">
                            <Link
                              href={`${LIST_PATH}?edit=${i.id}#editor`}
                              className="rounded-splash-sm border border-splash-blue/40 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-splash-blue hover:bg-splash-blue/5"
                            >
                              Edit
                            </Link>
                            <RedirectForm action={deleteVehicleIssueAction}>
                              <input type="hidden" name="id" value={i.id} />
                              <ConfirmDeleteButton
                                confirmText={`Delete ${i.make} ${i.model} (${formatVehicleYears(i.year_from, i.year_to)}) and its photos and videos? This can't be undone.`}
                              />
                            </RedirectForm>
                          </div>
                        ) : null}
                      </div>
                    ))
                  )}
              </div>
            </section>
          );
        })
      )}
    </div>
  );
}
