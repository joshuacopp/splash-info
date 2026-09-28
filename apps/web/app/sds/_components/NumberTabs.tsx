"use client";

// Assign the binder's tab numbers, for sites filing behind pre-numbered 1-50
// dividers.
//
// TWO ACTIONS, AND THE ASYMMETRY IS THE POINT. "Number tabs" only fills blanks,
// so it can never move a sheet already filed -- safe to press whenever, and it
// is what a site presses once its list is built. "Renumber A-Z" rewrites every
// tab and closes gaps, which means somebody physically re-files the book; it
// confirms first, and says how many sheets moved afterwards.
//
// The number is an ADDRESS, not a position. The printed index stays alphabetical
// with the tab as a column, so a chemical added later takes the next free number
// and nothing else is disturbed.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { numberTabsAction } from "../actions";

export default function NumberTabs({
  locationCode,
  untabbed,
  total,
  outOfOrder
}: {
  locationCode: string;
  /** Active chemicals with no numeric tab -- what "Number tabs" would act on. */
  untabbed: number;
  total: number;
  /** True when tab order and alphabetical order have diverged, which happens
   *  the moment a chemical is added after the binder was numbered. The index
   *  prints in TAB order, so that chemical prints last, away from its
   *  neighbours -- correct, and invisible unless the page says so. */
  outOfOrder: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [note, setNote] = useState<string | null>(null);
  const [warn, setWarn] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function run(mode: "fill" | "renumber") {
    if (mode === "renumber") {
      const ok = window.confirm(
        `Renumber all ${total} chemicals 1-${total} in alphabetical order?\n\n` +
          `Tab numbers will change, so the sheets in the physical binder have to ` +
          `be re-filed to match. Use this when rebuilding the book, not for a ` +
          `single addition.`
      );
      if (!ok) return;
    }
    setNote(null);
    setWarn(null);
    setError(null);
    startTransition(async () => {
      const res = await numberTabsAction(locationCode, mode);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setNote(
        res.changed === 0
          ? "Nothing to number — every chemical already has a tab."
          : mode === "renumber"
            ? `Renumbered ${res.changed} of ${res.total}. Tabs now run 1-${res.highest}.`
            : `Numbered ${res.changed}. Tabs now run 1-${res.highest}.`
      );
      if (res.overLimit) {
        setWarn(
          `This binder needs ${res.highest} dividers but packs run to ${res.limit}. ` +
            `Order a second pack, or split the binder by work area.`
        );
      }
      router.refresh();
    });
  }

  return (
    <div className="mt-3">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={pending || untabbed === 0}
          onClick={() => run("fill")}
          title={
            untabbed === 0
              ? "Every chemical already has a tab number"
              : `Give a number to the ${untabbed} chemical${untabbed === 1 ? "" : "s"} without one`
          }
          className="rounded-splash-md border border-splash-navy/30 px-3 py-1.5 text-sm font-semibold text-splash-navy hover:bg-splash-navy/5 disabled:opacity-50"
        >
          Number tabs{untabbed > 0 ? ` (${untabbed})` : ""}
        </button>
        <button
          type="button"
          disabled={pending || total === 0}
          onClick={() => run("renumber")}
          className="text-xs text-splash-navy/60 underline disabled:opacity-50"
        >
          Renumber A&ndash;Z
        </button>
      </div>
      <p className="mt-1 text-xs text-splash-navy/60">
        Tabs match pre-numbered dividers, and the index prints in tab order. A
        new chemical takes the next free number, so nothing already filed moves
        &mdash; but it prints at the end until you renumber.
      </p>
      {outOfOrder ? (
        <p className="mt-1 text-xs text-amber-700">
          Some chemicals are filed out of alphabetical order. That is fine to
          print &mdash; the tabs still run in sequence &mdash; but Renumber
          A&ndash;Z puts the list back in order if you are ready to re-file.
        </p>
      ) : null}
      {note ? (
        <p role="status" className="mt-1 text-xs text-emerald-700">
          {note}
        </p>
      ) : null}
      {warn ? (
        <p role="status" className="mt-1 text-xs text-amber-700">
          {warn}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-1 text-xs text-racecar-red">
          {error}
        </p>
      ) : null}
    </div>
  );
}
