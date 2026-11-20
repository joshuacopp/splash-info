// /admin/safety-topics — the safety committee's required topics per month.
//
// Every site holds a safety meeting at the start of each month and records it
// on the "Monthly Safety Meeting" form. Topics set here for a month appear on
// that form (for meetings dated in that month) as a checklist every site must
// tick as covered. A month left empty has no mandatory topics.
//
// ACCESS: anyone signed in can READ (site managers can see what is coming);
// EDITING needs admin tier or the `safety_committee` access grant (Sysadmin ->
// the user -> Tools). The worker decides; this page renders what it is given.
//
// Data: form_required_topics (supabase/safety-meeting-01.sql). API:
// apps/forms-worker/src/required-topics/.

import { ActionForm } from "../_components/ActionForm";
import { SubmitButton } from "../_components/SubmitButton";
import { getRequiredTopicsAdmin, type RequiredTopicsMonth } from "../forms/_lib/worker-fetch";
import { saveTopicsAction } from "./actions";

export const dynamic = "force-dynamic";

const CARD = "rounded-splash-lg border border-gray-light bg-white p-5 shadow-splash-card";
const BTN =
  "rounded-splash-sm bg-splash-blue px-4 py-2 text-sm font-bold text-white shadow-splash-btn hover:bg-splash-blue-dark disabled:opacity-60";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
];

function monthLabel(m: string): string {
  const [y, mm] = m.split("-");
  return `${MONTHS[Number(mm) - 1] ?? mm} ${y}`;
}

function stamp(m: RequiredTopicsMonth): string | null {
  if (!m.updated_at) return null;
  const when = new Date(m.updated_at).toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    year: "numeric"
  });
  return `Last changed ${when}${m.updated_by_email ? ` by ${m.updated_by_email}` : ""}`;
}

export default async function SafetyTopicsPage() {
  const data = await getRequiredTopicsAdmin("safety_meeting");
  if (!data) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-8">
        <div className={CARD}>
          <h1 className="text-xl font-bold text-splash-navy">Safety meeting topics</h1>
          <p className="mt-2 text-sm text-splash-navy/70">
            This page couldn&rsquo;t be loaded. Sign in again, or try again in a minute.
          </p>
        </div>
      </main>
    );
  }

  const upcoming = data.months.filter((m) => m.month >= data.current_month);
  const past = data.months.filter((m) => m.month < data.current_month).reverse();

  return (
    <main className="mx-auto max-w-3xl space-y-4 px-4 py-8">
      <div>
        <h1 className="text-2xl font-bold text-splash-navy">Safety meeting topics</h1>
        <p className="mt-1 text-sm text-splash-navy/70">
          Topics set for a month must be covered, and ticked off, at every site&rsquo;s safety meeting
          held that month. Leave a month empty for no mandatory topics.
          {!data.can_edit && " Only admins and the safety committee can change them."}
        </p>
      </div>

      {upcoming.map((m) => (
        <MonthCard key={m.month} m={m} canEdit={data.can_edit} isCurrent={m.month === data.current_month} />
      ))}

      {past.length > 0 && (
        <details className={CARD}>
          <summary className="cursor-pointer text-sm font-semibold text-splash-navy">Previous months</summary>
          <div className="mt-3 space-y-3">
            {past.map((m) => (
              <div key={m.month}>
                <p className="text-sm font-semibold text-splash-navy">{monthLabel(m.month)}</p>
                <TopicList topics={m.topics} />
              </div>
            ))}
          </div>
        </details>
      )}
    </main>
  );
}

function TopicList({ topics }: { topics: string[] }) {
  if (topics.length === 0) return <p className="text-sm text-splash-navy/50">No required topics.</p>;
  return (
    <ul className="ml-5 list-disc text-sm text-splash-navy">
      {topics.map((t) => (
        <li key={t}>{t}</li>
      ))}
    </ul>
  );
}

function MonthCard({ m, canEdit, isCurrent }: { m: RequiredTopicsMonth; canEdit: boolean; isCurrent: boolean }) {
  const when = stamp(m);
  return (
    <section className={CARD}>
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-lg font-bold text-splash-navy">
          {monthLabel(m.month)}
          {isCurrent && (
            <span className="ml-2 rounded-full bg-sudsy-blue-soft px-2 py-0.5 text-xs font-semibold text-splash-navy">
              This month
            </span>
          )}
        </h2>
        {when && <span className="text-xs text-splash-navy/50">{when}</span>}
      </div>
      {canEdit ? (
        <ActionForm action={saveTopicsAction} resetOnSuccess={false} className="mt-3 space-y-2">
          <input type="hidden" name="month" value={m.month} />
          <label className="block text-xs font-semibold uppercase tracking-wider text-splash-navy/70">
            Required topics, one per line
          </label>
          <textarea
            name="topics"
            rows={Math.max(3, m.topics.length + 1)}
            defaultValue={m.topics.join("\n")}
            placeholder={"e.g. Salt logs\nPPE for power tools"}
            className="w-full rounded-splash-sm border border-gray-light bg-white px-3 py-2 text-sm text-splash-navy focus:border-splash-blue focus:outline-none"
          />
          <SubmitButton className={BTN} pendingText="Saving…">
            Save {monthLabel(m.month)}
          </SubmitButton>
        </ActionForm>
      ) : (
        <div className="mt-2">
          <TopicList topics={m.topics} />
        </div>
      )}
    </section>
  );
}
