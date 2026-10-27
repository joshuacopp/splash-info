// /admin/damage/vehicles — Vehicle Guide admin.
//
// Known problem vehicles (won't go into neutral, shifts itself into park,
// safety systems that fight the conveyor) and what to do about each. Site
// staff read the same entries on the public token page the damage-worker
// serves at /claims/vehicles/{token}; this page is where they are written.
//
// Reads: anyone with a damage role. Writes: damage RM and above -- the worker
// enforces it and reports `can_edit`, which is the only thing this page uses
// to decide whether to show the forms.
//
// `?edit={id}` swaps the add form for that entry's edit form plus its photo
// and video manager. New entries land there automatically so media can be
// attached straight away.

import Link from "next/link";
import {
  MAX_YOUTUBE_LINKS,
  VEHICLE_ISSUE_TYPES,
  parseYouTubeUrl,
  youTubeEmbedUrl,
  type VehicleIssuesResponse
} from "@splash/types/vehicle-guide";
import { damageGetJsonOrStatus } from "../_lib/worker-fetch";
import { DamageTabs } from "../_components/DamageTabs";
import { RedirectForm } from "../../_components/RedirectForm";
import { SaveCarCountButton as SaveButton } from "../car-counts/_components/SaveCarCountButton";
import { ConfirmDeleteButton } from "./_components/ConfirmDeleteButton";
import { MediaUploader } from "./_components/MediaUploader";
import { PublicLinkCard } from "./_components/PublicLinkCard";
import { VehicleList } from "./_components/VehicleList";
import {
  deleteVehicleMediaAction,
  saveVehicleIssueAction
} from "./actions";

const LIST_PATH = "/admin/damage/vehicles";
const MAX_MEDIA = 8;

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function firstParam(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v) ?? "";
}

const SUCCESS_COPY: Record<string, string> = {
  created: "Entry added. Add photos or videos below if you have them.",
  saved: "Entry saved.",
  deleted: "Entry deleted.",
  media_deleted: "File removed."
};

const LABEL_CLS = "text-xs font-semibold uppercase tracking-wider text-splash-navy/70";
const INPUT_CLS =
  "rounded-splash-sm border border-gray-light bg-white px-3 py-2 text-sm text-splash-navy placeholder:text-splash-navy/40 focus:border-splash-blue focus:outline-none";
const CARD_CLS = "rounded-splash-lg border border-gray-light bg-white p-5 shadow-splash-card";

