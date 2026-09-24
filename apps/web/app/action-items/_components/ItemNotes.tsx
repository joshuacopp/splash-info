"use client";

// The running record on one action item: "added to MaintainX", then later
// "parts arrived", then "swapped Tuesday".
//
// COLLAPSED BY DEFAULT, with the count in the summary. An action items page is
// a worklist first; expanding every thread inline would bury the thing the
// page exists to show. The count is what tells you a thread is worth opening.
//
// Append-only, and the UI says so rather than offering an edit affordance the
// worker would refuse. A note that could be rewritten after an RM read it
// would assert nothing.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import type { ActionItemNote } from "../_lib/types";
import { addNoteAction } from "../actions";

function stamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

export default function ItemNotes({
  itemId,
  notes,
  canPost
}: {
  itemId: string;
  notes: ActionItemNote[];
  canPost: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  function post() {
    if (draft.trim() === "" || pending) return;
    setError(null);
    startTransition(async () => {
      const res = await addNoteAction(itemId, draft);
      if (res.ok) {
        setDraft("");
        router.refresh();
      } else {
        setError(res.error);
      }
    });
  }

  return (
    <details className="mt-2 border-t border-gray-light pt-2">
      <summary className="cursor-pointer text-xs font-semibold text-splash-blue">
        Notes{notes.length > 0 ? ` (${notes.length})` : ""}
      </summary>

      {notes.length > 0 ? (
        <ul className="mt-2 space-y-2">
          {notes.map((n) => (
            <li
              key={n.id}
              className="rounded-splash-sm bg-gray-light/30 px-3 py-2 text-sm text-splash-navy"
            >
              {/* whitespace-pre-line so a multi-line note keeps its shape;
                  React escapes the text, so this is not an injection path. */}
              <p className="whitespace-pre-line">{n.body}</p>
              <p className="mt-1 text-[0.6875rem] text-splash-navy/50">
                {n.author_email} · {stamp(n.created_at)}
              </p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-xs text-splash-navy/50">
          No notes yet. Record what was done here &mdash; added to MaintainX,
          parts ordered, work completed.
        </p>
      )}

      {canPost ? (
        <div className="mt-2 space-y-1.5">
          <textarea
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setError(null);
            }}
            rows={2}
            maxLength={5000}
            placeholder="Add a note…"
            className="w-full rounded-splash-sm border border-gray-light px-2 py-1.5 text-sm"
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={post}
              disabled={pending || draft.trim() === ""}
              className="rounded-splash-sm bg-splash-navy px-3 py-1.5 text-xs font-bold text-white disabled:cursor-not-allowed disabled:opacity-40"
            >
              {pending ? "Adding…" : "Add note"}
            </button>
            <span className="text-[0.6875rem] text-splash-navy/50">
              Saved with your name and the time. Notes can&rsquo;t be edited or
              deleted.
            </span>
          </div>
          {error ? (
            <p role="alert" className="text-xs text-racecar-red">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </details>
  );
}
