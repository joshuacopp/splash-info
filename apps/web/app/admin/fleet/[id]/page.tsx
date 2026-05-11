// Fleet inquiry detail (Brief 83). Server component. Fetches one
// fleet_submissions row via the FLEET_INQUIRY_WORKER service binding and
// renders every column in a 2-column key/value grid. Brief 87 added the
// editable Splash Notes textarea at the top of the page; Brief 105 added
// the Status dropdown alongside it (both persisted via the same single
// ActionForm submit so notes + status changes ride one PATCH).

import Link from "next/link";
import { notFound } from "next/navigation";
import { getFleetSubmission } from "../_lib/worker-fetch";
import { FLEET_STATUS_OPTIONS } from "../_lib/constants";
import { ActionForm } from "../../_components/ActionForm";
import { updateSubmissionAction } from "./actions";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function FleetSubmissionDetailPage({ params }: PageProps) {
  const { id } = await params;

  let detail: Awaited<ReturnType<typeof getFleetSubmission>>;
  let fetchError: string | null = null;
  try {
    detail = await getFleetSubmission(id);
  } catch (err) {
    detail = null;
    fetchError = err instanceof Error ? err.message : "unknown error";
  }

  if (detail === null && fetchError === null) {
    // Either 401/403 (no access) or 404 (not found). The worker returns 404
    // for missing rows; fleetGetJson collapses both to null. Render notFound
    // for a clean 404 chrome rather than the no-access card — the typical
    // path here is "operator clicked a stale link".
    notFound();
  }

  if (fetchError) {
    return (
      <section className="mx-auto w-full max-w-[820px] px-5 py-9">
        <div className="mb-2 text-sm">
          <Link href="/admin/fleet" className="text-splash-blue hover:underline">
            ← All submissions
          </Link>
        </div>
        <h1 className="mb-3 text-2xl font-bold text-splash-navy">
          Fleet Inquiry
        </h1>
        <p className="text-racecar-red">
          Failed to load submission: {fetchError}
        </p>
      </section>
    );
  }

  const row = detail!.row;
  const fields: Array<{ label: string; value: React.ReactNode }> = [
    { label: "ID", value: <code className="text-xs">{row.id}</code> },
    { label: "Created at", value: formatAbsolute(row.created_at) },
    { label: "Submitted at", value: formatAbsolute(row.submitted_at) },
    { label: "Company", value: row.company ?? em() },
    { label: "Contact name", value: row.name ?? em() },
    { label: "Email", value: row.email ?? em() },
    { label: "Phone", value: formatPhone(row.phone) ?? em() },
    { label: "Address", value: row.address ?? em() },
    { label: "Location", value: locationLabel(row.location_pretty, row.location_code) },
    { label: "Service type", value: row.service_type ?? em() },
    { label: "Packages", value: row.packages ?? em() },
    {
      label: "Packages detail",
      value:
        row.packages_detail == null ? (
          em()
        ) : (
          <pre className="overflow-x-auto rounded-splash-sm bg-gray-light/40 p-2 text-xs text-splash-navy/80">
            {JSON.stringify(row.packages_detail, null, 2)}
          </pre>
        )
    },
    { label: "Detailing requested", value: row.detailing_requested ? "Yes" : "No" },
    {
      label: "Detailing location",
      value: locationLabel(row.detailing_location_pretty, row.detailing_location_code)
    },
    { label: "Number of vehicles", value: row.number_of_vehicles ?? em() },
    {
      label: "Anticipated washes per month",
      value: row.anticipated_washes_per_month ?? em()
    },
    { label: "Status", value: row.status ?? em() },
    {
      label: "Splash notes",
      value: row.splash_notes ? (
        <pre className="whitespace-pre-wrap font-sans text-sm text-splash-navy">
          {row.splash_notes}
        </pre>
      ) : (
        em()
      )
    },
    { label: "IP address", value: row.ip_address ?? em() },
    { label: "User agent", value: row.user_agent ?? em() }
  ];

  const saveSubmission = updateSubmissionAction.bind(null, id);
  const defaultStatus =
    row.status && FLEET_STATUS_OPTIONS.includes(row.status as (typeof FLEET_STATUS_OPTIONS)[number])
      ? row.status
      : "new";

  return (
    <section className="mx-auto w-full max-w-[820px] px-5 py-9">
      <div className="mb-2 text-sm">
        <Link href="/admin/fleet" className="text-splash-blue hover:underline">
          ← All submissions
        </Link>
      </div>
      <h1 className="mb-1 text-2xl font-bold text-splash-navy">
        {row.company ?? "Fleet Inquiry"}
      </h1>
      <p className="mb-5 text-sm text-splash-navy/70">
        Submitted {formatRelative(row.created_at)} ·{" "}
        {row.name ?? "(no contact name)"}
      </p>

      <section className="mb-6 rounded-md border border-gray-light bg-white p-5">
        <h2 className="mb-2 text-lg font-semibold text-splash-navy">
          Status &amp; Notes
        </h2>
        <p className="mb-3 text-xs text-splash-navy/60">
          Status and internal notes. Saving fires a sync to SharePoint via
          Power Automate (Brief 105). Visible to all admin / super_admin
          users.
        </p>
        <ActionForm action={saveSubmission} resetOnSuccess={false}>
          <div className="mb-3">
            <label
              htmlFor="fleet-status"
              className="mb-1 block text-xs font-semibold uppercase tracking-wide text-splash-navy/70"
            >
              Status
            </label>
            <select
              id="fleet-status"
              name="status"
              defaultValue={defaultStatus}
              className="block rounded-splash-md border border-gray-light bg-white px-3 py-2 text-sm text-splash-navy focus:border-splash-blue focus:outline-none focus:ring-1 focus:ring-splash-blue"
            >
              {FLEET_STATUS_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
          <label
            htmlFor="fleet-splash-notes"
            className="mb-1 block text-xs font-semibold uppercase tracking-wide text-splash-navy/70"
          >
            Splash Notes
          </label>
          <textarea
            id="fleet-splash-notes"
            name="splash_notes"
            defaultValue={row.splash_notes ?? ""}
            rows={6}
            maxLength={10000}
            className="block w-full rounded-splash-md border border-gray-light bg-white px-3 py-2 text-sm text-splash-navy focus:border-splash-blue focus:outline-none focus:ring-1 focus:ring-splash-blue"
          />
          <button
            type="submit"
            className="mt-2 rounded-splash-md bg-splash-navy px-4 py-2 text-sm font-semibold text-white hover:bg-splash-blue-dark"
          >
            Save
          </button>
        </ActionForm>
      </section>

      <div className="overflow-hidden rounded-splash-md border border-gray-light bg-white">
        <dl className="divide-y divide-gray-light">
          {fields.map((f) => (
            <div
              key={f.label}
              className="grid grid-cols-1 gap-1 px-4 py-3 sm:grid-cols-[180px_1fr] sm:gap-4"
            >
              <dt className="text-xs font-semibold uppercase tracking-wide text-splash-navy/60">
                {f.label}
              </dt>
              <dd className="text-sm text-splash-navy">{f.value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}

function em(): React.ReactNode {
  return <span className="text-splash-navy/50">—</span>;
}

function locationLabel(
  pretty: string | null,
  code: string | null
): React.ReactNode {
  if (!pretty && !code) return em();
  if (pretty && code && pretty !== code) {
    return (
      <>
        {pretty}{" "}
        <code className="ml-1 text-xs text-splash-navy/60">{code}</code>
      </>
    );
  }
  return pretty ?? code;
}

function formatAbsolute(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

function formatRelative(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const ms = Date.now() - d.getTime();
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day} day${day === 1 ? "" : "s"} ago`;
  return formatAbsolute(iso);
}

function formatPhone(raw: string | null): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  return raw;
}
