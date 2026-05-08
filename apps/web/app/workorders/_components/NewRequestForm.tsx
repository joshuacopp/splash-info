"use client";

// Brief 74 — New Request tab. Plain HTML form posts directly to
// `/workorders/api/request` as multipart/form-data, bypassing Next 15
// server actions. Same posture as the damage-document upload path
// (Brief 37/38) — server actions running on OpenNext-on-CF-Workers
// have flaky multipart behavior, while a plain form lets the worker
// 303-redirect back to /workorders?tab=new&request_ok=N reliably.
//
// On success the worker redirects to /workorders?tab=new&request_ok=<id>
// (with optional &request_warn=...-photos-failed when some uploads failed
// post-create); on failure it redirects with &request_error=<message>.
// `WorkOrdersTabsClient` reads those params and renders a banner above
// this form on the next page render.

import type { AccessibleLocation, WorkOrdersCurrentUser } from "../_lib/worker-fetch";

interface Props {
  accessibleLocations: AccessibleLocation[];
  currentUser: WorkOrdersCurrentUser;
}

export function NewRequestForm({ accessibleLocations, currentUser }: Props) {
  const mappable = accessibleLocations.filter(
    (l) => typeof l.maintainx_id === "number" && Number.isFinite(l.maintainx_id)
  );

  if (mappable.length === 0) {
    return (
      <div className="rounded-splash-lg border border-yellow-300 bg-yellow-50 px-6 py-6">
        <h2 className="text-base font-semibold text-yellow-900">
          No MaintainX-mapped locations on your account.
        </h2>
        <p className="mt-2 text-sm text-yellow-900/90">
          A super_admin needs to add your email to{" "}
          <code className="rounded bg-yellow-100 px-1">am_email</code>,{" "}
          <code className="rounded bg-yellow-100 px-1">rm_email</code>, or{" "}
          <code className="rounded bg-yellow-100 px-1">site_email</code> on a
          location whose <code className="rounded bg-yellow-100 px-1">maintainx_id</code>{" "}
          is set before you can file a request.
        </p>
      </div>
    );
  }

  return (
    <form
      action="/workorders/api/request"
      method="POST"
      encType="multipart/form-data"
      className="space-y-5 rounded-splash-lg border border-gray-light bg-white p-6 shadow-splash-card"
    >
      <FieldRow label="Location" htmlFor="nr-location" required>
        <select
          id="nr-location"
          name="location_id"
          required
          defaultValue=""
          className="w-full rounded-splash-md border border-gray-light bg-white px-3 py-2 text-sm text-splash-navy focus:border-splash-blue focus:outline-none focus:ring-1 focus:ring-splash-blue"
        >
          <option value="" disabled>
            Pick a location…
          </option>
          {mappable.map((loc) => (
            <option key={loc.maintainx_id ?? 0} value={String(loc.maintainx_id)}>
              {loc.location_name ?? loc.location_address ?? `Location #${loc.maintainx_id}`}
            </option>
          ))}
        </select>
      </FieldRow>

      <FieldRow label="Request Title" htmlFor="nr-title" required>
        <input
          id="nr-title"
          name="title"
          type="text"
          required
          maxLength={120}
          className="w-full rounded-splash-md border border-gray-light bg-white px-3 py-2 text-sm text-splash-navy focus:border-splash-blue focus:outline-none focus:ring-1 focus:ring-splash-blue"
          placeholder="Short summary of the issue"
        />
      </FieldRow>

      <FieldRow label="Priority" htmlFor="nr-priority-medium" required>
        <div className="flex flex-wrap items-center gap-3">
          <PriorityRadio value="HIGH" label="High" />
          <PriorityRadio value="MEDIUM" label="Medium" />
          <PriorityRadio value="LOW" label="Low" />
        </div>
      </FieldRow>

      <FieldRow
        label="Description of Issue and Troubleshooting Performed"
        htmlFor="nr-description"
        required
      >
        <textarea
          id="nr-description"
          name="description"
          required
          maxLength={4000}
          rows={6}
          className="w-full rounded-splash-md border border-gray-light bg-white px-3 py-2 text-sm text-splash-navy focus:border-splash-blue focus:outline-none focus:ring-1 focus:ring-splash-blue"
          placeholder="What's wrong, what you've tried, when it started…"
        />
      </FieldRow>

      <FieldRow label="Requester Name" htmlFor="nr-requester-name" required>
        <input
          id="nr-requester-name"
          name="requester_name"
          type="text"
          required
          maxLength={80}
          defaultValue={currentUser.full_name ?? ""}
          className="w-full rounded-splash-md border border-gray-light bg-white px-3 py-2 text-sm text-splash-navy focus:border-splash-blue focus:outline-none focus:ring-1 focus:ring-splash-blue"
        />
      </FieldRow>

      <FieldRow label="Requester Phone" htmlFor="nr-requester-phone" required>
        <input
          id="nr-requester-phone"
          name="requester_phone"
          type="tel"
          required
          maxLength={30}
          className="w-full rounded-splash-md border border-gray-light bg-white px-3 py-2 text-sm text-splash-navy focus:border-splash-blue focus:outline-none focus:ring-1 focus:ring-splash-blue"
        />
      </FieldRow>

      {/* Brief 76: multi-photo restored. The MaintainX work-request
          attachment URL is /v1/workrequests/{id}/attachments/{filename}
          (plural) — Brief 74 inferred singular from the doc heading and
          Brief 75 retired multi-photo on the wrong diagnosis. With the
          plural path, photo[0] uploads as the thumbnail and photo[1..4]
          attach to the request. Worker enforces the 5-cap server-side. */}
      <FieldRow label="Photo(s) (optional)" htmlFor="nr-photos">
        <input
          id="nr-photos"
          name="photo"
          type="file"
          accept="image/*"
          multiple
          className="block w-full text-sm text-splash-navy file:mr-3 file:rounded-splash-md file:border-0 file:bg-splash-navy file:px-3 file:py-2 file:text-sm file:font-semibold file:text-white hover:file:bg-splash-blue-dark"
        />
        <p className="mt-1 text-xs text-splash-navy/60">
          Photo(s) (optional, max 5). First photo becomes the thumbnail;
          additional photos attach to the request.
        </p>
      </FieldRow>

      <div className="pt-2">
        <button
          type="submit"
          className="rounded-splash-md bg-splash-navy px-5 py-2 text-sm font-semibold text-white shadow-splash-btn hover:bg-splash-blue-dark"
        >
          Submit request
        </button>
      </div>
    </form>
  );
}

function FieldRow({
  label,
  htmlFor,
  required,
  children
}: {
  label: string;
  htmlFor: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label
        htmlFor={htmlFor}
        className="mb-1 block text-sm font-semibold text-splash-navy"
      >
        {label}
        {required ? <span className="ml-1 text-splash-deny">*</span> : null}
      </label>
      {children}
    </div>
  );
}

function PriorityRadio({ value, label }: { value: "HIGH" | "MEDIUM" | "LOW"; label: string }) {
  return (
    <label className="inline-flex items-center gap-2 rounded-full border border-gray-light bg-white px-3 py-1.5 text-sm text-splash-navy hover:bg-gray-light/40">
      <input
        id={`nr-priority-${value.toLowerCase()}`}
        type="radio"
        name="priority"
        value={value}
        required
        className="h-4 w-4"
      />
      {label}
    </label>
  );
}
