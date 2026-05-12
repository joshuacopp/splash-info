// Brief 109 — JotForm admin index (/admin/jotform).
//
// Server component. Admin-tier gated (super_admin role OR dcRole
// admin/super_admin). Backs onto the jotform-worker's
// `/admin/jotform/api/forms` endpoint via the JOTFORM_WORKER service
// binding. RM / RD / GM hits this page are no-access-carded; they can
// still navigate per-form URLs by bookmark and the worker scopes their
// rows automatically (Brief 107).

import Link from "next/link";
import { getMe } from "../../_lib/me";
import { listForms, type JotformForm } from "./_lib/worker-fetch";
import NoAccessCard from "./_components/NoAccessCard";

export const dynamic = "force-dynamic";

export default async function JotformIndexPage() {
  const session = await getMe().catch(() => null);
  if (!session) {
    return <NoAccessCard reason="signin" returnPath="/admin/jotform" />;
  }

  const allowed =
    session.role === "super_admin" ||
    session.dcRole === "admin" ||
    session.dcRole === "super_admin";
  if (!allowed) {
    return <NoAccessCard reason="forbidden" />;
  }

  let forms: JotformForm[] | null = null;
  let fetchError: string | null = null;
  try {
    const res = await listForms();
    forms = res?.forms ?? null;
  } catch (err) {
    fetchError = err instanceof Error ? err.message : String(err);
  }

  return (
    <section className="mx-auto w-full max-w-[1100px] px-5 py-9">
      <div className="mb-2 text-sm">
        <Link href="/admin/dashboard" className="text-splash-blue hover:underline">
          ← Dashboard
        </Link>
      </div>

      <div className="mb-6">
        <p className="mb-1 text-xs font-semibold uppercase tracking-[0.18em] text-sudsy-blue">
          Internal Tools
        </p>
        <h1 className="text-2xl font-bold text-splash-navy">JotForm</h1>
        <p className="mt-1 text-sm text-splash-navy/70">
          Browse submissions ingested from JotForm Enterprise forms. RM / RD
          / GM views are scoped to your locations automatically.
        </p>
      </div>

      {fetchError && (
        <p className="mb-5 rounded-splash-md border border-racecar-red bg-white px-3 py-2 text-racecar-red">
          Failed to load forms: {fetchError}
        </p>
      )}

      {forms === null && !fetchError && (
        <div className="rounded-splash-md border border-gray-light bg-white px-4 py-6 italic text-splash-navy/60">
          JotForm worker not configured. The <code>JOTFORM_WORKER</code>{" "}
          service binding is unavailable in this environment. Try again
          after the operator binds it.
        </div>
      )}

      {forms && forms.length === 0 && (
        <div className="rounded-splash-md border border-gray-light bg-white px-4 py-6 text-center italic text-splash-navy/60">
          No JotForm forms are registered yet. The operator can enable a
          form by inserting a row into <code>jotform_forms</code>.
        </div>
      )}

      {forms && forms.length > 0 && (
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {forms.map((f) => (
            <Link
              key={f.form_id}
              href={`/admin/jotform/${encodeURIComponent(f.form_id)}`}
              className="group flex flex-col overflow-hidden rounded-splash-lg border-[3px] border-splash-navy bg-white text-splash-navy shadow-splash-card transition-transform duration-150 hover:-translate-y-1 hover:shadow-splash-card-hover"
            >
              <div className="flex items-center gap-4 bg-gradient-to-br from-splash-blue to-splash-navy px-6 py-5">
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-[0.6875rem] font-semibold uppercase tracking-[0.16em] text-sudsy-blue">
                    JotForm
                  </span>
                  <span className="text-lg font-bold leading-tight text-white">
                    {f.display_name}
                  </span>
                </div>
              </div>
              <div className="flex flex-1 flex-col justify-between gap-3.5 px-6 pb-5 pt-4">
                <div>
                  <p className="text-[0.9375rem] leading-relaxed text-splash-navy/80">
                    <span className="font-semibold text-splash-navy">
                      {f.submission_count.toLocaleString()}
                    </span>{" "}
                    submission{f.submission_count === 1 ? "" : "s"} on record.
                  </p>
                  <p className="mt-1 text-xs text-splash-navy/60">
                    <code>{f.slug}</code>
                  </p>
                </div>
                <span className="inline-flex items-center gap-1.5 self-start text-[0.8125rem] font-bold uppercase tracking-[0.08em] text-splash-blue">
                  View
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2.5}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="h-3.5 w-3.5 transition-transform duration-200 group-hover:translate-x-1"
                    aria-hidden="true"
                  >
                    <line x1="5" y1="12" x2="19" y2="12" />
                    <polyline points="12 5 19 12 12 19" />
                  </svg>
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}
