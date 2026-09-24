"use client";

// One action item. Status is optimistic because it is the high-frequency
// action -- a site works down a list and each flip should feel instant rather
// than costing a round-trip's worth of waiting. Failure surfaces inline and
// the optimistic value expires on the next refresh.

import { useOptimistic, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import {
  PRIORITIES,
  STATUS_LABEL,
  STATUS_ORDER,
  type ActionItem,
  type ActionItemPriority,
  type ActionItemStatus
} from "../_lib/types";
import { setStatusAction, updateItemAction, verifyAction } from "../actions";
import ItemNotes from "./ItemNotes";
import type { ActionItemNote } from "../_lib/types";

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric"
  });
}

/** Overdue is a property of an OPEN item. A done item that was finished late
 *  is history, not a call to action, and colouring it red buries the things
 *  that still need doing. */
function isOverdue(item: ActionItem): boolean {
  if (item.status === "done" || !item.due_date) return false;
  return item.due_date < new Date().toISOString().slice(0, 10);
}

const PRIORITY_CLASS: Record<ActionItemPriority, string> = {
  High: "bg-racecar-red/10 text-racecar-red ring-racecar-red/30",
  Medium: "bg-amber-100 text-amber-800 ring-amber-300",
  Low: "bg-gray-light text-splash-navy/70 ring-gray-light"
};

export default function ActionItemRow({
  item,
  notes = []
}: {
  item: ActionItem;
  notes?: ActionItemNote[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [status, setStatus] = useOptimistic<ActionItemStatus>(item.status);

  const verified = item.rm_verified_at !== null;
  const locked = verified; // verification freezes the row
  const overdue = isOverdue(item);

  function flipStatus(next: ActionItemStatus) {
    setError(null);
    startTransition(async () => {
      setStatus(next);
      const res = await setStatusAction(item.id, next);
      if (!res.ok) setError(res.error);
      router.refresh();
    });
  }

  function save(formData: FormData) {
    setError(null);
    const description = String(formData.get("description") ?? "").trim();
    const priority = String(formData.get("priority") ?? "") as ActionItemPriority;
    const rawDue = String(formData.get("due_date") ?? "");
    startTransition(async () => {
      const res = await updateItemAction(item.id, {
        description,
        priority,
        due_date: rawDue === "" ? null : rawDue
      });
      if (res.ok) setEditing(false);
      else setError(res.error);
      router.refresh();
    });
  }

  return (
    <li
      className={`rounded-splash-md border bg-white p-4 ${
        overdue ? "border-racecar-red/40" : "border-gray-light"
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          {editing ? (
            <form action={save} className="space-y-2">
              <textarea
                name="description"
                defaultValue={item.description}
                rows={2}
                required
                className="w-full rounded-splash-sm border border-gray-light px-2 py-1.5 text-sm"
              />
              <div className="flex flex-wrap items-center gap-2">
                <select
                  name="priority"
                  defaultValue={item.priority}
                  className="rounded-splash-sm border border-gray-light px-2 py-1.5 text-sm"
                >
                  {PRIORITIES.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
                <input
                  type="date"
                  name="due_date"
                  defaultValue={item.due_date ?? ""}
                  className="rounded-splash-sm border border-gray-light px-2 py-1.5 text-sm"
                />
                <button
                  type="submit"
                  disabled={pending}
                  className="rounded-splash-sm bg-splash-navy px-3 py-1.5 text-xs font-bold text-white disabled:opacity-50"
                >
                  {pending ? "Saving…" : "Save"}
                </button>
                <button
                  type="button"
                  onClick={() => setEditing(false)}
                  className="text-xs text-splash-navy/60 underline"
                >
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <>
              <p className="text-sm font-semibold text-splash-navy">
                {item.description}
              </p>
              {/* The question this came from, and what was answered. Without it
                  an item is a sentence with no context a month later. */}
              <p className="mt-0.5 text-xs text-splash-navy/60">
                {item.question_label}
                {item.answer_snapshot ? (
                  <>
                    {" · answered "}
                    <span className="font-semibold">{item.answer_snapshot}</span>
                  </>
                ) : null}
              </p>
            </>
          )}
        </div>

        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <span
            className={`inline-flex items-center rounded-full px-2 py-0.5 text-[0.6875rem] font-bold ring-1 ${PRIORITY_CLASS[item.priority]}`}
          >
            {item.priority}
          </span>
          <span
            className={`text-xs ${overdue ? "font-bold text-racecar-red" : "text-splash-navy/60"}`}
          >
            {overdue ? "Overdue " : "Due "}
            {formatDate(item.due_date)}
          </span>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-gray-light pt-3">
        {STATUS_ORDER.map((s) => (
          <button
            key={s}
            type="button"
            disabled={!item.can_edit || locked || pending || status === s}
            onClick={() => flipStatus(s)}
            title={
              locked
                ? "Verified by the RM — no longer editable"
                : !item.can_edit
                  ? "You can view this item but not change it"
                  : undefined
            }
            className={
              status === s
                ? "rounded-full bg-splash-navy px-3 py-1 text-xs font-bold text-white"
                : "rounded-full border border-gray-light px-3 py-1 text-xs font-semibold text-splash-navy hover:bg-gray-light/40 disabled:cursor-not-allowed disabled:opacity-40"
            }
          >
            {STATUS_LABEL[s]}
          </button>
        ))}

        {item.can_edit && !locked && !editing ? (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="text-xs text-splash-blue underline"
          >
            Edit
          </button>
        ) : null}

        <div className="ml-auto flex items-center gap-2">
          {verified ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-bold text-emerald-800">
              ✓ RM verified
            </span>
          ) : item.can_verify ? (
            <button
              type="button"
              disabled={pending || status !== "done"}
              onClick={() => {
                setError(null);
                startTransition(async () => {
                  const res = await verifyAction(item.id);
                  if (!res.ok) setError(res.error);
                  router.refresh();
                });
              }}
              title={
                status !== "done"
                  ? "Mark the item done before verifying it"
                  : "Confirm this work is complete. This locks the item."
              }
              className="rounded-full border border-emerald-600 px-3 py-1 text-xs font-bold text-emerald-700 hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Verify
            </button>
          ) : null}
        </div>
      </div>

      {item.completed_at ? (
        <p className="mt-2 text-[0.6875rem] text-splash-navy/50">
          Completed {formatDate(item.completed_at)}
          {verified ? ` · verified ${formatDate(item.rm_verified_at)}` : ""}
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="mt-2 text-xs text-racecar-red">
          {error}
        </p>
      ) : null}

      {/* Allowed on a VERIFIED item, unlike the controls above: verification
          freezes what the item IS, but recording what happened to it is not a
          state change. Gated on can_edit, the same capability the worker uses,
          so a read-only viewer sees the thread without a post box. */}
      <ItemNotes itemId={item.id} notes={notes} canPost={item.can_edit} />
    </li>
  );
}
