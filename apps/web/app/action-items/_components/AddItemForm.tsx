"use client";

// Add an action item by hand, for what the walk-through missed or for
// splitting one ticked question into the several jobs it turned out to be.
//
// COLLAPSED BEHIND A BUTTON. The page is a worklist; a permanently-open create
// form at the top pushes the actual work down the screen for the far more
// common case of arriving to DO something rather than to add something.
//
// Only rendered when a single site is in context -- the site is implied by
// what you are looking at rather than picked from a dropdown that could be set
// wrong. On the multi-site overview there is no site to imply, so there is no
// button.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { PRIORITIES } from "../_lib/types";
import { createItemAction } from "../actions";

export default function AddItemForm({ locationCode }: { locationCode: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function submit(formData: FormData) {
    const description = String(formData.get("description") ?? "");
    const priority = String(formData.get("priority") ?? "Medium");
    const due = String(formData.get("due_date") ?? "");
    setError(null);
    startTransition(async () => {
      const res = await createItemAction(locationCode, {
        description,
        priority,
        due_date: due === "" ? null : due
      });
      if (res.ok) {
        setOpen(false);
        router.refresh();
      } else {
        setError(res.error);
      }
    });
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mb-4 rounded-splash-md border border-splash-navy/30 px-3 py-1.5 text-sm font-semibold text-splash-navy hover:bg-splash-navy/5"
      >
        + Add action item
      </button>
    );
  }

  return (
    <form
      action={submit}
      className="mb-4 space-y-2 rounded-splash-md border border-splash-navy/30 bg-white p-4"
    >
      <p className="text-xs font-semibold uppercase tracking-wider text-splash-navy/70">
        New action item at {locationCode}
      </p>
      <textarea
        name="description"
        rows={2}
        required
        autoFocus
        placeholder="Action item title/description"
        className="w-full rounded-splash-sm border border-gray-light px-2 py-1.5 text-sm"
      />
      <div className="flex flex-wrap items-center gap-2">
        <select
          name="priority"
          defaultValue="Medium"
          className="rounded-splash-sm border border-gray-light px-2 py-1.5 text-sm"
        >
          {PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        {/* No default date. A form-generated item gets +14 days because nobody
            was there to choose; here someone is, and a pre-filled date they
            did not pick is a date nobody owns. */}
        <input
          type="date"
          name="due_date"
          aria-label="Due date"
          className="rounded-splash-sm border border-gray-light px-2 py-1.5 text-sm"
        />
        <button
          type="submit"
          disabled={pending}
          className="rounded-splash-sm bg-splash-navy px-3 py-1.5 text-xs font-bold text-white disabled:opacity-50"
        >
          {pending ? "Adding…" : "Add item"}
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
          className="text-xs text-splash-navy/60 underline"
        >
          Cancel
        </button>
      </div>
      {error ? (
        <p role="alert" className="text-xs text-racecar-red">
          {error}
        </p>
      ) : null}
    </form>
  );
}
