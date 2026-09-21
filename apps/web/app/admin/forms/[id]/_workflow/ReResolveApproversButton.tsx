// "Apply to open submissions" — the other half of publishing a staffing change.
//
// THE PROBLEM THIS SOLVES, because the button is otherwise cryptic:
//
//   Approvers are resolved once and STAMPED on each submission
//   (`current_approver_emails`), and each submission is pinned to the version
//   it was filled on. So adding a third approver and republishing changes
//   routing for submissions that DO NOT EXIST YET. The 200 already in the
//   queue keep the original two names, and the person hired to clear the
//   backlog cannot see any of it.
//
//   This button re-runs approver resolution against the form's current
//   published version for every in-flight submission and re-stamps them.
//
// NOT AUTOMATIC ON PUBLISH, deliberately. Publishing is how you change the
// form — fixing a typo in a field label should not silently move 200 tickets
// onto somebody else's desk. Moving live work is its own decision, and it is
// also one an operator may want to make WITHOUT republishing.
//
// Self-contained on purpose: takes only formId, holds its own state, and never
// touches the builder reducer. It reads the PUBLISHED version server-side, so
// it is unaffected by unsaved draft edits sitting in the builder.

"use client";

import { useState, useTransition } from "react";

import { reResolveApproversAction } from "../actions";

interface Props {
  formId: string;
}

type Outcome =
  | { kind: "ok"; text: string; warn: boolean }
  | { kind: "err"; text: string };

export default function ReResolveApproversButton({ formId }: Props) {
  const [pending, startTransition] = useTransition();
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  function run() {
    if (
      !window.confirm(
        "Re-check who each open submission is waiting on?\n\n" +
          "This re-runs approver resolution against the form's current " +
          "published version for every submission still in flight, so people " +
          "you have added since they were submitted can see and act on them.\n\n" +
          "Submissions that have already reached an outcome are not touched."
      )
    ) {
      return;
    }

    setOutcome(null);
    startTransition(async () => {
      const res = await reResolveApproversAction(formId);
      if (!res.ok) {
        setOutcome({ kind: "err", text: res.error });
        return;
      }

      const r = res.result;
      const parts = [
        `${r.updated} submission${r.updated === 1 ? "" : "s"} re-pointed`,
        `${r.unchanged} already correct`
      ];
      if (r.skipped_unknown_stage > 0) {
        // Worth surfacing: the step was renamed or removed between versions,
        // so these rows sit at a step the current version no longer has. The
        // worker skips rather than guessing a destination.
        parts.push(
          `${r.skipped_unknown_stage} left alone (their step no longer exists)`
        );
      }
      if (r.failed.length > 0) {
        parts.push(`${r.failed.length} failed`);
      }
      if (r.cap_reached) {
        parts.push("cap reached — run again to continue");
      }

      setOutcome({
        kind: "ok",
        text: `${parts.join(", ")}.`,
        warn: r.failed.length > 0 || r.cap_reached
      });
    });
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={run}
        disabled={pending}
        className="rounded-splash-md border border-splash-navy/30 px-3 py-1.5 text-xs font-semibold text-splash-navy hover:bg-splash-navy/5 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {pending ? "Re-checking…" : "Apply to open submissions"}
      </button>

      {outcome && (
        <p
          role="status"
          className={
            outcome.kind === "err" || outcome.warn
              ? "max-w-xs text-right text-xs text-racecar-red"
              : "max-w-xs text-right text-xs text-splash-navy/70"
          }
        >
          {outcome.kind === "err"
            ? `Could not apply: ${outcome.text}`
            : outcome.text}
        </p>
      )}
    </div>
  );
}