export default async function VehicleGuideAdminPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const actionError = firstParam(sp.action_error).trim() || null;
  const successMessage = SUCCESS_COPY[firstParam(sp.success).trim()] ?? null;
  const editId = Number(firstParam(sp.edit)) || null;

  const res = await damageGetJsonOrStatus<VehicleIssuesResponse>("/manage/api/vehicle-issues");

  if (!("data" in res)) {
    const message =
      res.status === 401
        ? "Your session has expired. Sign out and back in."
        : res.status === 403
          ? "You don't have access to the Vehicle Guide. It needs a damage role; contact your administrator if this is unexpected."
          : `Could not load the Vehicle Guide (worker returned ${res.status}). Reload to retry.`;
    return (
      <Shell>
        <div className={CARD_CLS}>
          <p className="text-splash-deny">{message}</p>
          {res.status === 401 ? (
            <Link
              href={`/logout?return=${encodeURIComponent(LIST_PATH)}`}
              className="mt-4 inline-flex rounded-splash-sm bg-splash-blue px-5 py-2.5 text-sm font-bold text-white shadow-splash-btn"
            >
              Sign in again
            </Link>
          ) : null}
        </div>
      </Shell>
    );
  }

  const { issues, can_edit: canEdit, public_path: publicPath } = res.data;
  const editing = editId ? issues.find((i) => i.id === editId) ?? null : null;

  // For the make / model datalists on the form.
  const makes = Array.from(new Set(issues.map((i) => i.make))).sort((a, b) => a.localeCompare(b));
  const allModels = Array.from(new Set(issues.map((i) => i.model))).sort((a, b) => a.localeCompare(b));

  return (
    <Shell>
      {actionError ? <Banner kind="error" message={actionError} /> : null}
      {successMessage ? <Banner kind="success" message={successMessage} /> : null}

      {canEdit && publicPath ? <PublicLinkCard path={publicPath} /> : null}
      {canEdit && !publicPath ? (
        <div className="mb-6 rounded-splash-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          The public page is off: the damage worker has no <code>VEHICLE_GUIDE_TOKEN</code> secret
          (or it is shorter than 16 characters). Entries can still be added here.
        </div>
      ) : null}

      {canEdit ? (
        <div className={`mb-6 ${CARD_CLS}`} id="editor">
          <div className="mb-4 flex items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-bold text-splash-navy">
                {editing ? `Edit: ${editing.make} ${editing.model}` : "Add a vehicle"}
              </h2>
              <p className="text-sm text-splash-navy/70">
                Years are a range: a 2017–2022 entry shows under every one of those years. Leave
                &lsquo;To&rsquo; blank if it still applies to new models.
              </p>
            </div>
            {editing ? (
              <Link href={LIST_PATH} className="text-sm font-semibold text-splash-blue underline">
                Cancel
              </Link>
            ) : null}
          </div>

          <RedirectForm
            key={editing?.id ?? "new"}
            action={saveVehicleIssueAction}
            className="flex flex-col gap-4"
          >
            {editing ? <input type="hidden" name="id" value={editing.id} /> : null}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <label className="flex flex-col gap-1">
                <span className={LABEL_CLS}>Make *</span>
                <input
                  name="make"
                  required
                  maxLength={60}
                  list="vg-makes"
                  defaultValue={editing?.make ?? ""}
                  placeholder="Toyota"
                  className={INPUT_CLS}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className={LABEL_CLS}>Model *</span>
                <input
                  name="model"
                  required
                  maxLength={80}
                  list="vg-models"
                  defaultValue={editing?.model ?? ""}
                  placeholder="Prius"
                  className={INPUT_CLS}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className={LABEL_CLS}>Year from *</span>
                <input
                  name="year_from"
                  type="number"
                  required
                  min={1950}
                  step={1}
                  inputMode="numeric"
                  defaultValue={editing?.year_from ?? ""}
                  placeholder="2016"
                  className={INPUT_CLS}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className={LABEL_CLS}>Year to</span>
                <input
                  name="year_to"
                  type="number"
                  min={1950}
                  step={1}
                  inputMode="numeric"
                  defaultValue={editing?.year_to ?? ""}
                  placeholder="blank = and newer"
                  className={INPUT_CLS}
                />
              </label>
              <label className="flex flex-col gap-1 sm:col-span-2 lg:col-span-4">
                <span className={LABEL_CLS}>Issue type *</span>
                <select
                  name="issue_type"
                  required
                  defaultValue={editing?.issue_type ?? ""}
                  className={INPUT_CLS}
                >
                  <option value="" disabled>
                    Select…
                  </option>
                  {VEHICLE_ISSUE_TYPES.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 sm:col-span-2">
                <span className={LABEL_CLS}>Issue *</span>
                <textarea
                  name="issue"
                  required
                  maxLength={2000}
                  rows={5}
                  defaultValue={editing?.issue ?? ""}
                  placeholder="What happens. e.g. Shifts itself into Park when the driver's door opens."
                  className={INPUT_CLS}
                />
              </label>
              <label className="flex flex-col gap-1 sm:col-span-2">
                <span className={LABEL_CLS}>Solution *</span>
                <textarea
                  name="solution"
                  required
                  maxLength={4000}
                  rows={5}
                  defaultValue={editing?.solution ?? ""}
                  placeholder={"What to tell the driver, step by step.\n1. Engine running, foot on brake\n2. …"}
                  className={INPUT_CLS}
                />
              </label>
              <label className="flex flex-col gap-1 sm:col-span-2 lg:col-span-4">
                <span className={LABEL_CLS}>YouTube videos</span>
                <textarea
                  name="youtube_links"
                  rows={2}
                  defaultValue={editing?.youtube_links.join("\n") ?? ""}
                  placeholder={"https://youtu.be/…  (one link per line)"}
                  className={INPUT_CLS}
                />
                <span className="text-xs text-splash-navy/60">
                  Optional, up to {MAX_YOUTUBE_LINKS}. Paste the link from the video&rsquo;s Share
                  button; it plays right on the staff page. A start time in the link (&amp;t=90s)
                  is kept.
                </span>
              </label>
            </div>
            <datalist id="vg-makes">
              {makes.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
            <datalist id="vg-models">
              {allModels.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
            <div>
              <SaveButton>{editing ? "Save changes" : "Add vehicle"}</SaveButton>
            </div>
          </RedirectForm>

          {editing && editing.youtube_links.length ? (
            <div className="mt-6 border-t border-gray-light pt-5">
              <h3 className="mb-3 text-sm font-bold uppercase tracking-wider text-splash-navy/70">
                YouTube preview
              </h3>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {editing.youtube_links.map((u) => {
                  const ref = parseYouTubeUrl(u);
                  return ref ? (
                    <iframe
                      key={u}
                      src={youTubeEmbedUrl(ref)}
                      title={`Video: ${editing.make} ${editing.model}`}
                      loading="lazy"
                      referrerPolicy="strict-origin-when-cross-origin"
                      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                      allowFullScreen
                      className="aspect-video w-full rounded-splash-sm bg-black"
                    />
                  ) : null;
                })}
              </div>
            </div>
          ) : null}

          {editing ? (
            <div id="media" className="mt-6 border-t border-gray-light pt-5">
              <h3 className="mb-3 text-sm font-bold uppercase tracking-wider text-splash-navy/70">
                Photos &amp; videos ({editing.media.length} of {MAX_MEDIA})
              </h3>
              {editing.media.length ? (
                <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                  {editing.media.map((m) => {
                    const src = `/manage/api/vehicle-issues/media/${m.id}`;
                    return (
                      <div key={m.id} className="flex flex-col gap-1.5">
                        {m.kind === "video" ? (
                          <video
                            src={src}
                            controls
                            playsInline
                            preload="metadata"
                            className="aspect-video w-full rounded-splash-sm bg-black"
                          />
                        ) : (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={src}
                            alt={m.original_filename ?? ""}
                            loading="lazy"
                            className="aspect-[4/3] w-full rounded-splash-sm bg-splash-navy/5 object-cover"
                          />
                        )}
                        <RedirectForm action={deleteVehicleMediaAction}>
                          <input type="hidden" name="media_id" value={m.id} />
                          <input type="hidden" name="issue_id" value={editing.id} />
                          <ConfirmDeleteButton
                            label="Remove"
                            confirmText={`Remove this ${m.kind} from ${editing.make} ${editing.model}?`}
                          />
                        </RedirectForm>
                      </div>
                    );
                  })}
                </div>
              ) : null}
              <MediaUploader issueId={editing.id} remaining={MAX_MEDIA - editing.media.length} />
            </div>
          ) : null}
        </div>
      ) : (
        <p className="mb-6 text-sm text-splash-navy/70">
          You can read the guide. Adding or changing entries needs a damage regional manager role
          or above.
        </p>
      )}

      <VehicleList issues={issues} canEdit={canEdit} />
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <section className="mx-auto w-full max-w-[1100px] px-5 py-9">
      <DamageTabs active="vehicles" />
      <div className="mb-6">
        <p className="mb-1 text-xs font-semibold uppercase tracking-[0.18em] text-sudsy-blue">
          Internal Tools
        </p>
        <h1 className="text-2xl font-bold text-splash-navy">Vehicle Guide</h1>
        <p className="mt-1 text-sm text-splash-navy/70">
          Vehicles that give the tunnel trouble, and what to tell the driver.
        </p>
      </div>
      {children}
    </section>
  );
}

function Banner({ kind, message }: { kind: "error" | "success"; message: string }) {
  const cls =
    kind === "error"
      ? "border-splash-deny/40 bg-splash-deny/10 text-splash-deny"
      : "border-splash-success/40 bg-splash-success/10 text-splash-success";
  return (
    <div
      role={kind === "error" ? "alert" : "status"}
      className={`mb-5 flex flex-col gap-2 rounded-splash-md border p-4 text-sm sm:flex-row sm:items-center sm:justify-between ${cls}`}
    >
      <span className="font-bold">{message}</span>
      <Link href={LIST_PATH} className="text-xs font-semibold underline underline-offset-2">
        Dismiss
      </Link>
    </div>
  );
}
