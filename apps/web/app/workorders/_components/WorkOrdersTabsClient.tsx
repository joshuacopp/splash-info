"use client";

// Brief 81 — location-first view of MaintainX work orders + requests.
//
// Replaces the Brief 71/74/80 type-level tabs (Reactive / Preventative /
// Requests / New Request) with one block per location, each holding four
// collapsible sections: Reactive, Preventative, Pending Requests, Declined
// Requests. The server still hands three type-keyed buckets (reactive,
// preventive, requests) all grouped by the same maintainx_id;
// `buildLocationBlocks` merges them into one row per location and splits
// requests by status (REJECTED → Declined, else → Pending).
//
// This client tracks:
//   • which top-level view is showing (useState<"list"|"new">) — the New
//     Request form is now a full-screen view reached from a header button
//     or any location's "+ New request", not a tab.
//   • which row IDs are expanded (useState<Set<string>>) — one shared set
//     across work orders and requests; MaintainX ids are unique across both
//     entity types so there's no collision.
//
// Section defaults: Reactive / Preventative / Pending open; Declined
// collapsed (the requests endpoint has no date param, so collapsing is how
// a long rejected history is kept from dominating the screen). Empty
// sections render muted and non-interactive.
//
// Brief 73 — collapsed-row age label "Nd" beneath the priority pill, and a
// Due column on Preventative only (Reactive dueDate is auto-set same-day by
// MaintainX). Requests sort newest-first (created desc, priority tiebreak),
// inverting the work-order priority-then-age emphasis.
//
// Brief 74 — NewRequestForm.tsx POSTs to /workorders/api/request as
// multipart/form-data, bypassing Next 15 server actions per Brief 37/38.
// URL params (?tab=new&request_ok=N | ?tab=new&request_error=...) drive a
// banner above the form on the next render — the worker's 303 redirect
// lands the operator back on this page with those params set.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { PriorityPill } from "./PriorityPill";
import { StatusPill } from "./StatusPill";
import { RequestStatusPill } from "./RequestStatusPill";
import { DueDatePill } from "./DueDatePill";
import { NewRequestForm } from "./NewRequestForm";
import type {
  AccessibleLocation,
  WorkOrderItem,
  WorkOrdersCurrentUser,
  WorkOrdersGroup,
  WorkRequestItem,
  WorkRequestsGroup
} from "../_lib/worker-fetch";

interface Props {
  reactive: WorkOrdersGroup[];
  preventive: WorkOrdersGroup[];
  /** Brief 80 — PENDING + REJECTED work requests, grouped by location. */
  requests: WorkRequestsGroup[];
  fetchedAt: string;
  truncated: boolean;
  /** Brief 80 — work-requests fetch hit its cap (independent of `truncated`). */
  requestsTruncated: boolean;
  accessibleLocationCount: number;
  mappedLocationCount: number;
  /** Brief 74 — passed through to the New Request form. */
  accessibleLocations: AccessibleLocation[];
  currentUser: WorkOrdersCurrentUser;
}

// Brief 81 — the page is now location-first: one block per location, each
// with collapsible Reactive / Preventative / Pending / Declined sections
// (replacing the Brief 71/80 type-level tabs). This aggregate merges the
// three server buckets — which arrive keyed by the same maintainx_id — into
// one row per location. Requests split by status: PENDING → pending,
// REJECTED → declined.
interface LocationBlockData {
  maintainx_id: number;
  location_pretty: string;
  reactive: WorkOrderItem[];
  preventive: WorkOrderItem[];
  pending: WorkRequestItem[];
  declined: WorkRequestItem[];
}

const PRIORITY_RANK: Record<string, number> = {
  HIGH: 0,
  MEDIUM: 1,
  LOW: 2,
  NONE: 3
};

function priorityRank(priority: string): number {
  return PRIORITY_RANK[(priority ?? "").toUpperCase()] ?? 3;
}

