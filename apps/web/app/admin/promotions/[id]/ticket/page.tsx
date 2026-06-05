// Brief 158a + 158b — IT ticket detail (/admin/promotions/{id}/ticket).
//
// IT-only — `super_admin | it` gate at the page level. Same `getPromo()`
// call as the live view; the worker has already stripped `internalNote`
// for non-IT callers, so reading `ticket.internalNote` is safe here.
//
// Brief 158b adds three write surfaces — TicketFieldsForm (ready-by /
// roadblocks / internal note PATCH), AssigneesEditor (add/remove),
// LocationProgressToggleable (per-location complete checkbox with
// optimistic UI). Status edit also surfaces here via the shared
// StatusEditor header control.

import Link from "next/link";
import { notFound } from "next/navigation";
import { getMe } from "../../../../_lib/me";
import { getPromo } from "../../_lib/worker-fetch";
import NoAccessCard from "../../_components/NoAccessCard";
import PromoStatusPill from "../../_components/PromoStatusPill";
import PromoPriorityPill from "../../_components/PromoPriorityPill";
import StatusEditor from "../../_components/StatusEditor";
import TicketFieldsForm from "../../_components/TicketFieldsForm";
import AssigneesEditor from "../../_components/AssigneesEditor";
import LocationProgressToggleable from "../../_components/LocationProgressToggleable";
import { lookupUserNames } from "../../_lib/user-lookup";
import { formatEst } from "../../../jotform/_lib/format-est";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function PromoTicketPage({ params }: PageProps) {
  const { id } = await params;

  const session = await getMe().catch(() => null);
  if (!session) {
    return (
      <NoAccessCard
        reason="signin"
        returnPath={`/admin/promotions/${id}/ticket`}
      />
    );
  }
  if (session.promoRole !== "super_admin" && session.promoRole !== "it") {
    return <NoAccessCard reason="it-only" />;
  }

  const promo = await getPromo(id);
  if (!promo) notFound();

  const assigneeIds = promo.ticket?.assignees.map((a) => a.userId) ?? [];
  const userLookup = await lookupUserNames(assigneeIds);

  const startFmt = formatEst(`${promo.proposedStartDate}T00:00:00Z`).absolute;
  const endFmt = formatEst(`${promo.proposedEndDate}T00:00:00Z`).absolute;
  const goLiveFmt = formatEst(
    `${promo.requestedGoLiveDate}T00:00:00Z`
  ).absolute;

  return (
    <section className="mx-auto w-full max-w-[1000px] px-5 py-9">
      <div className="mb-3 flex flex-wrap items-center gap-3 text-sm">
        <Link
          href="/admin/promotions/queue"
          className="text-splash-blue hover:underline"
        >
          ← IT Queue
        </Link>
        <span className="text-splash-navy/40">|</span>
        <Link
          href={`/admin/promotions/${encodeURIComponent(promo.id)}`}
          className="text-splash-blue hover:underline"
        >
          Live view
        </Link>
      </div>

      {/* Header */}
      <header className="mb-5 rounded-splash-lg border-[1.5px] border-gray-light bg-white p-5 shadow-splash-card">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex flex-col gap-2">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-sudsy-blue">
              IT Ticket
            </p>
            <h1 className="text-2xl font-bold text-splash-navy">
              {promo.title}
            </h1>
            <div className="flex flex-wrap items-center gap-2">
              <PromoStatusPill status={promo.status} />
              <PromoPriorityPill priority={promo.priority} />
            </div>
          </div>
          <div>
            <StatusEditor promoId={promo.id} currentStatus={promo.status} />
          </div>
        </div>
      </header>

      {/* Submitted request card */}
      <Card title="Submitted request (read-only)">
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
          <KV label="Promo type" value={promo.promoType} />
          <KV
            label="POS behavior"
            value={promo.posBehavior ?? "(not specified)"}
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
          <KV label="Priority" value={promo.priority} />
          <KV
            label="Locations"
            value={`${promo.locations.length} attached`}
          />
        </dl>
      </Card>

      {/* IT response — editable */}
      <Card title="IT response">
        <TicketFieldsForm
          promoId={promo.id}
          readyByDate={promo.ticket?.readyByDate ?? null}
          roadblocks={promo.ticket?.roadblocks ?? null}
          internalNote={promo.ticket?.internalNote ?? null}
        />
      </Card>

      {/* Assignees — editable */}
      <Card title="Assignees">
        <AssigneesEditor
          promoId={promo.id}
          assignees={promo.ticket?.assignees ?? []}
          userLookup={userLookup}
        />
      </Card>

      {/* Per-location progress — toggleable */}
      <Card title={`Per-location progress (${promo.locations.length})`}>
        <LocationProgressToggleable
          promoId={promo.id}
          locations={promo.locations}
        />
      </Card>
    </section>
  );
}

function Card({
  title,
  children
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-5 rounded-splash-lg border-[1.5px] border-gray-light bg-white p-5 shadow-splash-card">
      <h2 className="mb-3 text-base font-bold text-splash-navy">{title}</h2>
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
