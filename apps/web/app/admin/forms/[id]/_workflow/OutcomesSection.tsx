// Brief 125 — outcomes section.
//
// Horizontal pill row of outcomes (terminal stages). Each pill click
// opens an inline edit panel: rename, pick a tint, remove. "+ Add
// outcome" button appends a new neutral outcome.

"use client";

import { useState } from "react";
import type { WorkflowStage } from "@splash/forms-schema";

type Tint = NonNullable<WorkflowStage["tint"]>;

const TINT_OPTIONS: ReadonlyArray<{ id: Tint; label: string; pill: string }> = [
  {
    id: "success",
    label: "Success (green)",
    pill: "bg-emerald-100 text-emerald-800 ring-emerald-300"
  },
  {
    id: "danger",
    label: "Danger (red)",
    pill: "bg-racecar-red/10 text-racecar-red ring-racecar-red/30"
  },
  {
    id: "warning",
    label: "Warning (amber)",
    pill: "bg-amber-100 text-amber-800 ring-amber-300"
  },
  {
    id: "info",
    label: "Info (blue)",
    pill: "bg-splash-blue/10 text-splash-blue ring-splash-blue/30"
  },
  {
    id: "neutral",
    label: "Neutral",
    pill: "bg-slate-100 text-slate-700 ring-slate-300"
  }
];

function pillClass(tint: Tint | undefined): string {
  return TINT_OPTIONS.find((t) => t.id === (tint ?? "neutral"))?.pill ??
    TINT_OPTIONS[4]!.pill;
}

interface Props {
  outcomes: WorkflowStage[];
  onAdd: () => void;
  onRemove: (outcomeId: string) => void;
  onUpdate: (
    outcomeId: string,
    patch: Partial<Pick<WorkflowStage, "label" | "tint">>
  ) => void;
}

export default function OutcomesSection({
  outcomes,
  onAdd,
  onRemove,
  onUpdate
}: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const editing = editingId
    ? outcomes.find((o) => o.id === editingId) ?? null
    : null;

  return (
    <section className="space-y-2 rounded-splash-md border border-gray-light bg-sudsy-blue/5 p-4">
      <header>
        <h3 className="text-base font-bold text-splash-navy">Outcomes</h3>
        <p className="text-xs text-splash-navy/70">
          Final labels. Submissions reach these and stop.
        </p>
      </header>
      <div className="flex flex-wrap items-center gap-2">
        {outcomes.map((o) => (
          <button
            key={o._uiKey ?? o.id}
            type="button"
            onClick={() =>
              setEditingId(editingId === o.id ? null : o.id)
            }
            className={`inline-flex items-center rounded-full px-3 py-1 text-sm font-semibold ring-1 ${pillClass(o.tint)} ${
              editingId === o.id ? "ring-2 ring-offset-1" : ""
            }`}
          >
            {o.label || "(unnamed)"}
          </button>
        ))}
        <button
          type="button"
          onClick={onAdd}
          className="inline-flex items-center rounded-full border border-dashed border-splash-navy/60 px-3 py-1 text-sm font-semibold text-splash-navy/80 hover:bg-splash-navy/5"
        >
          + Add outcome
        </button>
      </div>
      {editing && (
        <div className="rounded-splash-md border border-gray-light bg-white p-3">
          <header className="flex items-center justify-between gap-2">
            <p className="text-sm font-semibold text-splash-navy">
              Edit outcome
            </p>
            <button
              type="button"
              onClick={() => setEditingId(null)}
              className="text-xs text-splash-navy/70 hover:underline"
            >
              Done
            </button>
          </header>
          <label className="mt-2 block text-xs font-semibold text-splash-navy">
            Label
            <input
              type="text"
              value={editing.label}
              onChange={(e) =>
                onUpdate(editing.id, { label: e.currentTarget.value })
              }
              className="mt-1 w-full rounded-splash-sm border border-gray-light bg-white px-2 py-1.5 text-sm font-normal text-splash-navy"
            />
          </label>
          <label className="mt-2 block text-xs font-semibold text-splash-navy">
            Color
            <select
              value={editing.tint ?? "neutral"}
              onChange={(e) =>
                onUpdate(editing.id, {
                  tint: e.currentTarget.value as Tint
                })
              }
              className="mt-1 w-full rounded-splash-sm border border-gray-light bg-white px-2 py-1.5 text-sm font-normal text-splash-navy"
            >
              {TINT_OPTIONS.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
          <div className="mt-3 flex justify-end">
            <button
              type="button"
              onClick={() => {
                if (
                  window.confirm(
                    "Remove this outcome? Any actions pointing here will need a new destination."
                  )
                ) {
                  onRemove(editing.id);
                  setEditingId(null);
                }
              }}
              className="rounded-splash-sm border border-racecar-red/40 px-2 py-1 text-xs font-semibold text-racecar-red hover:bg-racecar-red/10"
            >
              Remove outcome
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
