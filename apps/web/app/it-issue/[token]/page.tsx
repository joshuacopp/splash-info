// IT Issue Tracker -- public email-link page (/it-issue/{token}).
//
// NO SIGN-IN, on purpose: IT works in its own ticketing system and MaintainX,
// not here, so the links in the daily report and in "Send to IT support now"
// let them read an issue's history and add a ticket #, a note, or close it.
// The token is the whole gate. This route is deliberately absent from the
// middleware matcher, and itFetch is called with withSession=false so a
// signed-in visitor's cookie never rides along.

import { ActionForm } from "../../admin/_components/ActionForm";
import { SubmitButton } from "../../admin/_components/SubmitButton";
import { linkAction } from "../../admin/it-issues/actions";
import { getPublicIssue } from "../../admin/it-issues/_lib/worker-fetch";
import { STATUS_OPTIONS } from "../../admin/it-issues/_lib/types";
import { IssueDetails, IssueHeader, IssueTimeline } from "../../admin/it-issues/_components/IssueSummary";
import { NameInput } from "../../admin/it-issues/_components/NameInput";

export const dynamic = "force-dynamic";

export const metadata = { title: "IT issue", robots: { index: false, follow: false } };

const input = "w-full rounded-splash-sm border border-gray-light bg-white px-3 py-2 text-sm";
const card = "rounded-splash-md border-[1.5px] border-splash-navy/15 bg-white p-4 shadow-splash-card";
const btn = "rounded-splash-sm bg-splash-blue px-4 py-2 text-sm font-semibold text-white hover:bg-splash-navy disabled:opacity-60";

export default async function ItIssueLinkPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const data = await getPublicIssue(token);

  if (!data) {
    return (
      <section className="mx-auto w-full max-w-[640px] px-5 py-16 text-center">
        <h1 className="mb-2 text-2xl font-bold text-splash-navy">Link not valid</h1>
        <p className="text-splash-navy/70">
          This link has expired or is not valid. Newer emails about the issue carry a fresh link.
        </p>
      </section>
    );
  }
  const { issue, events, read_only } = data;

  return (
    <section className="mx-auto w-full max-w-[1100px] px-5 py-9">
      <IssueHeader issue={issue} />
      <div className="grid gap-5 lg:grid-cols-[1fr_360px]">
        <div className="space-y-5">
          <IssueDetails issue={issue} />
          <IssueTimeline events={events} />
        </div>

        <div className="space-y-5">
          {read_only ? (
            <div className={card}>
              <p className="text-sm text-splash-navy/80">
                This issue is resolved. If it comes back, the site will reopen it and you&apos;ll get a new email.
              </p>
            </div>
          ) : (
            <>
              <div className={card}>
                <h2 className="mb-3 text-base font-bold text-splash-navy">Update</h2>
                <ActionForm action={linkAction} className="space-y-3">
                  <input type="hidden" name="token" value={token} />
                  <NameInput />
                  <label className="block text-sm">
                    <span className="mb-1 block font-semibold text-splash-navy">Your ticket #</span>
                    <input name="it_ticket_no" defaultValue={issue.it_ticket_no ?? ""} maxLength={60} className={input} />
                  </label>
                  <label className="block text-sm">
                    <span className="mb-1 block font-semibold text-splash-navy">Status</span>
                    <select name="status" defaultValue={issue.status} className={input}>
                      {STATUS_OPTIONS.filter((o) => o.value !== "resolved").map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <textarea name="note" rows={3} maxLength={4000} placeholder="Note for the site (optional)" className={input} />
                  <SubmitButton pendingText="Saving…" className={btn}>
                    Save
                  </SubmitButton>
                </ActionForm>
              </div>

              <div className={card}>
                <h2 className="mb-1 text-base font-bold text-splash-navy">Close this issue</h2>
                <p className="mb-3 text-xs text-splash-navy/60">
                  The site sees your resolution note. If the problem comes back they reopen this same issue.
                </p>
                <ActionForm action={linkAction} className="space-y-3">
                  <input type="hidden" name="token" value={token} />
                  <input type="hidden" name="status" value="resolved" />
                  <NameInput />
                  <textarea name="resolution" required rows={3} maxLength={4000} placeholder="What fixed it?" className={input} />
                  <SubmitButton pendingText="Closing…" className={btn}>
                    Close issue
                  </SubmitButton>
                </ActionForm>
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
