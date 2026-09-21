// Brief 174 — the conversation about a submission, as distinct from the audit
// of what happened to it.
//
// Sits BELOW the workflow timeline on purpose: state first, discussion second.
// A reader wants to know where the ticket is before they read what people said
// about it.
//
// Comments notify nobody at v1, and the empty state says so out loud rather
// than leaving it in a brief nobody reads. Somebody who posts a question here
// expecting it to page the other party would be wrong in a way that costs a
// day, and the cheapest place to prevent that is the point of use.

import { ActionForm } from "../../../../../_components/ActionForm";
import { SubmitButton } from "../../../../../_components/SubmitButton";
import type { SubmissionComment } from "../../../../_lib/worker-fetch";
import { addCommentAction } from "../actions";

const MIN_MS = 60_000;
const HOUR_MS = 60 * MIN_MS;
const DAY_MS = 24 * HOUR_MS;

/** Relative for scanning, absolute in the title attribute — the Brief 113
 *  convention, after that brief had to correct a column showing only relative
 *  time under an absolute-time header. */
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const diff = Date.now() - then;
  if (diff < MIN_MS) return "just now";
  if (diff < HOUR_MS) return `${Math.round(diff / MIN_MS)} min ago`;
  if (diff < DAY_MS) return `${Math.round(diff / HOUR_MS)} hr ago`;
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

interface Props {
  formId: string;
  subId: string;
  comments: SubmissionComment[];
  /** False when the worker refused the thread — the caller can see the
   *  submission but is not a participant. Render nothing rather than an empty
   *  thread they cannot post to. */
  canDiscuss: boolean;
}

export default function DiscussionSection({
  formId,
  subId,
  comments,
  canDiscuss
}: Props) {
  if (!canDiscuss) return null;
  const post = addCommentAction.bind(null, formId, subId);

  return (
    <section className="mt-6 rounded-splash-lg border-[1.5px] border-gray-light bg-white p-5 shadow-splash-card">
      <h2 className="text-base font-bold text-splash-navy">Discussion</h2>
      <p className="mt-0.5 text-xs text-splash-navy/60">
        Questions and context about this submission. Posting here does not
        notify anyone — use an action above to hand the ticket to someone.
      </p>

      {comments.length === 0 ? (
        <p className="mt-4 text-sm italic text-splash-navy/50">
          No comments yet.
        </p>
      ) : (
        <ol className="mt-4 space-y-3">
          {comments.map((c) => (
            <li
              key={c.id}
              className="rounded-splash-md border border-gray-light bg-gray-light/20 px-3 py-2"
            >
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-sm font-semibold text-splash-navy">
                  {c.author_email}
                </span>
                <span
                  className="text-xs text-splash-navy/55"
                  title={c.created_at}
                >
                  {relativeTime(c.created_at)}
                </span>
              </div>
              {/* whitespace-pre-wrap keeps the author's line breaks. React
                  escapes the body by default — never dangerouslySetInnerHTML
                  on text somebody typed. */}
              <p className="mt-1 whitespace-pre-wrap text-sm text-splash-navy/90">
                {c.body}
              </p>
            </li>
          ))}
        </ol>
      )}

      <div className="mt-4">
        <ActionForm action={post} resetOnSuccess className="space-y-2">
          <label
            htmlFor="comment-body"
            className="block text-sm font-semibold text-splash-navy"
          >
            Add a comment
          </label>
          <textarea
            id="comment-body"
            name="body"
            rows={3}
            maxLength={10000}
            required
            placeholder="Ask a question, or record what you found…"
            className="mt-1 w-full rounded-splash-md border border-gray-light px-3 py-2 text-sm text-splash-navy focus:border-splash-blue focus:outline-none"
          />
          <SubmitButton
            pendingText="Posting…"
            className="rounded-splash-md bg-splash-navy px-4 py-2 text-sm font-semibold text-white hover:bg-splash-blue-dark disabled:opacity-70"
          >
            Post comment
          </SubmitButton>
        </ActionForm>
      </div>
    </section>
  );
}
