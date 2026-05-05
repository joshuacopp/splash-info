// Damage claim detail page (/admin/damage/[id]).
//
// Server component (with two client islands: the photo lightbox and the
// shared <ActionForm> wrapper around every server-action <form>). Brief
// 5b laid out the read view. Brief 5c added transitions, notes, and the
// check-request PDF preview link in the approval box. Brief 11a retrofit:
// transition buttons are now gated by the caller's dcRole. Brief 5d adds
// document upload, per-Quote/Receipt edit + delete, photo lightbox on
// image-typed tiles, per-Quote-tile check-request preview, and a
// confirm-delete banner driven by ?confirm_delete_id=N. Brief 19 flips
// every server action from redirect()-based feedback to ActionResult +
// router.refresh() via <ActionForm>; the page-level ?action_error banner
// is gone (per-form inline result rendering replaces it).
//
// Sections (top → bottom):
//   1. Confirm-delete banner (when ?confirm_delete_id=... is set, 5d).
//   2. Back link + page banner.
//   3. Summary card (Brief 5b) — approval-details box now includes the
//      check-request preview link when claim.approved_quote_id is set.
//   4. Move-forward section (Brief 5c, retrofit 11a) — one ActionForm per
//      transition that is valid-from-current-status, submits to
//      transitionAction.
//   5. Photo gallery (Brief 5b, extended in 5d) — image tiles open a
//      lightbox; Quote/Receipt tiles get Edit/Delete affordances and a
//      per-Quote check-request preview link.
//   6. Upload-document card (Brief 5d) — between gallery and timeline.
//   7. Activity timeline (Brief 5b).
//   8. Add-note form (Brief 5c) — submits to addNoteAction.
//
// Four fetch branches:
//   - 401/403 -> no-access card with Sign In (return path = this URL)
//   - 404     -> "Claim not found" card with Back link
//   - other 5xx-class / network -> generic error card
//   - success -> the nine sections above.
//
// dc_role gating (Brief 11a, REVERTED in Brief 18):
//   Brief 11a originally filtered transitions by both current status AND
//   caller's dcRole. Brief 18 dropped the dcRole filter while the
//   dcRole-population bug surfaced in 11b is still being chased — when
//   session.dcRole is null the filter eliminates every transition and
//   the operator sees zero buttons (the bug surface reported in Brief 18).
//   The worker re-validates dc_role on every POST, so removing the UI
//   filter is a UX fix only, not an access-control change. Restore the
//   filter once dcRole is reliably populated. A small debug line
//   ("Session dcRole: <value>") renders below the page banner so the
//   operator can see the resolved value without reading worker logs.
//
// canMutateDocument gating (Brief 5d): Edit/Delete buttons render only
// when the UI mirror in _lib/permissions.ts returns true. Worker
// re-validates as defense in depth.

import Link from "next/link";
import {
  damageCheckRequestUrl,
  damageGetJsonOrStatus,
  damagePhotoUrl
} from "../_lib/worker-fetch";
import { DocumentEditDetails } from "../_components/DocumentEditDetails";
import { LifecycleBadge } from "../_components/LifecycleBadge";
import { PhotoLightbox } from "../_components/PhotoLightbox";
import { UploadDocumentCard } from "../_components/UploadDocumentCard";
import { canMutateDocument } from "../_lib/permissions";
import { transitionsFrom, type UITransition } from "../_lib/transitions";
import {
  addNoteAction,
  deleteDocumentAction,
  transitionAction
} from "./actions";
import { ActionForm } from "../../_components/ActionForm";
import { getMe } from "../../../_lib/me";
import type { Session } from "@splash/types/session";
import type {
  ActivityType,
  ClaimActivityRow,
  ClaimDetermination,
  ClaimPhotoRow,
  ClaimPhotoType,
  ClaimRow
} from "@splash/types/claims";

