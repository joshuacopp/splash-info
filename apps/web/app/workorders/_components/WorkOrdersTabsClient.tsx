"use client";

// Brief 71 — Reactive / Preventative tabbed view of MaintainX work orders.
//
// Server hands two pre-grouped buckets (one per type); this client tracks:
//   • which tab is active (useState<"reactive"|"preventive"|"new">)
//   • which WO IDs are expanded (useState<Set<string>>) — flipping tabs
//     does NOT clear the expansion set; keys are unique across both
//     buckets.
//
// Expanded rows surface full description, created date (YYYY-MM-DD), the
// assignee list, and category badges.
//
// Brief 73 — collapsed-row additions: muted age label "Nd" beneath the
// priority pill on both tabs, and a Due column on the Preventative tab only
// (Reactive dueDate is auto-set to same-day by MaintainX and not
// operationally meaningful for Splash). The expanded-row Age field was
// removed because it now duplicates the collapsed-row label.
//
// Brief 74 — third tab "New Request" renders a form (NewRequestForm.tsx)
// that POSTs to /workorders/api/request as multipart/form-data, bypassing
// Next 15 server actions per Brief 37/38 pattern. URL search params
// (?tab=new&request_ok=N | ?tab=new&request_error=...) drive a banner
// above the form on the next render — the worker's 303 redirect lands
// the operator back on this page with those params set.

import { useEffect, useState } from "react";
import { PriorityPill } from "./PriorityPill";
import { StatusPill } from "./StatusPill";
import { DueDatePill } from "./DueDatePill";
import { NewRequestForm } from "./NewRequestForm";
import type {
  AccessibleLocation,
  WorkOrderItem,
  WorkOrdersCurrentUser,
  WorkOrdersGroup
} from "../_lib/worker-fetch";

type TabKey = "reactive" | "preventive" | "new";

interface Props {
  reactive: WorkOrdersGroup[];
  preventive: WorkOrdersGroup[];
  fetchedAt: string;
  truncated: boolean;
  accessibleLocationCount: number;
  mappedLocationCount: number;
  /** Brief 74 — passed through to the New Request tab. */
  accessibleLocations: AccessibleLocation[];
  currentUser: WorkOrdersCurrentUser;
}