// Brief 81 — requests sort newest-first by created date, priority breaking
// ties. This inverts the work-order emphasis (priority-then-age): for
// requests, recency is what matters, and a declined item from 2023 should
// never float above a fresh one just because it's HIGH.
function compareRequestsNewestFirst(
  a: WorkRequestItem,
  b: WorkRequestItem
): number {
  const pa = a.createdAt ? Date.parse(a.createdAt) : NaN;
  const pb = b.createdAt ? Date.parse(b.createdAt) : NaN;
  const ta = Number.isNaN(pa) ? 0 : pa;
  const tb = Number.isNaN(pb) ? 0 : pb;
  if (tb !== ta) return tb - ta;
  return priorityRank(a.priority) - priorityRank(b.priority);
}

// Brief 81 — fold the three server buckets into one block per location.
function buildLocationBlocks(props: Props): LocationBlockData[] {
  const byId = new Map<number, LocationBlockData>();
  const ensure = (id: number, pretty: string): LocationBlockData => {
    let block = byId.get(id);
    if (!block) {
      block = {
        maintainx_id: id,
        location_pretty: pretty,
        reactive: [],
        preventive: [],
        pending: [],
        declined: []
      };
      byId.set(id, block);
    } else if (
      block.location_pretty === "(unknown location)" &&
      pretty !== "(unknown location)"
    ) {
      // Prefer a resolved name if any bucket carries one for this id.
      block.location_pretty = pretty;
    }
    return block;
  };

  for (const g of props.reactive) {
    ensure(g.maintainx_id, g.location_pretty).reactive.push(...g.work_orders);
  }
  for (const g of props.preventive) {
    ensure(g.maintainx_id, g.location_pretty).preventive.push(...g.work_orders);
  }
  for (const g of props.requests) {
    const block = ensure(g.maintainx_id, g.location_pretty);
    for (const wr of g.work_requests) {
      if ((wr.status ?? "").toUpperCase() === "REJECTED") {
        block.declined.push(wr);
      } else {
        block.pending.push(wr);
      }
    }
  }

  const blocks = [...byId.values()];
  for (const block of blocks) {
    block.pending.sort(compareRequestsNewestFirst);
    block.declined.sort(compareRequestsNewestFirst);
  }
  blocks.sort((a, b) => a.location_pretty.localeCompare(b.location_pretty));
  return blocks;
}

interface RequestResultBanner {
  /** "ok": green success only (no photo failures). "ok-warn": green
   *  success banner stacked over an amber photo-warn banner (some
   *  photos failed but the request itself was created). "error": red
   *  banner only (request creation itself failed). */
  kind: "ok" | "ok-warn" | "error";
  /** For "error": the worker's error string. For "ok-warn": the
   *  `photo_warn` value (e.g. "2-of-5-photos-failed"). For "ok": "". */
  message: string;
  requestId: number | null;
}

function readResultBannerFromUrl(): {
  isNew: boolean;
  banner: RequestResultBanner | null;
} {
  if (typeof window === "undefined") return { isNew: false, banner: null };
  const params = new URLSearchParams(window.location.search);
  const okParam = params.get("request_ok");
  const errorParam = params.get("request_error");
  // Brief 76 uses `photo_warn`; Brief 75 used `request_warn` for the
  // same purpose. Read both for backwards compatibility with any
  // in-flight tab that landed on the old shape.
  const warnParam = params.get("photo_warn") ?? params.get("request_warn");
  // Brief 81 — the type-tabs are gone; `?tab=new` is the only value the
  // worker still 303s back with after a submit, and it opens the form view.
  const isNew = params.get("tab") === "new";
  let banner: RequestResultBanner | null = null;
  if (okParam) {
    const id = Number.parseInt(okParam, 10);
    banner = {
      kind: warnParam ? "ok-warn" : "ok",
      message: warnParam ?? "",
      requestId: Number.isFinite(id) ? id : null
    };
  } else if (errorParam) {
    banner = { kind: "error", message: errorParam, requestId: null };
  }
  return { isNew, banner };
}

