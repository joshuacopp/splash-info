// Brief 158a — Promotions dashboard list (/admin/promotions).
//
// Server component. Any non-null `session.promoRole` passes the gate;
// `null` renders a no-access card. The page is filterable via URL search
// params (status / priority / assigned_to_me / search / offset / limit)
// and renders a responsive card grid of every promo the worker returns.
//
// Worker contract: `GET /promo/api/promos` (Brief 154) — `internalNote` is
// already stripped by the worker for non-IT callers; nothing to gate here.

import Link from "next/link";
import { getMe } from "../../_lib/me";
import { listPromos, type PromoListResponse } from "./_lib/worker-fetch";
import PromoFilterBar from "./_components/PromoFilterBar";
import PromoStatusPill from "./_components/PromoStatusPill";
import PromoPriorityPill from "./_components/PromoPriorityPill";
import NoAccessCard from "./_components/NoAccessCard";
import { formatEst } from "../jotform/_lib/format-est";

export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 24; // 3 cols × 8 rows

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function readStringParam(
  raw: string | string[] | undefined
): string | undefined {
  if (typeof raw !== "string") return undefined;
  if (raw === "") return undefined;
  return raw;
}

function readNumberParam(
  raw: string | string[] | undefined,
  fallback: number
): number {
  const s = readStringParam(raw);
  if (!s) return fallback;
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export default async function PromotionsListPage({ searchParams }: PageProps) {
  const sp = await searchParams;

  const session = await getMe().catch(() => null);
  if (!session) {
    return <NoAccessCard reason="signin" returnPath="/admin/promotions" />;
  }
  if (session.promoRole === null) {
    return <NoAccessCard reason="no-promo-role" />;
  }

  const status = readStringParam(sp.status);
  const priority = readStringParam(sp.priority);
  const assignedToMe = readStringParam(sp.assigned_to_me) === "1";
  const search = readStringParam(sp.search);
  const offset = readNumberParam(sp.offset, 0);
  const limit = readNumberParam(sp.limit, DEFAULT_LIMIT);

  let response: PromoListResponse | null = null;
  let fetchError: string | null = null;
  try {
    response = await listPromos({
      status,
      priority: priority as PromoListResponse["promos"][number]["priority"] | undefined,
      assignedToMe,
      search,
      offset,
      limit
    });
    if (!response) {
      // 401/403 — gate already passed at the page level so this shouldn't
      // normally fire; treat as a forbidden surface defensively.
      return <NoAccessCard reason="no-promo-role" />;
    }
  } catch (err) {
    fetchError = err instanceof Error ? err.message : String(err);
  }

  return (
    <section className="mx-auto w-full max-w-[1200px] px-5 py-9">
      <div className="mb-2 text-sm">
        <Link
          href="/admin/dashboard"
          className="text-splash-blue hover:underline"
        >
          ← Dashboard
        </Link>
      </div>

      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="mb-1 text-xs font-semibold uppercase tracking-[0.18em] text-sudsy-blue">
            Internal Tools
          </p>
          <h1 className="text-2xl font-bold text-splash-navy">Promotions</h1>
          <p className="mt-1 text-sm text-splash-navy/70">
            Plan, scope, and run promotional campaigns across locations.
          </p>
        </div>
        {(session.promoRole === "super_admin" ||
          session.promoRole === "it" ||
          session.promoRole === "marketing") && (
          <Link
            href="/admin/promotions/new"
            className="inline-flex items-center gap-1.5 rounded-splash-sm bg-splash-blue px-4 py-2 text-sm font-bold text-white shadow-splash-btn hover:bg-splash-blue-dark"
          >
            + New promotion
          </Link>
        )}
      </div>

      <PromoFilterBar />

      {fetchError && (
        <p className="mb-5 rounded-splash-md border border-racecar-red bg-white px-3 py-2 text-racecar-red">
          Failed to load promotions: {fetchError}
        </p>
      )}

      {response && (
        <>
          <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-splash-navy/55">
            {response.total} {response.total === 1 ? "promotion" : "promotions"}
            {response.total > 0 && (
              <>
                {" "}
                · showing {offset + 1}–
                {Math.min(offset + response.promos.length, response.total)}
              </>
            )}
          </p>
          {response.promos.length === 0 ? (
            <EmptyState
              hasFilters={
                Boolean(status) ||
                Boolean(priority) ||
                Boolean(search) ||
                assignedToMe
              }
              canCreate={
                session.promoRole === "super_admin" ||
                session.promoRole === "it" ||
                session.promoRole === "marketing"
              }
            />
          ) : (
            <PromoCardGrid promos={response.promos} />
          )}
          <Pagination
            total={response.total}
            limit={limit}
            offset={offset}
            searchParams={sp}
          />
        </>
      )}
    </section>
  );
}

function EmptyState({
  hasFilters,
  canCreate
}: {
  hasFilters: boolean;
  canCreate: boolean;
}) {
  if (hasFilters) {
    return (
      <div className="rounded-splash-md border border-gray-light bg-white px-4 py-8 text-center italic text-splash-navy/60">
        No promotions match these filters. Try widening the search or
        clearing the filter bar.
      </div>
    );
  }
  return (
    <div className="rounded-splash-md border border-gray-light bg-white px-4 py-10 text-center">
      <p className="mb-3 font-semibold text-splash-navy">
        No promotions yet.
      </p>
      {canCreate && (
        <Link
          href="/admin/promotions/new"
          className="inline-flex items-center gap-1.5 rounded-splash-sm bg-splash-blue px-5 py-2 text-sm font-bold text-white shadow-splash-btn hover:bg-splash-blue-dark"
        >
          + Create your first promotion
        </Link>
      )}
    </div>
  );
}

function PromoCardGrid({
  promos
}: {
  promos: PromoListResponse["promos"];
}) {
  return (
    <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {promos.map((p) => {
        const goLive = formatEst(`${p.requestedGoLiveDate}T00:00:00Z`);
        return (
          <li key={p.id}>
            <Link
              href={`/admin/promotions/${encodeURIComponent(p.id)}`}
              className="flex h-full flex-col gap-3 rounded-splash-lg border border-gray-light bg-white p-4 shadow-splash-card transition-shadow hover:shadow-splash-card-hover"
            >
              <div className="flex items-start justify-between gap-2">
                <h2 className="line-clamp-2 text-base font-bold text-splash-navy">
                  {p.title}
                </h2>
                <PromoPriorityPill priority={p.priority} size="sm" />
              </div>
              <div>
                <PromoStatusPill status={p.status} size="sm" />
                <span className="ml-2 text-[0.6875rem] uppercase tracking-wide text-splash-navy/55">
                  {p.promoType}
                </span>
              </div>
              <dl className="grid grid-cols-2 gap-1.5 text-xs">
                <div>
                  <dt className="text-splash-navy/55">Locations</dt>
                  <dd className="font-semibold text-splash-navy">
                    {p.completedLocationCount} / {p.locationCount}
                  </dd>
                </div>
                <div>
                  <dt className="text-splash-navy/55">Assignees</dt>
                  <dd className="font-semibold text-splash-navy">
                    {p.assigneeCount}
                  </dd>
                </div>
                <div className="col-span-2">
                  <dt className="text-splash-navy/55">Requested go-live</dt>
                  <dd
                    className="font-semibold text-splash-navy"
                    title={p.requestedGoLiveDate}
                  >
                    {goLive.absolute || p.requestedGoLiveDate}
                  </dd>
                </div>
              </dl>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

function Pagination({
  total,
  limit,
  offset,
  searchParams
}: {
  total: number;
  limit: number;
  offset: number;
  searchParams: Record<string, string | string[] | undefined>;
}) {
  if (total <= limit) return null;
  const prev = Math.max(0, offset - limit);
  const next = offset + limit;
  const hasPrev = offset > 0;
  const hasNext = next < total;
  if (!hasPrev && !hasNext) return null;

  function buildHref(targetOffset: number): string {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(searchParams)) {
      if (typeof v === "string" && v.length > 0 && k !== "offset") sp.set(k, v);
    }
    if (targetOffset > 0) sp.set("offset", String(targetOffset));
    const qs = sp.toString();
    return qs ? `?${qs}` : "?";
  }

  return (
    <nav className="mt-6 flex items-center justify-between gap-3" aria-label="Pagination">
      <span className="text-xs text-splash-navy/55">
        Page {Math.floor(offset / limit) + 1} of{" "}
        {Math.ceil(total / limit)}
      </span>
      <div className="flex gap-2">
        {hasPrev && (
          <Link
            href={buildHref(prev)}
            className="inline-flex items-center rounded-splash-sm border border-splash-blue bg-white px-3 py-1.5 text-sm font-bold text-splash-blue hover:bg-splash-blue/5"
          >
            ← Previous
          </Link>
        )}
        {hasNext && (
          <Link
            href={buildHref(next)}
            className="inline-flex items-center rounded-splash-sm bg-splash-blue px-3 py-1.5 text-sm font-bold text-white shadow-splash-btn hover:bg-splash-blue-dark"
          >
            Next →
          </Link>
        )}
      </div>
    </nav>
  );
}