function bucketCount(groups: WorkOrdersGroup[]): number {
  let total = 0;
  for (const g of groups) total += g.work_orders.length;
  return total;
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

function readResultBannerFromUrl(): { tab: TabKey | null; banner: RequestResultBanner | null } {
  if (typeof window === "undefined") return { tab: null, banner: null };
  const params = new URLSearchParams(window.location.search);
  const tabParam = params.get("tab");
  const okParam = params.get("request_ok");
  const errorParam = params.get("request_error");
  // Brief 76 uses `photo_warn`; Brief 75 used `request_warn` for the
  // same purpose. Read both for backwards compatibility with any
  // in-flight tab that landed on the old shape.
  const warnParam = params.get("photo_warn") ?? params.get("request_warn");
  let tab: TabKey | null = null;
  if (tabParam === "new" || tabParam === "reactive" || tabParam === "preventive") {
    tab = tabParam;
  }
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
  return { tab, banner };
}

export function WorkOrdersTabsClient(props: Props) {
  const [tab, setTab] = useState<TabKey>("reactive");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [banner, setBanner] = useState<RequestResultBanner | null>(null);

  // Worker 303-redirects back to /workorders?tab=new&request_ok=N (or
  // &request_error=...) after a New Request submit. Read those once on
  // mount, force the tab to "new" so the operator lands back on the
  // form, and clear the params from the URL bar so a refresh doesn't
  // resurrect a stale banner.
  useEffect(() => {
    const { tab: tabFromUrl, banner: bannerFromUrl } = readResultBannerFromUrl();
    if (tabFromUrl) setTab(tabFromUrl);
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

  const reactiveCount = bucketCount(props.reactive);
  const preventiveCount = bucketCount(props.preventive);
  const activeGroups = tab === "reactive" ? props.reactive : props.preventive;

  const totalAcrossBuckets = reactiveCount + preventiveCount;
  const isListTab = tab === "reactive" || tab === "preventive";
  const showEmpty =
    isListTab && totalAcrossBuckets === 0 && props.mappedLocationCount === 0;

  return (
    <>
      <FetchedAtBanner fetchedAt={props.fetchedAt} />

      {props.truncated && isListTab ? <TruncatedNotice /> : null}

      {tab === "new" && banner ? (
        <RequestResultBannerView banner={banner} />
      ) : null}

      {showEmpty ? (
        <NoAccessEmptyState
          accessibleLocationCount={props.accessibleLocationCount}
        />
      ) : (
        <>
          <TabNav
            active={tab}
            onChange={(next) => {
              setTab(next);
              // Switching tabs clears any stale banner so the next visit
              // to "new" starts blank.
              if (next !== "new") setBanner(null);
            }}
            reactiveCount={reactiveCount}
            preventiveCount={preventiveCount}
          />

          {tab === "new" ? (
            <NewRequestForm
              accessibleLocations={props.accessibleLocations}
              currentUser={props.currentUser}
            />
          ) : activeGroups.length === 0 ? (
            <BucketEmptyState tab={tab} />
          ) : (
            activeGroups.map((group) => (
              <GroupSection
                key={group.maintainx_id}
                group={group}
                expanded={expanded}
                onToggle={toggle}
                tab={tab}
              />
            ))
          )}
        </>
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
              href={`https://app.getmaintainx.com/workrequests/${banner.requestId}`}
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

function TabNav({
  active,
  onChange,
  reactiveCount,
  preventiveCount
}: {
  active: TabKey;
  onChange: (t: TabKey) => void;
  reactiveCount: number;
  preventiveCount: number;
}) {
  return (
    <div
      role="tablist"
      className="mb-5 inline-flex items-center gap-1 rounded-full border border-gray-light bg-white p-1 shadow-splash-card"
    >
      <TabButton
        active={active === "reactive"}
        onClick={() => onChange("reactive")}
        label="Reactive"
        count={reactiveCount}
      />
      <TabButton
        active={active === "preventive"}
        onClick={() => onChange("preventive")}
        label="Preventative"
        count={preventiveCount}
      />
      <TabButton
        active={active === "new"}
        onClick={() => onChange("new")}
        label="New Request"
      />
    </div>
  );
}

function TabButton({
  active,
  onClick,
  label,
  count
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count?: number;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`rounded-full px-4 py-1.5 text-sm font-semibold transition-colors ${
        active
          ? "bg-splash-navy text-white"
          : "text-splash-navy/70 hover:bg-gray-light/40"
      }`}
    >
      {label}
      {typeof count === "number" ? (
        <>
          {" "}
          <span
            className={`ml-1 inline-block rounded-full px-1.5 text-[11px] ${
              active ? "bg-white/20 text-white" : "bg-gray-light text-splash-navy/70"
            }`}
          >
            {count}
          </span>
        </>
      ) : null}
    </button>
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

function BucketEmptyState({ tab }: { tab: "reactive" | "preventive" }) {
  const label = tab === "reactive" ? "Reactive" : "Preventative";
  return (
    <div className="rounded-splash-lg border border-gray-light bg-white px-6 py-10 text-center">
      <p className="text-base font-semibold text-splash-navy">
        No open {label} work orders for your locations.
      </p>
      <p className="mt-1 text-sm text-splash-navy/70">
        For closed work orders, log into MaintainX directly.
      </p>
    </div>
  );
}

function GroupSection({
  group,
  expanded,
  onToggle,
  tab
}: {
  group: WorkOrdersGroup;
  expanded: Set<string>;
  onToggle: (id: number) => void;
  tab: "reactive" | "preventive";
}) {
  const showDueColumn = tab === "preventive";
  const colSpan = showDueColumn ? 8 : 7;
  return (
    <section className="mb-7">
      <h2 className="mb-2 text-lg font-bold text-splash-navy">
        {group.location_pretty}{" "}
        <span className="text-sm font-normal text-splash-navy/60">
          · {group.work_orders.length} open
        </span>
      </h2>
      <div className="overflow-x-auto rounded-splash-lg border border-gray-light bg-white shadow-splash-card">
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
            {group.work_orders.map((wo) => (
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
    </section>
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
