// Brief 158a + 158b — promo live view (/admin/promotions/{id}).
//
// Multi-card stack mirroring the mockup. Brief 158b wires write
// affordances: StatusEditor on the pipeline card, MaterialUploadModal +
// per-chip delete on the materials card, PtpEditModal on the PTP card,
// AnnouncementComposeModal on the announcements card. Any non-null
// `promoRole` reads the page; write affordances are gated to
// `super_admin | it | marketing` per the worker's role gates.

import Link from "next/link";
import { notFound } from "next/navigation";
import { getMe } from "../../../_lib/me";
import {
  getPromo,
  listAnnouncementTemplates,
  listPromos
} from "../_lib/worker-fetch";
import type { RecentPromoForAutofill } from "../_lib/announce-templates";
import { resolveRecipients } from "../_lib/locations";
import NoAccessCard from "../_components/NoAccessCard";
import PromoStatusPill from "../_components/PromoStatusPill";
import PromoPriorityPill from "../_components/PromoPriorityPill";
import PromoStatusPipeline from "../_components/PromoStatusPipeline";
import StatusEditor from "../_components/StatusEditor";
import LocationProgress from "../_components/LocationProgress";
import MaterialChip from "../_components/MaterialChip";
import MaterialUploadModal from "../_components/MaterialUploadModal";
import PtpEditModal from "../_components/PtpEditModal";
import AnnouncementComposeModal from "../_components/AnnouncementComposeModal";
import ActivityTimeline from "../_components/ActivityTimeline";
import AnnouncementHistoryButton from "../_components/AnnouncementHistoryButton";
import {
  displayUserLabel,
  lookupUserNames,
  shortenUserId
} from "../_lib/user-lookup";
import { formatEst } from "../../jotform/_lib/format-est";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function PromoDetailPage({ params }: PageProps) {
  const { id } = await params;

  const session = await getMe().catch(() => null);
  if (!session) {
    return (
      <NoAccessCard
        reason="signin"
        returnPath={`/admin/promotions/${id}`}
      />
    );
  }
  if (session.promoRole === null) {
    return <NoAccessCard reason="no-promo-role" />;
  }

  const promo = await getPromo(id);
  if (!promo) notFound();

  const isItOrSuper =
    session.promoRole === "super_admin" || session.promoRole === "it";
  const canWrite =
    session.promoRole === "super_admin" ||
    session.promoRole === "it" ||
    session.promoRole === "marketing";

  const assigneeIds = promo.ticket?.assignees.map((a) => a.userId) ?? [];
  const userLookup = await lookupUserNames(assigneeIds);

  // Pre-resolve recipients for the announcement modal so the operator
  // sees a fully-populated list the moment they click Compose. Templates
  // (Brief 163) are fetched in parallel — the modal renders a picker
  // at the top with these as options.
  const defaultRecipients = canWrite
    ? await resolveRecipients(promo.locations.map((l) => l.locationCode))
    : [];
  const announcementTemplates = canWrite
    ? await listAnnouncementTemplates()
    : [];
  // Brief 166 item 4 — fetch the 10 most recently created promos to power
  // the compose modal's "Pull details from a promo" autofill picker.
  // Worker already orders by `created_at.desc`. Fail-soft: empty array on
  // error, modal degrades to no-picker.
  const recentPromosResp = canWrite
    ? await listPromos({ limit: 10 }).catch(() => null)
    : null;
  const recentPromos: RecentPromoForAutofill[] = (
    recentPromosResp?.promos ?? []
  ).map((p) => ({
    id: p.id,
    title: p.title,
    promoType: p.promoType,
    proposedStartDate: p.proposedStartDate,
    proposedEndDate: p.proposedEndDate,
    createdAt: p.createdAt
  }));

  const startFmt = formatEst(`${promo.proposedStartDate}T00:00:00Z`).absolute;
  const endFmt = formatEst(`${promo.proposedEndDate}T00:00:00Z`).absolute;
  const goLiveFmt = formatEst(
    `${promo.requestedGoLiveDate}T00:00:00Z`
  ).absolute;
  const readyByFmt = promo.ticket?.readyByDate
    ? formatEst(`${promo.ticket.readyByDate}T00:00:00Z`).absolute
    : null;

  return (
    <section className="mx-auto w-full max-w-[1100px] px-5 py-9">
      <div className="mb-3 text-sm">
        <Link
          href="/admin/promotions"
          className="text-splash-blue hover:underline"
        >
          ← Promotions
        </Link>
      </div>

      {/* 1. Header card */}
      <header className="mb-5 rounded-splash-lg border-[1.5px] border-gray-light bg-white p-5 shadow-splash-card">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex flex-col gap-2">
            <h1 className="text-2xl font-bold text-splash-navy">
              {promo.title}
            </h1>
            <div className="flex flex-wrap items-center gap-2">
              <PromoStatusPill status={promo.status} />
              <PromoPriorityPill priority={promo.priority} />
              <span className="text-xs uppercase tracking-wide text-splash-navy/55">
                {promo.promoType}
                {promo.posBehavior && ` · ${promo.posBehavior}`}
              </span>
            </div>
          </div>
          {isItOrSuper && (
            <Link
              href={`/admin/promotions/${encodeURIComponent(promo.id)}/ticket`}
              className="inline-flex items-center gap-1.5 rounded-splash-sm border border-splash-blue bg-white px-4 py-2 text-sm font-bold text-splash-blue hover:bg-splash-blue/5"
            >
              Open IT ticket →
            </Link>
          )}
        </div>
      </header>

      {/* 2. Status pipeline card */}
      <Card
        title="Status"
        rightSlot={
          canWrite ? (
            <StatusEditor promoId={promo.id} currentStatus={promo.status} />
          ) : null
        }
      >
        <PromoStatusPipeline current={promo.status} />
      </Card>

      {/* 3. Details card */}
      <Card title="Details">
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
          <KV label="Promo type" value={promo.promoType} />
          <KV
            label="POS behavior"
            value={promo.posBehavior ?? "—"}
            mutedWhenEmpty={!promo.posBehavior}
          />
          <KV
            label="Proposed window"
            value={`${startFmt || promo.proposedStartDate} → ${endFmt || promo.proposedEndDate}`}
          />
          <KV
            label="Requested go-live"
            value={goLiveFmt || promo.requestedGoLiveDate}
          />
          <KV
            label="IT ready by"
            value={readyByFmt ?? "(not set)"}
            mutedWhenEmpty={!promo.ticket?.readyByDate}
          />
          <KV
            label="Assignees"
            value={
              promo.ticket && promo.ticket.assignees.length > 0
                ? promo.ticket.assignees
                    .map((a) =>
                      displayUserLabel(a.userId, userLookup[a.userId])
                    )
                    .join(", ")
                : "(none)"
            }
            mutedWhenEmpty={
              !promo.ticket || promo.ticket.assignees.length === 0
            }
          />
          <div className="sm:col-span-2">
            <dt className="text-xs font-semibold uppercase tracking-wide text-splash-navy/55">
              Roadblocks
            </dt>
            <dd className="mt-0.5 whitespace-pre-wrap text-sm text-splash-navy">
              {promo.ticket?.roadblocks ?? (
                <span className="italic text-splash-navy/50">(none)</span>
              )}
            </dd>
          </div>
        </dl>
      </Card>

      {/* 4. Locations card */}
      <Card title={`Locations (${promo.locations.length})`}>
        <LocationProgress locations={promo.locations} />
      </Card>

      {/* 5. Materials card */}
      <Card
        title={`Materials (${promo.materials.length})`}
        rightSlot={canWrite ? <MaterialUploadModal promoId={promo.id} /> : null}
      >
        {promo.materials.length === 0 ? (
          <p className="text-sm italic text-splash-navy/60">
            No materials uploaded yet.
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {promo.materials.map((m) => (
              <MaterialChip
                key={m.id}
                promoId={promo.id}
                material={m}
                canDelete={canWrite}
              />
            ))}
          </div>
        )}
      </Card>

      {/* 6. PTP card */}
      <Card
        title="Purpose · Tools · Process"
        rightSlot={
          canWrite ? <PtpEditModal promoId={promo.id} ptp={promo.ptp} /> : null
        }
      >
        {promo.ptp ? (
          <div className="space-y-4 text-sm">
            <PtpField label="Purpose" value={promo.ptp.purpose} />
            <PtpField label="Tools" value={promo.ptp.tools} />
            <PtpField label="Process" value={promo.ptp.process} />
          </div>
        ) : (
          <p className="text-sm italic text-splash-navy/60">
            PTP not built yet.
          </p>
        )}
      </Card>

      {/* 7. Announcement card */}
      <Card
        title="Announcements"
        rightSlot={
          canWrite ? (
            <AnnouncementComposeModal
              promoId={promo.id}
              promoTitle={promo.title}
              materials={promo.materials}
              ptp={promo.ptp}
              defaultRecipients={defaultRecipients}
              templates={announcementTemplates}
              recentPromos={recentPromos}
            />
          ) : null
        }
      >
        <AnnouncementHistoryButton announcements={promo.announcements} />
      </Card>

      {/* 8. Activity timeline card */}
      <Card title="Recent activity">
        <ActivityTimeline entries={promo.activity} />
      </Card>

      <p className="mt-6 text-xs text-splash-navy/40">
        Promo id:{" "}
        <span className="font-mono">{shortenUserId(promo.id)}</span> ·
        Created {formatEst(promo.createdAt).relative}
      </p>
    </section>
  );
}

function Card({
  title,
  rightSlot,
  children
}: {
  title: string;
  rightSlot?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-5 rounded-splash-lg border-[1.5px] border-gray-light bg-white p-5 shadow-splash-card">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-base font-bold text-splash-navy">{title}</h2>
        {rightSlot}
      </div>
      {children}
    </section>
  );
}

function KV({
  label,
  value,
  mutedWhenEmpty = false
}: {
  label: string;
  value: string;
  mutedWhenEmpty?: boolean;
}) {
  return (
    <div>
      <dt className="text-xs font-semibold uppercase tracking-wide text-splash-navy/55">
        {label}
      </dt>
      <dd
        className={`mt-0.5 text-sm ${mutedWhenEmpty ? "italic text-splash-navy/50" : "text-splash-navy"}`}
      >
        {value}
      </dd>
    </div>
  );
}

function PtpField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-splash-navy/55">
        {label}
      </p>
      <p className="whitespace-pre-wrap text-sm text-splash-navy">
        {value || (
          <span className="italic text-splash-navy/50">(empty)</span>
        )}
      </p>
    </div>
  );
}