interface DetailResponse {
  claim: ClaimRow;
  photos: ClaimPhotoRow[];
  activity: ClaimActivityRow[];
}

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function firstParam(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

// Photo categories rendered in this fixed order. Categories with zero
// non-deleted photos are skipped at render time; the order list keeps
// the gallery grouping stable.
const PHOTO_CATEGORY_ORDER: ReadonlyArray<ClaimPhotoType> = [
  "Vehicle Overview",
  "VIN",
  "Damage",
  "License Plate",
  "Quote",
  "Receipt",
  "Check Request"
];

const DETERMINATION_LABELS: Record<ClaimDetermination, string> = {
  no_responsibility: "No Responsibility",
  requires_gm_review: "Requires GM Review",
  customer_get_quotes: "Customer Get Quotes"
};

function formatPhone(raw: string | null): string {
  if (!raw) return "—";
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  return raw;
}

function joinNonEmpty(parts: Array<string | number | null>): string {
  const out = parts
    .map((p) => (p === null || p === undefined || p === "" ? null : String(p)))
    .filter((p): p is string => p !== null);
  return out.length === 0 ? "" : out.join(", ");
}

function formatVehicleFull(claim: ClaimRow): string {
  const joined = joinNonEmpty([
    claim.vehicle_year,
    claim.vehicle_make,
    claim.vehicle_model,
    claim.vehicle_color
  ]);
  return joined || "—";
}

/** Slice the date+time portion of an ISO timestamp without timezone math. */
function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  // ISO from D1 is "YYYY-MM-DD HH:mm:ss" or "YYYY-MM-DDTHH:mm:ss(.sss)Z".
  // Both start with YYYY-MM-DD; HH:mm slice avoids parsing into Date.
  if (iso.length < 16) return iso;
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

function formatAmount(amount: number | null | undefined): string {
  if (amount === null || amount === undefined) return "—";
  return `$${amount.toFixed(2)}`;
}

function determinationLabel(d: ClaimDetermination | null): string {
  if (!d) return "—";
  return DETERMINATION_LABELS[d] ?? d;
}

function valueOrDash(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  const s = String(v);
  return s === "" ? "—" : s;
}

export default async function DamageClaimDetailPage({ params, searchParams }: PageProps) {
  const { id: rawId } = await params;
  const id = decodeURIComponent(rawId);
  const sp = await searchParams;
  // Brief 19: ?action_error reading is removed — <ActionForm> renders the
  // result inline under each server-action form now.
  const confirmDeleteIdRaw = firstParam(sp.confirm_delete_id).trim();
  const confirmDeleteId =
    confirmDeleteIdRaw && /^\d+$/.test(confirmDeleteIdRaw)
      ? Number.parseInt(confirmDeleteIdRaw, 10)
      : null;
  const returnPath = `/admin/damage/${encodeURIComponent(id)}`;

  // Fetch claim + session in parallel. getMe() is React-cached so the root
  // layout's call (for the Header) and this one share a single fetch.
  const [result, session] = await Promise.all([
    damageGetJsonOrStatus<DetailResponse>(
      `/manage/api/claim/${encodeURIComponent(id)}`
    ),
    getMe().catch(() => null)
  ]);

  if ("status" in result) {
    if (result.status === 401 || result.status === 403) {
      return (
        <section className="mx-auto w-full max-w-[1100px] px-5 py-9">
          <BackLink />
          <PageBanner customerName={null} claimId={id} />
          <div className="rounded-splash-lg border border-gray-light bg-white p-6 shadow-splash-card">
            <p className="mb-4 text-splash-deny">
              You don&rsquo;t have access to this claim. Contact your
              administrator if this is unexpected.
            </p>
            <Link
              href={`/login?return=${encodeURIComponent(returnPath)}`}
              className="inline-flex items-center gap-1.5 rounded-splash-sm bg-splash-blue px-5 py-2.5 text-sm font-bold text-white shadow-splash-btn transition-colors hover:bg-splash-blue-dark"
            >
              Sign In
            </Link>
          </div>
        </section>
      );
    }

    if (result.status === 404) {
      return (
        <section className="mx-auto w-full max-w-[1100px] px-5 py-9">
          <BackLink />
          <PageBanner customerName={null} claimId={id} />
          <div className="rounded-splash-lg border border-gray-light bg-white p-6 shadow-splash-card">
            <h2 className="mb-2 text-lg font-bold text-splash-navy">
              Claim not found
            </h2>
            <p className="mb-4 text-sm text-splash-navy/80">
              This claim does not exist, or it&rsquo;s outside your access
              scope. Verify the URL with whoever sent it to you, or use the
              link below.
            </p>
            <Link
              href="/admin/damage"
              className="inline-flex items-center gap-1.5 rounded-splash-sm bg-splash-blue px-5 py-2.5 text-sm font-bold text-white shadow-splash-btn transition-colors hover:bg-splash-blue-dark"
            >
              Back to claims list
            </Link>
          </div>
        </section>
      );
    }

    return (
      <section className="mx-auto w-full max-w-[1100px] px-5 py-9">
        <BackLink />
        <PageBanner customerName={null} claimId={id} />
        <div className="rounded-splash-lg border border-gray-light bg-white p-6 shadow-splash-card">
          <h2 className="mb-2 text-lg font-bold text-splash-deny">
            Could not load claim
          </h2>
          <p className="text-sm text-splash-navy/80">
            The damage worker returned status {result.status}.
          </p>
          <p className="mt-2 text-sm text-splash-navy/60">
            Reload the page to retry.
          </p>
        </div>
      </section>
    );
  }

  const { claim, photos, activity } = result.data;

  // Defensive: filter soft-deleted photos. Worker may or may not include them.
  const livePhotos = photos.filter((p) => !p.deleted_at);
  const activeQuotes = livePhotos.filter((p) => p.photo_type === "Quote");

  // Pre-resolve check-request URL for the approval-details box (server
  // component can await; the URL is conditional on approved_quote_id).
  const checkRequestHref =
    claim.approved_quote_id !== null && claim.approved_quote_id !== undefined
      ? await damageCheckRequestUrl(claim.claim_id, claim.approved_quote_id)
      : null;

  // Filter by current status only. Brief 11a additionally gated on dcRole,
  // but Brief 18 dropped that filter while the dcRole-population bug is
  // under investigation — when dcRole is null the 11a filter eliminates
  // every transition and the operator sees zero buttons (the bug surface
  // reported in Brief 18). Worker still re-validates dc_role on POST as
  // defense-in-depth, so this is a UX fix only, not an access-control
  // change. Re-introduce the filter once dcRole is reliably populated.
  const dcRole = session?.dcRole ?? null;
  const validTransitions = transitionsFrom(claim.claim_status);

  // Resolve the photo to delete (if a confirm_delete_id is present and
  // points at a live Quote/Receipt the user can mutate). Anything else
  // collapses to null and the banner is skipped — defensive against stale
  // URLs after a delete or scope change.
  const pendingDelete: ClaimPhotoRow | null =
    confirmDeleteId !== null
      ? livePhotos.find(
          (p) =>
            p.id === confirmDeleteId &&
            (p.photo_type === "Quote" || p.photo_type === "Receipt") &&
            canMutateDocument(session, p)
        ) ?? null
      : null;

  return (
    <section className="mx-auto w-full max-w-[1100px] px-5 py-9">
      {pendingDelete ? (
        <ConfirmDeleteBanner claimId={claim.claim_id} photo={pendingDelete} />
      ) : null}
      <BackLink />
      <PageBanner customerName={claim.customer_name} claimId={claim.claim_id} />
      <DcRoleDebugLine dcRole={dcRole} />

      <SummaryCard claim={claim} checkRequestHref={checkRequestHref} />
      <TransitionSection
        claimId={claim.claim_id}
        transitions={validTransitions}
        quotes={activeQuotes}
      />
      <PhotoGalleryCard
        claimId={claim.claim_id}
        photos={livePhotos}
        session={session}
      />
      <UploadDocumentCard claimId={claim.claim_id} />
      <ActivityTimelineCard activity={activity} />
      <AddNoteCard claimId={claim.claim_id} />
    </section>
  );
}

/* ============================================================
 * Header pieces
 * ============================================================ */

function BackLink() {
  return (
    <div className="mb-3">
      <Link
        href="/admin/damage"
        className="text-sm font-semibold text-splash-blue hover:text-splash-blue-dark"
      >
        &larr; Back to claims list
      </Link>
    </div>
  );
}

function PageBanner({
  customerName,
  claimId
}: {
  customerName: string | null;
  claimId: string;
}) {
  return (
    <div className="mb-6">
      <p className="mb-1 text-xs font-semibold uppercase tracking-[0.18em] text-sudsy-blue">
        Internal Tools
      </p>
      <h1 className="text-2xl font-bold text-splash-navy">
        {customerName ?? "Damage claim"}
      </h1>
      <p className="mt-1 font-mono text-xs text-splash-navy/60">{claimId}</p>
    </div>
  );
}

/**
 * Brief 18 diagnostic — surfaces the resolved dcRole on the detail page so
 * the operator can confirm whether session.dcRole is populating from
 * auth_unified. When this field is reliably non-null in production the
 * Brief 11a filter can be re-introduced and this line removed (a small
 * follow-up brief).
 */
function DcRoleDebugLine({ dcRole }: { dcRole: string | null }) {
  return (
    <div className="mb-4 rounded-splash-sm border border-sudsy-blue/30 bg-sudsy-blue-soft/40 px-3 py-1.5 font-mono text-[11px] text-splash-navy/70">
      Session dcRole: {dcRole === null ? "null" : dcRole}
    </div>
  );
}

/* ============================================================
 * Summary card
 * ============================================================ */

function SummaryCard({
  claim,
  checkRequestHref
}: {
  claim: ClaimRow;
  checkRequestHref: string | null;
}) {
  return (
    <div className="mb-6 rounded-splash-lg border border-gray-light bg-white p-6 shadow-splash-card">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold text-splash-navy">
            {claim.customer_name}
          </h2>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center rounded-full bg-sudsy-blue-soft px-2.5 py-0.5 text-xs font-semibold text-splash-navy">
              {claim.claim_status}
            </span>
            {claim.contact_status ? (
              <span className="text-xs text-splash-navy/60">
                {claim.contact_status}
              </span>
            ) : null}
          </div>
        </div>
        <LifecycleBadge state={claim.lifecycle_state} />
      </div>

      <dl className="grid grid-cols-1 gap-x-8 gap-y-4 md:grid-cols-2">
        {/* Left column */}
        <Field label="Customer">
          <div className="space-y-0.5 text-splash-navy">
            <div>{valueOrDash(claim.customer_name)}</div>
            <div className="text-sm text-splash-navy/80">
              {formatPhone(claim.customer_phone)}
            </div>
            <div className="text-sm text-splash-navy/80">
              {valueOrDash(claim.customer_email)}
            </div>
            <div className="whitespace-pre-line text-sm text-splash-navy/80">
              {valueOrDash(claim.customer_mailing_address)}
            </div>
          </div>
        </Field>

        <Field label="Damage">
          <div className="whitespace-pre-line text-sm text-splash-navy">
            {valueOrDash(claim.damage_description)}
          </div>
        </Field>

        <Field label="Vehicle">
          <div className="space-y-0.5 text-splash-navy">
            <div>{formatVehicleFull(claim)}</div>
            <div className="text-sm text-splash-navy/80">
              Plate: {valueOrDash(claim.license_plate)}
            </div>
          </div>
        </Field>

        <Field label="Preexisting damage">
          <div className="whitespace-pre-line text-sm text-splash-navy">
            {valueOrDash(claim.preexisting_damage)}
          </div>
        </Field>

        <Field label="Location">
          <div className="space-y-0.5 text-splash-navy">
            <div>{claim.location_pretty}</div>
            <div className="font-mono text-xs text-splash-navy/60">
              {claim.location_code}
            </div>
          </div>
        </Field>

        <Field label="Staff notes">
          <div className="whitespace-pre-line text-sm text-splash-navy">
            {valueOrDash(claim.staff_notes)}
          </div>
        </Field>

        <Field label="Submitted">
          <div className="font-mono text-sm text-splash-navy/80">
            {formatDateTime(claim.submitted_at)}
          </div>
        </Field>

        <Field label="Determination">
          <div className="text-splash-navy">
            <span>{determinationLabel(claim.determination)}</span>
            {claim.determination ? (
              <span className="ml-2 font-mono text-xs text-splash-navy/60">
                ({claim.determination})
              </span>
            ) : null}
          </div>
        </Field>

        <Field label="Submitted by">
          <div className="text-sm text-splash-navy">
            {valueOrDash(claim.submitted_by)}
          </div>
        </Field>

        <Field label="Equipment involved">
          <div className="text-sm text-splash-navy">
            {claim.equipment_related ? "Yes" : "No"}
            {claim.equipment_related && claim.equipment_piece ? (
              <span className="ml-2 text-splash-navy/80">
                — {claim.equipment_piece}
              </span>
            ) : null}
          </div>
        </Field>
      </dl>

      <AuditStamps claim={claim} />
      <ApprovalDetails claim={claim} checkRequestHref={checkRequestHref} />
    </div>
  );
}

function Field({
  label,
  children
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <dt className="mb-1 text-xs font-semibold uppercase tracking-wider text-splash-navy/60">
        {label}
      </dt>
      <dd>{children}</dd>
    </div>
  );
}

function AuditStamps({ claim }: { claim: ClaimRow }) {
  const stamps: Array<{ label: string; by: string | null; at: string | null }> = [
    { label: "GM", by: claim.gm_approved_by, at: claim.gm_approved_at },
    { label: "RM", by: claim.rm_approved_by, at: claim.rm_approved_at },
    { label: "CEO", by: claim.ceo_approved_by, at: claim.ceo_approved_at }
  ];
  const populated = stamps.filter((s) => s.by || s.at);
  if (populated.length === 0) return null;

  return (
    <div className="mt-5 border-t border-gray-light pt-4">
      <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-splash-navy/60">
        Audit stamps
      </p>
      <ul className="space-y-1 text-sm text-splash-navy/80">
        {populated.map((s) => (
          <li key={s.label}>
            <span className="font-semibold text-splash-navy">{s.label}:</span>{" "}
            {s.by ? s.by : "(unknown)"}{" "}
            {s.at ? (
              <span className="text-splash-navy/60">on {formatDateTime(s.at)}</span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ApprovalDetails({
  claim,
  checkRequestHref
}: {
  claim: ClaimRow;
  checkRequestHref: string | null;
}) {
  const fields: Array<{ label: string; value: string | null }> = [
    {
      label: "Approved amount",
      value:
        claim.approved_amount !== null && claim.approved_amount !== undefined
          ? formatAmount(claim.approved_amount)
          : null
    },
    {
      label: "Approved quote ID",
      value:
        claim.approved_quote_id !== null && claim.approved_quote_id !== undefined
          ? String(claim.approved_quote_id)
          : null
    },
    { label: "Vendor", value: claim.vendor_name },
    { label: "Parts ordered", value: claim.parts_ordered }
  ];
  const populated = fields.filter((f) => f.value !== null && f.value !== "");
  // Brief 20 — defensive null gate: hide the entire box when none of the
  // four approval columns are populated. The worker now NULLs these on
  // revert/reopen transitions (clearApprovalDetails), so this is mostly a
  // safety net for legacy claims that were reverted before the worker fix
  // landed. checkRequestHref is derived from approved_quote_id, so an
  // empty `populated` implies a null checkRequestHref — kept as belt-and-
  // suspenders for clarity.
  if (populated.length === 0 && !checkRequestHref) return null;

  return (
    <div className="mt-4 rounded-splash-md border border-gray-light bg-sudsy-blue-soft/30 p-4">
      <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-splash-navy/70">
        Approval details
      </p>
      {populated.length > 0 ? (
        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
          {populated.map((f) => (
            <div key={f.label} className="flex flex-col">
              <dt className="text-xs text-splash-navy/60">{f.label}</dt>
              <dd className="whitespace-pre-line text-sm text-splash-navy">
                {f.value}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      {checkRequestHref ? (
        <div className={populated.length > 0 ? "mt-3" : undefined}>
          <a
            href={checkRequestHref}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-splash-sm bg-splash-blue px-4 py-2 text-xs font-bold text-white shadow-splash-btn transition-colors hover:bg-splash-blue-dark"
          >
            Preview check request &rarr;
          </a>
        </div>
      ) : null}
    </div>
  );
}

/* ============================================================
 * Transition section (Brief 5c) — buttons gated by current status
 * ============================================================ */

function TransitionSection({
  claimId,
  transitions,
  quotes
}: {
  claimId: string;
  transitions: UITransition[];
  quotes: ClaimPhotoRow[];
}) {
  return (
    <div className="mb-6 rounded-splash-lg border border-gray-light bg-white p-6 shadow-splash-card">
      <h2 className="mb-4 text-lg font-bold text-splash-navy">Move forward</h2>
      {transitions.length === 0 ? (
        <p className="text-sm text-splash-navy/60 opacity-60">
          No further transitions available from current status.
        </p>
      ) : (
        <div className="space-y-3">
          {transitions.map((t) => (
            <TransitionForm
              key={`${t.from}->${t.to}-${t.label}`}
              claimId={claimId}
              transition={t}
              quotes={quotes}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function TransitionForm({
  claimId,
  transition,
  quotes
}: {
  claimId: string;
  transition: UITransition;
  quotes: ClaimPhotoRow[];
}) {
  const { label, to, requiresAmount, requiresQuoteSelection, requiresNote } =
    transition;
  const noQuotesAvailable = requiresQuoteSelection && quotes.length === 0;

  const inputCls =
    "w-full rounded-splash-sm border border-gray-light bg-white px-3 py-2 text-sm text-splash-navy placeholder:text-splash-navy/40 focus:border-splash-blue focus:outline-none";
  const labelCls =
    "text-xs font-semibold uppercase tracking-wider text-splash-navy/70";

  // Brief 20 — Bug 4 fix: when a transition needs a Quote selection but
  // the claim has no Quote-typed photos yet, render a hint card with an
  // anchor to the upload section instead of a disabled <select> + button.
  // Eliminates the "no quotes on file → button is greyed out, no guidance"
  // dead end.
  if (noQuotesAvailable) {
    return (
      <div className="flex flex-col gap-2 rounded-splash-md border border-sudsy-blue/40 bg-sudsy-blue-soft/40 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-1 flex-col gap-1">
          <span className={labelCls}>Action</span>
          <span className="text-sm font-semibold text-splash-navy">{label}</span>
          <span className="font-mono text-[11px] text-splash-navy/60">{to}</span>
        </div>
        <p className="text-sm text-splash-navy/80 sm:max-w-[420px]">
          No quotes uploaded yet.{" "}
          <a
            href="#upload-document"
            className="font-semibold text-splash-blue hover:text-splash-blue-dark"
          >
            Upload a quote first
          </a>{" "}
          to enable this action.
        </p>
      </div>
    );
  }

  return (
    <ActionForm
      action={transitionAction}
      className="flex flex-col gap-3 rounded-splash-md border border-gray-light bg-sudsy-blue-soft/20 p-4 sm:flex-row sm:flex-wrap sm:items-end"
    >
      <input type="hidden" name="claim_id" value={claimId} />
      <input type="hidden" name="to_status" value={to} />

      <div className="flex flex-1 flex-col gap-1 sm:min-w-[220px]">
        <span className={labelCls}>Action</span>
        <span className="text-sm font-semibold text-splash-navy">{label}</span>
        <span className="font-mono text-[11px] text-splash-navy/60">{to}</span>
      </div>

      {requiresAmount ? (
        <label className="flex flex-col gap-1 sm:w-[160px]">
          <span className={labelCls}>Approved amount ($)</span>
          <input
            type="number"
            name="approved_amount"
            step="0.01"
            min="0"
            required
            placeholder="0.00"
            className={inputCls}
          />
        </label>
      ) : null}

      {requiresQuoteSelection ? (
        <label className="flex flex-col gap-1 sm:w-[260px]">
          <span className={labelCls}>Quote to approve</span>
          <select
            name="quote_id"
            required
            className={inputCls}
            defaultValue=""
          >
            <option value="" disabled>
              Select a quote…
            </option>
            {quotes.map((q) => {
              const labelParts: string[] = [`#${q.id}`];
              if (q.vendor) labelParts.push(q.vendor);
              if (q.amount !== null && q.amount !== undefined) {
                labelParts.push(formatAmount(q.amount));
              }
              return (
                <option key={q.id} value={q.id}>
                  {labelParts.join(" — ")}
                </option>
              );
            })}
          </select>
        </label>
      ) : null}

      {transition.requiresInputs.map((field) => (
        <label key={field} className="flex flex-col gap-1 sm:w-[200px]">
          <span className={labelCls}>{field}</span>
          <input
            type="text"
            name={field}
            required
            maxLength={1000}
            className={inputCls}
          />
        </label>
      ))}

      {transition.optionalInputs.map((field) => (
        <label key={field} className="flex flex-col gap-1 sm:w-[200px]">
          <span className={labelCls}>{field} (optional)</span>
          <input
            type="text"
            name={field}
            maxLength={1000}
            className={inputCls}
          />
        </label>
      ))}

      {requiresNote ? (
        <label className="flex flex-1 flex-col gap-1 sm:min-w-[260px]">
          <span className={labelCls}>Note (required)</span>
          <textarea
            name="note"
            required
            maxLength={5000}
            rows={2}
            className={inputCls}
          />
        </label>
      ) : null}

      <div className="flex sm:items-end">
        <button
          type="submit"
          className="inline-flex items-center gap-1.5 rounded-splash-sm bg-splash-blue px-5 py-2.5 text-sm font-bold text-white shadow-splash-btn transition-colors hover:bg-splash-blue-dark"
        >
          {label}
        </button>
      </div>
    </ActionForm>
  );
}

/* ============================================================
 * Add-note card (Brief 5c)
 * ============================================================ */

function AddNoteCard({ claimId }: { claimId: string }) {
  return (
    <div className="mb-6 rounded-splash-lg border border-gray-light bg-white p-6 shadow-splash-card">
      <h2 className="mb-4 text-lg font-bold text-splash-navy">Add a note</h2>
      <ActionForm action={addNoteAction} className="flex flex-col gap-3">
        <input type="hidden" name="claim_id" value={claimId} />
        <textarea
          name="note"
          required
          maxLength={5000}
          rows={3}
          placeholder="Note text…"
          className="w-full rounded-splash-sm border border-gray-light bg-white px-3 py-2 text-sm text-splash-navy placeholder:text-splash-navy/40 focus:border-splash-blue focus:outline-none"
        />
        <div>
          <button
            type="submit"
            className="inline-flex items-center gap-1.5 rounded-splash-sm bg-splash-blue px-5 py-2.5 text-sm font-bold text-white shadow-splash-btn transition-colors hover:bg-splash-blue-dark"
          >
            Add note
          </button>
        </div>
      </ActionForm>
    </div>
  );
}

/* ============================================================
 * Photo gallery (5b base, 5d adds lightbox + per-tile mutate affordances)
 * ============================================================ */

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "gif", "webp", "heic", "heif"]);

/** Photo is image-renderable in <img>: explicit content_type wins; falls
 *  back to extension on the filename when content_type is missing. PDFs
 *  return false even when extension is unclear. */
function isImagePhoto(p: ClaimPhotoRow): boolean {
  if (p.content_type) return p.content_type.startsWith("image/");
  const m = (p.filename ?? "").toLowerCase().match(/\.([a-z0-9]+)$/);
  const ext = m?.[1];
  if (!ext) return false;
  return IMAGE_EXTENSIONS.has(ext);
}

async function PhotoGalleryCard({
  claimId,
  photos,
  session
}: {
  claimId: string;
  photos: ClaimPhotoRow[];
  session: Session | null;
}) {
  if (photos.length === 0) {
    return (
      <div className="mb-6 rounded-splash-lg border border-gray-light bg-white p-6 shadow-splash-card">
        <h2 className="mb-2 text-lg font-bold text-splash-navy">Photos</h2>
        <p className="text-sm text-splash-navy/70">
          No photos or documents on this claim yet.
        </p>
      </div>
    );
  }

  // Group by photo_type, preserving the canonical category order.
  const groups = new Map<ClaimPhotoType, ClaimPhotoRow[]>();
  for (const p of photos) {
    const arr = groups.get(p.photo_type) ?? [];
    arr.push(p);
    groups.set(p.photo_type, arr);
  }

  // Pre-resolve URLs (server component, awaitable). The photo URL goes
  // both to the lightbox (for image tiles) and to <a target=_blank>
  // (for PDF tiles + the per-Quote check-request preview link).
  const photoUrlEntries = await Promise.all(
    photos.map(async (p) => [p.id, await damagePhotoUrl(p.r2_key)] as const)
  );
  const photoUrls = new Map<number, string>(photoUrlEntries);

  // Pre-resolve check-request preview URLs for every Quote tile (5d).
  // The worker accepts any quote_id; staff may want to preview unapproved
  // quotes too.
  const quoteCheckRequestEntries = await Promise.all(
    photos
      .filter((p) => p.photo_type === "Quote")
      .map(async (p) => [p.id, await damageCheckRequestUrl(claimId, p.id)] as const)
  );
  const quoteCheckRequestUrls = new Map<number, string>(quoteCheckRequestEntries);

  return (
    <div className="mb-6 rounded-splash-lg border border-gray-light bg-white p-6 shadow-splash-card">
      <h2 className="mb-4 text-lg font-bold text-splash-navy">Photos</h2>
      <div className="space-y-6">
        {PHOTO_CATEGORY_ORDER.filter((type) => (groups.get(type)?.length ?? 0) > 0).map(
          (type) => {
            const group = groups.get(type) ?? [];
            return (
              <div key={type}>
                <h3 className="mb-2 text-sm font-semibold uppercase tracking-wider text-splash-navy/70">
                  {type}
                </h3>
                <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(160px,1fr))]">
                  {group.map((photo) => (
                    <PhotoTile
                      key={photo.id}
                      claimId={claimId}
                      photo={photo}
                      url={photoUrls.get(photo.id) ?? "#"}
                      checkRequestUrl={
                        photo.photo_type === "Quote"
                          ? quoteCheckRequestUrls.get(photo.id) ?? null
                          : null
                      }
                      session={session}
                    />
                  ))}
                </div>
              </div>
            );
          }
        )}
      </div>
    </div>
  );
}

function PhotoTile({
  claimId,
  photo,
  url,
  checkRequestUrl,
  session
}: {
  claimId: string;
  photo: ClaimPhotoRow;
  url: string;
  checkRequestUrl: string | null;
  session: Session | null;
}) {
  const isImage = isImagePhoto(photo);
  const isQuoteOrReceipt =
    photo.photo_type === "Quote" || photo.photo_type === "Receipt";
  const canMutate = isQuoteOrReceipt && canMutateDocument(session, photo);

  // Thumbnail visual — shared between the lightbox button (image-typed)
  // and the <a target=_blank> wrapper (non-image-typed).
  const thumb = (
    <>
      <div className="flex h-32 w-full items-center justify-center overflow-hidden bg-splash-navy/5">
        {isImage ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={url}
            alt={photo.filename || photo.photo_type}
            className="h-full w-full object-cover"
          />
        ) : (
          <span className="px-2 text-center text-xs font-semibold text-splash-navy/70">
            {(photo.content_type ?? "file").toUpperCase()}
          </span>
        )}
      </div>
      <div className="flex flex-col gap-0.5 px-2 py-1.5">
        <span
          className="truncate text-xs text-splash-navy/80"
          title={photo.filename}
        >
          {photo.filename || "—"}
        </span>
        {isQuoteOrReceipt ? (
          <span className="text-xs text-splash-navy/60">
            {photo.vendor || "(no vendor)"}
            {photo.amount !== null && photo.amount !== undefined
              ? ` · ${formatAmount(photo.amount)}`
              : ""}
          </span>
        ) : null}
      </div>
    </>
  );

  return (
    <div className="flex flex-col gap-1.5">
      {isImage ? (
        <PhotoLightbox
          url={url}
          alt={photo.filename || photo.photo_type}
          filename={photo.filename}
        >
          {thumb}
        </PhotoLightbox>
      ) : (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="group flex flex-col overflow-hidden rounded-splash-md border border-gray-light bg-white transition-shadow hover:shadow-splash-btn"
        >
          {thumb}
        </a>
      )}

      {photo.photo_type === "Quote" && checkRequestUrl ? (
        <a
          href={checkRequestUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs font-semibold text-splash-blue hover:text-splash-blue-dark"
        >
          Preview check request &rarr;
        </a>
      ) : null}

      {canMutate ? (
        <DocumentMutateRow claimId={claimId} photo={photo} />
      ) : null}
    </div>
  );
}

/* ============================================================
 * Per-tile Edit + Delete affordances (Brief 5d)
 * ============================================================ */

function DocumentMutateRow({
  claimId,
  photo
}: {
  claimId: string;
  photo: ClaimPhotoRow;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap gap-2">
        {/* Brief 20 — DocumentEditDetails is now a client island that owns
         *  the <details> open state so it can close on a successful save
         *  (Bug 8) and that drives Quote-row conditional `required` attrs
         *  on amount / pay_to_type / vendor / vendor_address (Bugs 5+6). */}
        <DocumentEditDetails claimId={claimId} photo={photo} />
        <Link
          href={`/admin/damage/${encodeURIComponent(
            claimId
          )}?confirm_delete_id=${photo.id}#docs`}
          className="rounded-splash-sm border border-splash-deny/40 bg-splash-deny/5 px-2 py-1 text-xs font-semibold text-splash-deny hover:bg-splash-deny/10"
        >
          Delete
        </Link>
      </div>
    </div>
  );
}

/* ============================================================
 * Confirm-delete banner (Brief 5d, simpler v1 — no anti-replay token)
 * ============================================================ */

function ConfirmDeleteBanner({
  claimId,
  photo
}: {
  claimId: string;
  photo: ClaimPhotoRow;
}) {
  return (
    <div
      role="alert"
      className="mb-5 flex flex-col gap-3 rounded-splash-md border border-splash-deny/40 bg-splash-deny/10 p-4 text-sm text-splash-navy sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex-1">
        <div className="font-bold text-splash-deny">Delete this document?</div>
        <div className="mt-1 text-splash-navy/80">
          {photo.photo_type}
          {photo.vendor ? ` from ${photo.vendor}` : ""}
          {photo.filename ? ` (${photo.filename})` : ""}. This soft-deletes
          the row; the file stays in storage.
        </div>
      </div>
      <div className="flex items-center gap-2">
        <ActionForm action={deleteDocumentAction}>
          <input type="hidden" name="claim_id" value={claimId} />
          <input type="hidden" name="doc_id" value={String(photo.id)} />
          <button
            type="submit"
            className="rounded-splash-sm bg-splash-deny px-4 py-2 text-xs font-bold text-white shadow-splash-btn transition-colors hover:bg-splash-deny/90"
          >
            Yes, delete
          </button>
        </ActionForm>
        <Link
          href={`/admin/damage/${encodeURIComponent(claimId)}`}
          className="rounded-splash-sm border border-gray-light bg-white px-4 py-2 text-xs font-semibold text-splash-navy hover:bg-sudsy-blue-soft"
        >
          Cancel
        </Link>
      </div>
    </div>
  );
}

/* ============================================================
 * Upload-document card moved to ../_components/UploadDocumentCard (Brief
 * 20 — converted to a client island so doc_type / pay_to_type can drive
 * conditional `required` attrs). The card root carries id="upload-document"
 * which is the anchor target for the no-quotes hint card on the
 * transition section above.
 * ============================================================ */

/* ============================================================
 * Activity timeline
 * ============================================================ */

function ActivityTimelineCard({ activity }: { activity: ClaimActivityRow[] }) {
  const sorted = [...activity].sort((a, b) => {
    if (a.created_at === b.created_at) return b.id - a.id;
    return a.created_at < b.created_at ? 1 : -1;
  });

  return (
    <div className="mb-6 rounded-splash-lg border border-gray-light bg-white p-6 shadow-splash-card">
      <h2 className="mb-4 text-lg font-bold text-splash-navy">Activity</h2>
      {sorted.length === 0 ? (
        <p className="text-sm text-splash-navy/70">
          No activity yet on this claim.
        </p>
      ) : (
        <ul className="space-y-4">
          {sorted.map((entry) => (
            <li
              key={entry.id}
              className="flex flex-col gap-1 border-b border-gray-light pb-3 last:border-b-0 last:pb-0 sm:flex-row sm:gap-4"
            >
              <div className="font-mono text-xs text-splash-navy/60 sm:w-32 sm:shrink-0 sm:pt-0.5">
                {formatDateTime(entry.created_at)}
              </div>
              <div className="flex-1">
                <div className="mb-0.5 font-semibold text-splash-navy">
                  {entry.actor_name}
                </div>
                <ActivityBody entry={entry} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ActivityBody({ entry }: { entry: ClaimActivityRow }) {
  const type: ActivityType = entry.activity_type;

  if (type === "status_change") {
    return (
      <div className="text-sm text-splash-navy/80">
        changed status from{" "}
        <span className="font-semibold text-splash-navy">
          {entry.status_from ?? "(none)"}
        </span>{" "}
        to{" "}
        <span className="font-semibold text-splash-navy">
          {entry.status_to ?? "(none)"}
        </span>
        {entry.notes ? (
          <div className="mt-1 whitespace-pre-line text-splash-navy/80">
            {entry.notes}
          </div>
        ) : null}
      </div>
    );
  }

  if (type === "note") {
    return (
      <div className="text-sm text-splash-navy/80">
        added a note:
        <div className="mt-1 whitespace-pre-line text-splash-navy">
          {entry.notes ?? ""}
        </div>
      </div>
    );
  }

  // document_added — legacy overloads this for uploads, edits, AND deletes;
  // distinguished by the prose in `notes`. Render verbatim.
  return (
    <div className="whitespace-pre-line text-sm text-splash-navy/80">
      {entry.notes ?? "(document activity)"}
    </div>
  );
}
