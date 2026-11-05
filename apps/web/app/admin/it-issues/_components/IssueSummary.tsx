// Issue header, details and timeline. Shared by the signed-in issue page and
// the public email-link page so IT and the site see the same record.

import {
  PRIORITY_PILL,
  STATUS_PILL,
  customerRefs,
  deviceLabel,
  eventHeadline,
  formatEt,
  impactLabel,
  priorityLabel,
  statusLabel,
  type Issue,
  type IssueEvent
} from "../_lib/types";

export function IssueHeader({ issue }: { issue: Issue }) {
  return (
    <div className="mb-5">
      <p className="mb-1 text-xs font-semibold uppercase tracking-[0.18em] text-sudsy-blue">
        IT-{issue.ref_no} · {issue.site_name}
      </p>
      <h1 className="text-2xl font-bold text-splash-navy">
        {deviceLabel(issue)}: {issue.problem}
      </h1>
      <div className="mt-2 flex flex-wrap gap-2">
        <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${STATUS_PILL[issue.status]}`}>
          {statusLabel(issue.status)}
        </span>
        <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${PRIORITY_PILL[issue.priority]}`}>
          {priorityLabel(issue.priority)}
        </span>
        {issue.occurrence_count > 1 && (
          <span className="rounded-full bg-purple-50 px-2.5 py-0.5 text-xs font-semibold text-purple-800">
            Recurring · {issue.occurrence_count} times
          </span>
        )}
      </div>
    </div>
  );
}

export function IssueDetails({ issue }: { issue: Issue }) {
  const rows: Array<[string, string | null]> = [
    ["Site", issue.site_name],
    ["Device", deviceLabel(issue)],
    ["Error message", issue.error_text],
    ["Customer impact", impactLabel(issue.customer_impact)],
    ["Customer ticket #", issue.customer_ticket_no],
    ["Customer account #", issue.customer_account_no],
    ["First happened", formatEt(issue.first_reported_at)],
    ["Times it has happened", String(issue.occurrence_count)],
    ["Last happened", formatEt(issue.last_occurred_at)],
    ["Already tried", issue.troubleshooting],
    ["Reported by", `${issue.reporter_name} · ${issue.reporter_phone}`],
    ["IT ticket #", issue.it_ticket_no],
    ["MaintainX request", issue.mx_request_id ? `#${issue.mx_request_id}` : null],
    ["Last sent to IT", issue.last_escalated_at ? formatEt(issue.last_escalated_at) : null],
    ["Resolved", issue.resolved_at ? `${formatEt(issue.resolved_at)} by ${issue.resolved_by ?? "-"}` : null],
    ["Resolution", issue.resolution]
  ];
  return (
    <dl className="grid gap-x-6 gap-y-2 rounded-splash-md border-[1.5px] border-splash-navy/15 bg-white p-4 text-sm shadow-splash-card sm:grid-cols-[180px_1fr]">
      {rows
        .filter(([, v]) => v)
        .map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="font-semibold text-splash-navy/60">{k}</dt>
            <dd className="whitespace-pre-wrap text-splash-navy">{v}</dd>
          </div>
        ))}
    </dl>
  );
}

interface PhotoRef {
  file: string;
  name: string;
}

function photosOf(e: IssueEvent): PhotoRef[] {
  const p = e.details?.photos;
  return Array.isArray(p) ? (p as PhotoRef[]).filter((x) => typeof x?.file === "string") : [];
}

/**
 * `photoBase` is the URL prefix photos are served under -- the signed-in
 * proxy or the email-link proxy -- so both pages render the same timeline.
 */
/** When it happened leads; the logged time follows only when a site logged it
 *  well after the fact. */
function eventWhen(e: IssueEvent): string {
  const happened = e.occurred_at ?? e.at;
  const late = Math.abs(Date.parse(e.at) - Date.parse(happened)) >= 15 * 60_000;
  return late ? `${formatEt(happened)} · logged ${formatEt(e.at)}` : formatEt(happened);
}

export function IssueTimeline({ events, photoBase }: { events: IssueEvent[]; photoBase: string }) {
  return (
    <div className="rounded-splash-md border-[1.5px] border-splash-navy/15 bg-white p-4 shadow-splash-card">
      <h2 className="mb-3 text-base font-bold text-splash-navy">Timeline</h2>
      <ol className="space-y-3 border-l-2 border-gray-light pl-4">
        {events.map((e) => (
          <li key={e.id} className="text-sm">
            <div className="font-semibold text-splash-navy">{eventHeadline(e)}</div>
            <div className="text-xs text-splash-navy/60">
              {eventWhen(e)}
              {e.actor_name ? ` · ${e.actor_name}` : ""}
              {e.via === "email_link" ? " · via email link" : ""}
            </div>
            {e.kind === "occurrence" && customerRefs(e.details?.customer_ticket_no, e.details?.customer_account_no) && (
              <p className="mt-1 text-splash-navy/90">
                {customerRefs(e.details?.customer_ticket_no, e.details?.customer_account_no)}
              </p>
            )}
            {e.note && <p className="mt-1 whitespace-pre-wrap text-splash-navy/90">{e.note}</p>}
            {photosOf(e).length > 0 && (
              <div className="mt-2 flex flex-wrap gap-2">
                {photosOf(e).map((p) => (
                  <a key={p.file} href={`${photoBase}/${p.file}`} target="_blank" rel="noreferrer" title={p.name}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={`${photoBase}/${p.file}`}
                      alt={p.name}
                      loading="lazy"
                      className="h-24 w-24 rounded-splash-sm border border-gray-light object-cover"
                    />
                  </a>
                ))}
              </div>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}