export function WorkOrdersTabsClient(props: Props) {
  // Brief 81 — two top-level views: the location-first list, or the New
  // Request form. `newLocationId` prefills the form's Location dropdown
  // when opened from a specific location's "+ New request" button.
  const [view, setView] = useState<"list" | "new">("list");
  const [newLocationId, setNewLocationId] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [banner, setBanner] = useState<RequestResultBanner | null>(null);

  // Worker 303-redirects back to /workorders?tab=new&request_ok=N (or
  // &request_error=...) after a New Request submit. Read those once on
  // mount, open the form view so the operator lands back on it, and clear
  // the params from the URL bar so a refresh doesn't resurrect a stale
  // banner.
  useEffect(() => {
    const { isNew, banner: bannerFromUrl } = readResultBannerFromUrl();
    if (isNew) setView("new");
    if (bannerFromUrl) {
      setBanner(bannerFromUrl);
      const url = new URL(window.location.href);
      url.searchParams.delete("request_ok");
      url.searchParams.delete("request_error");
      url.searchParams.delete("request_warn");
      url.searchParams.delete("photo_warn");
      window.history.replaceState({}, "", url.toString());
    }
  }, []);

  const toggle = (id: number) => {
    const key = String(id);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const openNewRequest = (locationId: number | null) => {
    setNewLocationId(locationId);
    setView("new");
  };

  const backToList = () => {
    setView("list");
    setBanner(null);
    setNewLocationId(null);
  };

  const blocks = useMemo(
    () => buildLocationBlocks(props),
    [props.reactive, props.preventive, props.requests]
  );

  // The New Request form is a full-screen view (not a tab). Reached from
  // the header button or any location's "+ New request".
  if (view === "new") {
    return (
      <>
        <button
          type="button"
          onClick={backToList}
          className="mb-4 inline-flex items-center gap-1 text-sm font-semibold text-splash-blue hover:underline"
        >
          ← Back to work orders
        </button>
        {banner ? <RequestResultBannerView banner={banner} /> : null}
        <NewRequestForm
          accessibleLocations={props.accessibleLocations}
          currentUser={props.currentUser}
          initialLocationId={newLocationId}
        />
      </>
    );
  }

  // No mapped locations at all → nothing the worker could have returned.
  const showNoAccess =
    blocks.length === 0 && props.mappedLocationCount === 0;

  return (
    <>
      <div className="mb-4 flex items-start justify-between gap-3">
        <FetchedAtBanner fetchedAt={props.fetchedAt} />
        <button
          type="button"
          onClick={() => openNewRequest(null)}
          className="whitespace-nowrap rounded-splash-md bg-splash-navy px-4 py-2 text-sm font-semibold text-white shadow-splash-btn hover:bg-splash-blue-dark"
        >
          + New Request
        </button>
      </div>

      {props.truncated ? <TruncatedNotice /> : null}
      {props.requestsTruncated ? <RequestsTruncatedNotice /> : null}

      {showNoAccess ? (
        <NoAccessEmptyState
          accessibleLocationCount={props.accessibleLocationCount}
        />
      ) : blocks.length === 0 ? (
        <AllClearEmptyState />
      ) : (
        blocks.map((block) => (
          <LocationBlock
            key={block.maintainx_id}
            block={block}
            expanded={expanded}
            onToggle={toggle}
            onNewRequest={openNewRequest}
          />
        ))
      )}
    </>
  );
}

// Brief 75 — known machine-readable codes from the worker. Free-form
// human strings still come through the same query param and render as-is.
const REQUEST_ERROR_MESSAGES: Record<string, string> = {
  requester_phone_required: "Requester phone is required."
};

function RequestResultBannerView({ banner }: { banner: RequestResultBanner }) {
  if (banner.kind === "error") {
    const friendly = REQUEST_ERROR_MESSAGES[banner.message] ?? banner.message;
    return (
      <div
        role="alert"
        className="mb-5 rounded-md border border-splash-deny/50 bg-splash-deny/10 px-4 py-3 text-sm text-splash-deny"
      >
        Couldn&apos;t create the request: {friendly}
      </div>
    );
  }
  // "ok" or "ok-warn": render the green success banner; for "ok-warn",
  // stack a secondary amber banner underneath surfacing the photo
  // failure count. Brief 76 split these — request creation succeeded;
  // some photos didn't.
  return (
    <>
      <div
        role="status"
        className="mb-2 rounded-md border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-900"
      >
        Request{banner.requestId != null ? ` #${banner.requestId}` : ""} created.
        {banner.requestId != null ? (
          <>
            {" "}
            <a
              href={`https://app.getmaintainx.com/requests/${banner.requestId}`}
              target="_blank"
              rel="noreferrer"
              className="font-semibold text-splash-blue hover:underline"
            >
              View in MaintainX ↗
            </a>
          </>
        ) : null}
      </div>
      {banner.kind === "ok-warn" ? (
        <div
          role="status"
          className="mb-5 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
        >
          {photoWarnFriendly(banner.message)} The request itself was
          created — re-add the missing photos in MaintainX.
        </div>
      ) : (
        <div className="mb-5" />
      )}
    </>
  );
}

/** Translate the worker's `photo_warn` value into a human sentence.
 *  - "thumbnail_failed" — Brief 75's single-photo shape (stale).
 *  - "{N}-of-{M}-photos-failed" — Brief 76 multi-photo shape. */
function photoWarnFriendly(message: string): string {
  if (message === "thumbnail_failed") {
    return "The photo couldn't be uploaded as the request thumbnail.";
  }
  const match = /^(\d+)-of-(\d+)-photos-failed$/.exec(message);
  if (match) {
    const n = match[1];
    const m = match[2];
    return `${n} of ${m} photos failed to upload.`;
  }
  return message.replace(/-/g, " ");
}

function FetchedAtBanner({ fetchedAt }: { fetchedAt: string }) {
  return (
    <p className="mb-4 text-xs text-splash-navy/50">
      As of {formatRelativeTime(fetchedAt)}
    </p>
  );
}

function TruncatedNotice() {
  return (
    <div className="mb-5 rounded-md border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900">
      Showing first 1000 work orders. Older items aren&apos;t visible
      here — log into MaintainX directly for the full list.
    </div>
  );
}

// Brief 80 — requests-tab counterpart to TruncatedNotice.
function RequestsTruncatedNotice() {
  return (
    <div className="mb-5 rounded-md border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900">
      Showing the most recent requests. Older items aren&apos;t visible
      here — log into MaintainX directly for the full list.
    </div>
  );
}

function NoAccessEmptyState({
  accessibleLocationCount
}: {
  accessibleLocationCount: number;
}) {
  return (
    <div className="rounded-splash-lg border border-yellow-300 bg-yellow-50 px-6 py-6">
      <h2 className="text-base font-semibold text-yellow-900">
        No work orders to show.
      </h2>
      <p className="mt-2 text-sm text-yellow-900/90">Possible reasons:</p>
      <ol className="mt-2 list-decimal pl-5 text-sm text-yellow-900/90">
        <li>
          Your email isn&apos;t on{" "}
          <code className="rounded bg-yellow-100 px-1">am_email</code>,{" "}
          <code className="rounded bg-yellow-100 px-1">rm_email</code>, or{" "}
          <code className="rounded bg-yellow-100 px-1">site_email</code> for
          any location — ask a super_admin to update via the sysadmin
          Update Location editor.
        </li>
        <li>
          {accessibleLocationCount > 0
            ? "Your locations aren't yet mapped to MaintainX (locations.maintainx_id is null) — same fix path."
            : "Your locations aren't yet mapped to MaintainX (locations.maintainx_id is null) — once a location row exists with your email on it, the mapping is the next step."}
        </li>
      </ol>
    </div>
  );
}

// Brief 81 — shown when the operator has mapped locations but every one of
// them is empty across all four sections. Replaces the per-tab
// BucketEmptyState / RequestsEmptyState.
function AllClearEmptyState() {
  return (
    <div className="rounded-splash-lg border border-gray-light bg-white px-6 py-10 text-center">
      <p className="text-base font-semibold text-splash-navy">
        All clear — no open work orders or requests for your locations.
      </p>
      <p className="mt-1 text-sm text-splash-navy/70">
        Closed work orders and approved requests live in MaintainX. Start a
        new request with the button above.
      </p>
    </div>
  );
}

// Brief 81 — one location's block: a header with a per-location "+ New
// request" button, followed by four collapsible sections. Reactive,
// Preventative and Pending default open; Declined defaults collapsed so a
// long rejected history doesn't dominate the screen (there's no date param
// on the requests endpoint to bound it server-side).
function LocationBlock({
  block,
  expanded,
  onToggle,
  onNewRequest
}: {
  block: LocationBlockData;
  expanded: Set<string>;
  onToggle: (id: number) => void;
  onNewRequest: (locationId: number | null) => void;
}) {
  return (
    <section className="mb-8">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-lg font-bold text-splash-navy">
          {block.location_pretty}
        </h2>
        <button
          type="button"
          onClick={() => onNewRequest(block.maintainx_id)}
          className="whitespace-nowrap rounded-splash-md border border-splash-navy/20 px-3 py-1.5 text-xs font-semibold text-splash-navy hover:bg-gray-light/40"
        >
          + New request
        </button>
      </div>

      <div className="space-y-2">
        <CollapsibleSection
          title="Reactive"
          count={block.reactive.length}
          defaultOpen
        >
          <WorkOrderTable
            workOrders={block.reactive}
            expanded={expanded}
            onToggle={onToggle}
            showDueColumn={false}
          />
        </CollapsibleSection>

        <CollapsibleSection
          title="Preventative"
          count={block.preventive.length}
          defaultOpen
        >
          <WorkOrderTable
            workOrders={block.preventive}
            expanded={expanded}
            onToggle={onToggle}
            showDueColumn
          />
        </CollapsibleSection>

        <CollapsibleSection
          title="Pending Requests"
          count={block.pending.length}
          defaultOpen
        >
          <RequestTable
            requests={block.pending}
            expanded={expanded}
            onToggle={onToggle}
          />
        </CollapsibleSection>

        <CollapsibleSection
          title="Declined Requests"
          count={block.declined.length}
          defaultOpen={false}
        >
          <RequestTable
            requests={block.declined}
            expanded={expanded}
            onToggle={onToggle}
          />
        </CollapsibleSection>
      </div>
    </section>
  );
}

// Brief 81 — a titled, count-badged collapsible. When count === 0 it's
// rendered muted and non-interactive (no chevron affordance, no body) so an
// operator can see at a glance that a section is empty without being able to
// expand into nothing.
function CollapsibleSection({
  title,
  count,
  defaultOpen,
  children
}: {
  title: string;
  count: number;
  defaultOpen: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const empty = count === 0;

  if (empty) {
    return (
      <div className="flex items-center gap-2 rounded-splash-md border border-gray-light bg-white px-3 py-2 text-sm">
        <span className="w-3 text-splash-navy/30" aria-hidden="true">
          ▶
        </span>
        <span className="font-semibold text-splash-navy/40">{title}</span>
        <CountPill count={count} muted />
      </div>
    );
  }

  return (
    <div className="rounded-splash-md border border-gray-light bg-white">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-gray-light/30"
      >
        <Chevron expanded={open} />
        <span className="font-semibold text-splash-navy">{title}</span>
        <CountPill count={count} />
      </button>
      {open ? <div className="border-t border-gray-light">{children}</div> : null}
    </div>
  );
}

function CountPill({ count, muted }: { count: number; muted?: boolean }) {
  return (
    <span
      className={`ml-0.5 inline-block rounded-full px-1.5 text-[11px] font-semibold ${
        muted
          ? "bg-gray-light/60 text-splash-navy/40"
          : "bg-gray-light text-splash-navy/70"
      }`}
    >
      {count}
    </span>
  );
}

// Brief 81 — request table body (no location header — LocationBlock owns
// that now). Same columns as the old RequestGroupSection.
function RequestTable({
  requests,
  expanded,
  onToggle
}: {
  requests: WorkRequestItem[];
  expanded: Set<string>;
  onToggle: (id: number) => void;
}) {
  // Requests and work orders share one `expanded` Set keyed by numeric id.
  // MaintainX ids are unique across both entity types, so there's no
  // collision risk from reusing the same set.
  const colSpan = 6;
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="bg-gray-light/40 text-left text-[11px] font-semibold uppercase tracking-wide text-splash-navy/70">
            <th className="w-6 px-2 py-2" aria-hidden="true"></th>
            <th className="px-3 py-2">Priority</th>
            <th className="px-3 py-2">Title</th>
            <th className="px-3 py-2">Status</th>
            <th className="px-3 py-2">Requested by</th>
            <th className="px-3 py-2">Updated</th>
            <th className="px-3 py-2 text-right">MaintainX</th>
          </tr>
        </thead>
        <tbody>
          {requests.map((wr) => (
            <WorkRequestRow
              key={wr.id}
              wr={wr}
              isExpanded={expanded.has(String(wr.id))}
              onToggle={onToggle}
              colSpan={colSpan}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function WorkRequestRow({
  wr,
  isExpanded,
  onToggle,
  colSpan
}: {
  wr: WorkRequestItem;
  isExpanded: boolean;
  onToggle: (id: number) => void;
  colSpan: number;
}) {
  return (
    <>
      <tr
        className="cursor-pointer border-t border-gray-light/60 align-top hover:bg-gray-light/20"
        onClick={() => onToggle(wr.id)}
      >
        <td className="px-2 py-2.5">
          <Chevron expanded={isExpanded} />
        </td>
        <td className="px-3 py-2.5 whitespace-nowrap">
          <PriorityPill priority={wr.priority} />
          <div className="mt-0.5 px-2 text-xs text-gray-500">
            {wr.createdAt ? ageLabel(wr.createdAt) : "—"}
          </div>
        </td>
        <td className="px-3 py-2.5">
          <div className="font-medium text-splash-navy">
            {wr.title || "(no title)"}
          </div>
        </td>
        <td className="px-3 py-2.5 whitespace-nowrap">
          <RequestStatusPill status={wr.status} />
        </td>
        <td className="px-3 py-2.5 text-sm text-splash-navy">
          {wr.creator?.name ? wr.creator.name : "—"}
        </td>
        <td
          className="px-3 py-2.5 whitespace-nowrap text-xs text-splash-navy/70"
          title={wr.updatedAt ?? undefined}
        >
          {wr.updatedAt ? formatRelativeTime(wr.updatedAt) : "—"}
        </td>
        <td className="px-3 py-2.5 whitespace-nowrap text-right">
          <a
            href={`https://app.getmaintainx.com/requests/${wr.id}`}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="text-sm font-semibold text-splash-blue hover:underline"
          >
            Open ↗
          </a>
        </td>
      </tr>
      {isExpanded ? <RequestExpandedRow wr={wr} colSpan={colSpan} /> : null}
    </>
  );
}

function RequestExpandedRow({
  wr,
  colSpan
}: {
  wr: WorkRequestItem;
  colSpan: number;
}) {
  const created = wr.createdAt ? formatYmd(wr.createdAt) : "—";
  return (
    <tr className="border-t border-gray-light/30 bg-gray-light/10">
      <td colSpan={colSpan} className="px-6 py-4 text-sm text-splash-navy/90">
        <dl className="grid grid-cols-1 gap-x-8 gap-y-2 sm:grid-cols-2">
          <div>
            <dt className="text-[11px] font-semibold uppercase tracking-wide text-splash-navy/60">
              Created
            </dt>
            <dd>{created}</dd>
          </div>
          <div>
            <dt className="text-[11px] font-semibold uppercase tracking-wide text-splash-navy/60">
              Requested by
            </dt>
            <dd>
              {wr.creator?.name ? wr.creator.name : "—"}
              {wr.creator?.email ? (
                <span className="text-splash-navy/60">
                  {" "}
                  ({wr.creator.email})
                </span>
              ) : null}
            </dd>
          </div>
        </dl>
        {/* A REJECTED request that also carries a workOrderId was promoted
            before being rejected; surface the link so staff can trace it. */}
        {wr.workOrderId != null ? (
          <div className="mt-3">
            <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-splash-navy/60">
              Linked work order
            </p>
            <a
              href={`https://app.getmaintainx.com/workorders/${wr.workOrderId}`}
              target="_blank"
              rel="noreferrer"
              className="text-sm font-semibold text-splash-blue hover:underline"
            >
              Work order #{wr.workOrderId} ↗
            </a>
          </div>
        ) : null}
        <div className="mt-3">
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-splash-navy/60">
            Description
          </p>
          <p className="whitespace-pre-wrap text-sm text-splash-navy/90">
            {wr.description ? wr.description : "(no description)"}
          </p>
        </div>
      </td>
    </tr>
  );
}

// Brief 81 — work-order table body (no location header — LocationBlock owns
// that now). Reactive passes showDueColumn={false}; Preventative passes it
// true (Reactive dueDate is auto-set same-day by MaintainX, per Brief 73).
function WorkOrderTable({
  workOrders,
  expanded,
  onToggle,
  showDueColumn
}: {
  workOrders: WorkOrderItem[];
  expanded: Set<string>;
  onToggle: (id: number) => void;
  showDueColumn: boolean;
}) {
  const colSpan = showDueColumn ? 8 : 7;
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="bg-gray-light/40 text-left text-[11px] font-semibold uppercase tracking-wide text-splash-navy/70">
            <th className="w-6 px-2 py-2" aria-hidden="true"></th>
            <th className="px-3 py-2">Priority</th>
            <th className="px-3 py-2">Title</th>
            <th className="px-3 py-2">Status</th>
            {showDueColumn ? <th className="px-3 py-2">Due</th> : null}
            <th className="px-3 py-2">Assignees</th>
            <th className="px-3 py-2">Updated</th>
            <th className="px-3 py-2 text-right">MaintainX</th>
          </tr>
        </thead>
        <tbody>
          {workOrders.map((wo) => (
            <WorkOrderRow
              key={wo.id}
              wo={wo}
              isExpanded={expanded.has(String(wo.id))}
              onToggle={onToggle}
              showDueColumn={showDueColumn}
              colSpan={colSpan}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function WorkOrderRow({
  wo,
  isExpanded,
  onToggle,
  showDueColumn,
  colSpan
}: {
  wo: WorkOrderItem;
  isExpanded: boolean;
  onToggle: (id: number) => void;
  showDueColumn: boolean;
  colSpan: number;
}) {
  return (
    <>
      <tr
        className="cursor-pointer border-t border-gray-light/60 align-top hover:bg-gray-light/20"
        onClick={() => onToggle(wo.id)}
      >
        <td className="px-2 py-2.5">
          <Chevron expanded={isExpanded} />
        </td>
        <td className="px-3 py-2.5 whitespace-nowrap">
          <PriorityPill priority={wo.priority} />
          {/* Brief 74 — px-2 matches the pill's horizontal padding so the
              age text sits under the pill's text content, not its left
              edge. */}
          <div className="mt-0.5 px-2 text-xs text-gray-500">
            {wo.createdAt ? ageLabel(wo.createdAt) : "—"}
          </div>
        </td>
        <td className="px-3 py-2.5">
          <div className="font-medium text-splash-navy">
            {wo.title || "(no title)"}
          </div>
          {wo.sequentialId != null ? (
            <div className="mt-0.5 text-xs text-splash-navy/60">
              #{wo.sequentialId}
            </div>
          ) : null}
        </td>
        <td className="px-3 py-2.5 whitespace-nowrap">
          <StatusPill status={wo.status} />
        </td>
        {showDueColumn ? (
          <td
            className="px-3 py-2.5 whitespace-nowrap"
            title={wo.dueDate ?? undefined}
          >
            <DueDatePill dueDate={wo.dueDate} />
          </td>
        ) : null}
        <td className="px-3 py-2.5 text-sm text-splash-navy">
          {wo.assignees.length === 0
            ? "—"
            : wo.assignees.map((a) => a.name).join(", ")}
        </td>
        <td
          className="px-3 py-2.5 whitespace-nowrap text-xs text-splash-navy/70"
          title={wo.updatedAt ?? undefined}
        >
          {wo.updatedAt ? formatRelativeTime(wo.updatedAt) : "—"}
        </td>
        <td className="px-3 py-2.5 whitespace-nowrap text-right">
          <a
            href={`https://app.getmaintainx.com/workorders/${wo.id}`}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="text-sm font-semibold text-splash-blue hover:underline"
          >
            Open ↗
          </a>
        </td>
      </tr>
      {isExpanded ? <ExpandedRow wo={wo} colSpan={colSpan} /> : null}
    </>
  );
}

// Brief 73 — collapsed-row age label under the priority pill on both tabs.
// `<1d` floor matches the AgePill convention from Briefs 68/69.
function ageLabel(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const days = Math.floor((Date.now() - t) / 86_400_000);
  return days < 1 ? "<1d" : `${days}d`;
}

function Chevron({ expanded }: { expanded: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block text-splash-navy/60 transition-transform ${
        expanded ? "rotate-90" : ""
      }`}
    >
      ▶
    </span>
  );
}

function ExpandedRow({ wo, colSpan }: { wo: WorkOrderItem; colSpan: number }) {
  const created = wo.createdAt ? formatYmd(wo.createdAt) : "—";
  return (
    <tr className="border-t border-gray-light/30 bg-gray-light/10">
      <td colSpan={colSpan} className="px-6 py-4 text-sm text-splash-navy/90">
        <dl className="grid grid-cols-1 gap-x-8 gap-y-2 sm:grid-cols-2">
          <div>
            <dt className="text-[11px] font-semibold uppercase tracking-wide text-splash-navy/60">
              Created
            </dt>
            <dd>{created}</dd>
          </div>
          <div>
            <dt className="text-[11px] font-semibold uppercase tracking-wide text-splash-navy/60">
              Assignees
            </dt>
            <dd>
              {wo.assignees.length === 0
                ? "—"
                : wo.assignees.map((a) => a.name).join(", ")}
            </dd>
          </div>
        </dl>
        {wo.categories.length > 0 ? (
          <div className="mt-3">
            <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-splash-navy/60">
              Categories
            </p>
            <div className="flex flex-wrap gap-1.5">
              {wo.categories.map((c) => (
                <span
                  key={c}
                  className="inline-flex items-center rounded-full bg-sudsy-blue/15 px-2 py-0.5 text-[11px] text-splash-navy/80"
                >
                  {c}
                </span>
              ))}
            </div>
          </div>
        ) : null}
        <div className="mt-3">
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-splash-navy/60">
            Description
          </p>
          <p className="whitespace-pre-wrap text-sm text-splash-navy/90">
            {wo.description ? wo.description : "(no description)"}
          </p>
        </div>
      </td>
    </tr>
  );
}

function formatYmd(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const d = new Date(t);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function formatRelativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const now = Date.now();
  const diffMs = now - then;
  const sec = Math.round(diffMs / 1000);
  if (sec < 0) return "just now";
  if (sec < 60) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} minute${min === 1 ? "" : "s"} ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? "" : "s"} ago`;
  const day = Math.round(hr / 24);
  if (day === 1) return "yesterday";
  if (day < 7) return `${day} days ago`;
  const d = new Date(then);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric"
  });
}
