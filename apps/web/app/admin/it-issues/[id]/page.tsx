import Link from "next/link";
import { notFound } from "next/navigation";
import { getMe } from "../../../_lib/me";
import NoAccessCard from "../../forms/_components/NoAccessCard";
import { ActionForm } from "../../_components/ActionForm";
import { SubmitButton } from "../../_components/SubmitButton";
import { escalateAction, mxRequestAction, occurrenceAction, updateIssueAction } from "../actions";
import { getIssueDetail } from "../_lib/worker-fetch";
import { PRIORITY_OPTIONS, STATUS_OPTIONS, formatEt } from "../_lib/types";
import { IssueDetails, IssueHeader, IssueTimeline } from "../_components/IssueSummary";
import { NameInput } from "../_components/NameInput";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

const input = "w-full rounded-splash-sm border border-gray-light bg-white px-3 py-2 text-sm";
const card = "rounded-splash-md border-[1.5px] border-splash-navy/15 bg-white p-4 shadow-splash-card";
const btn = "rounded-splash-sm bg-splash-blue px-4 py-2 text-sm font-semibold text-white hover:bg-splash-navy disabled:opacity-60";

export default async function ItIssuePage({ params }: PageProps) {
  const { id } = await params;
  const session = await getMe().catch(() => null);
  if (!session) return <NoAccessCard reason="signin" returnPath={`/admin/it-issues/${id}`} />;

  const data = await getIssueDetail(id);
  // Not found and not yours are the same answer.
  if (!data) notFound();
  const { issue, events, escalate_to, mx_available, mx_blocked_reason } = data;
  const resolved = issue.status === "resolved";

  return (
    <section className="mx-auto w-full max-w-[1100px] px-5 py-9">
      <div className="mb-2 text-sm">
        <Link href="/admin/it-issues" className="text-splash-blue hover:underline">
          ← IT Issues
        </Link>
      </div>

      <IssueHeader issue={issue} />

      <div className="grid gap-5 lg:grid-cols-[1fr_380px]">
        <div className="space-y-5">
          <IssueDetails issue={issue} />
          <IssueTimeline events={events} />
        </div>

        <div className="space-y-5">
          <div id="happened-again" className={card}>
            <h2 className="mb-1 text-base font-bold text-splash-navy">It happened again</h2>
            <p className="mb-3 text-xs text-splash-navy/60">
              {resolved
                ? "This reopens the issue, so IT can see the fix didn't hold."
                : "Adds to this issue's count instead of starting a new one."}
            </p>
            <ActionForm action={occurrenceAction} className="space-y-3">
              <input type="hidden" name="id" value={issue.id} />
              <NameInput />
              <input name="error_text" maxLength={1000} placeholder="Error message (if any)" className={input} />
              <textarea name="note" rows={2} maxLength={4000} placeholder="Anything different this time?" className={input} />
              <SubmitButton pendingText="Logging…" className={btn}>
                Log occurrence
              </SubmitButton>
            </ActionForm>
          </div>

          {!resolved && (
            <div className={card}>
              <h2 className="mb-1 text-base font-bold text-splash-navy">Send to IT support now</h2>
              <p className="mb-3 text-xs text-splash-navy/60">
                Emails the full history of this issue to {escalate_to.length ? escalate_to.join(", ") : "IT support"}
                , with a link IT can use to add a ticket # or close it.
                {issue.last_escalated_at ? ` Last sent ${formatEt(issue.last_escalated_at)}.` : ""}
              </p>
              {escalate_to.length === 0 ? (
                <p className="text-sm text-racecar-red">No IT support address is configured yet.</p>
              ) : (
                <ActionForm action={escalateAction} className="space-y-3">
                  <input type="hidden" name="id" value={issue.id} />
                  <NameInput />
                  <textarea name="note" rows={2} maxLength={4000} placeholder="Message for IT (optional)" className={input} />
                  <SubmitButton pendingText="Sending…" className={btn}>
                    Send to IT support
                  </SubmitButton>
                </ActionForm>
              )}
            </div>
          )}

          <div className={card}>
            <h2 className="mb-3 text-base font-bold text-splash-navy">Update</h2>
            <ActionForm action={updateIssueAction} className="space-y-3">
              <input type="hidden" name="id" value={issue.id} />
              <NameInput />
              <div className="grid grid-cols-2 gap-2">
                <label className="block text-sm">
                  <span className="mb-1 block font-semibold text-splash-navy">Status</span>
                  <select name="status" defaultValue={issue.status} className={input}>
                    {STATUS_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block text-sm">
                  <span className="mb-1 block font-semibold text-splash-navy">Priority</span>
                  <select name="priority" defaultValue={issue.priority} className={input}>
                    {PRIORITY_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <label className="block text-sm">
                <span className="mb-1 block font-semibold text-splash-navy">IT ticket #</span>
                <input name="it_ticket_no" defaultValue={issue.it_ticket_no ?? ""} maxLength={60} className={input} />
              </label>
              <textarea name="note" rows={2} maxLength={4000} placeholder="Note (optional)" className={input} />
              {!resolved && (
                <label className="block text-sm">
                  <span className="mb-1 block font-semibold text-splash-navy">How was it resolved?</span>
                  <textarea name="resolution" rows={2} maxLength={4000} className={input}
                    placeholder="Required when setting the status to Resolved" />
                </label>
              )}
              <SubmitButton pendingText="Saving…" className={btn}>
                Save
              </SubmitButton>
            </ActionForm>
          </div>

          {mx_blocked_reason && !resolved && (
            <p className="px-1 text-xs text-splash-navy/60">
              <span className="font-semibold">MaintainX work request:</span> {mx_blocked_reason}
            </p>
          )}

          {mx_available && (
            <div className={card}>
              <h2 className="mb-1 text-base font-bold text-splash-navy">MaintainX</h2>
              <p className="mb-3 text-xs text-splash-navy/60">
                This issue is serious, repeating or already with IT, so it can go to MaintainX as a work request. Only
                create one if IT needs it tracked there - the number is saved on this issue.
              </p>
              <ActionForm action={mxRequestAction} className="space-y-3">
                <input type="hidden" name="id" value={issue.id} />
                <NameInput />
                <SubmitButton pendingText="Creating…" className={btn}>
                  Create MaintainX request
                </SubmitButton>
              </ActionForm>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
