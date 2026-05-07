"use client";

// Brief 67 — By Location table with per-row drill-down expansion.
//
// Each location row is clickable; clicking toggles a per-location expanded
// panel beneath it that renders four damage-type breakdown tables (Open /
// Closed / Approved with cost / Denied). Multiple rows can be expanded
// simultaneously; state is session-only (mirrors the audit-log expansion
// posture from Brief 53).

import { useState } from "react";

type DrilldownBucket =
  | "open"
  | "denied"
  | "approved"
  | "closed_approved"
  | "closed_other";

interface ByLocationRow {
  location_code: string;
  location_pretty: string | null;
  open: number;
  closed: number;
  approved: number;
  denied: number;
  repair_cost: number;
  avg_days_open: number | null;
}

interface DrilldownRow {
  location_code: string;
  location_pretty: string | null;
  outcome_bucket: DrilldownBucket;
  damage_type: string;
  n: number;
  cost: number;
}

interface DamageTypeRow {
  damage_type: string;
  count: number;
  cost?: number;
}

function formatCurrency(n: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(n);
}

function formatAvgDays(v: number | null): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  return `${Math.round(v)}d`;
}

function aggregateDrilldown(
  rows: DrilldownRow[],
  buckets: ReadonlyArray<DrilldownBucket>,
  withCost: boolean
): DamageTypeRow[] {
  const acc = new Map<string, { count: number; cost: number }>();
  for (const r of rows) {
    if (!buckets.includes(r.outcome_bucket)) continue;
    const cur = acc.get(r.damage_type) ?? { count: 0, cost: 0 };
    cur.count += r.n;
    cur.cost += r.cost;
    acc.set(r.damage_type, cur);
  }
  const out: DamageTypeRow[] = [];
  for (const [damage_type, v] of acc) {
    out.push(
      withCost
        ? { damage_type, count: v.count, cost: v.cost }
        : { damage_type, count: v.count }
    );
  }
  out.sort((a, b) => b.count - a.count);
  return out;
}

function DamageTypeMiniTable({
  heading,
  rows,
  showCost
}: {
  heading: string;
  rows: DamageTypeRow[];
  showCost: boolean;
}) {
  return (
    <div className="overflow-hidden rounded-splash-lg border border-gray-light bg-white shadow-splash-card">
      <div className="bg-splash-navy/5 px-4 py-2 text-xs font-semibold uppercase tracking-wider text-splash-navy/70">
        {heading}
      </div>
      {rows.length === 0 ? (
        <p className="px-4 py-3 text-sm text-splash-navy/70">(none)</p>
      ) : (
        <table className="min-w-full divide-y divide-gray-light text-sm">
          <tbody className="divide-y divide-gray-light text-splash-navy">
            {rows.map((row) => (
              <tr key={row.damage_type}>
                <td className="px-4 py-2">{row.damage_type}</td>
                <td className="px-4 py-2 text-right font-mono text-xs text-splash-navy/80">
                  {row.count}
                </td>
                {showCost ? (
                  <td className="px-4 py-2 text-right font-mono text-xs text-splash-navy/80">
                    {formatCurrency(row.cost ?? 0)}
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function DrilldownPanel({
  locationCode,
  drilldown
}: {
  locationCode: string;
  drilldown: DrilldownRow[];
}) {
  const forLocation = drilldown.filter((r) => r.location_code === locationCode);
  const openRows = aggregateDrilldown(forLocation, ["open"], false);
  const closedRows = aggregateDrilldown(
    forLocation,
    ["denied", "closed_approved", "closed_other"],
    false
  );
  const approvedRows = aggregateDrilldown(
    forLocation,
    ["approved", "closed_approved"],
    true
  );
  const deniedRows = aggregateDrilldown(forLocation, ["denied"], false);

  return (
    <div className="grid grid-cols-1 gap-3 p-4 md:grid-cols-2 xl:grid-cols-4">
      <DamageTypeMiniTable heading="Open" rows={openRows} showCost={false} />
      <DamageTypeMiniTable heading="Closed" rows={closedRows} showCost={false} />
      <DamageTypeMiniTable
        heading="Approved"
        rows={approvedRows}
        showCost={true}
      />
      <DamageTypeMiniTable heading="Denied" rows={deniedRows} showCost={false} />
    </div>
  );
}

export function ByLocationTableClient({
  rows,
  drilldown
}: {
  rows: ByLocationRow[];
  drilldown: DrilldownRow[];
}) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const toggle = (code: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  };

  if (rows.length === 0) {
    return <p className="text-sm text-splash-navy/70">No claims in this window.</p>;
  }

  return (
    <div className="overflow-hidden rounded-splash-lg border border-gray-light bg-white shadow-splash-card">
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-light text-sm">
          <thead className="bg-splash-navy/5 text-left text-xs font-semibold uppercase tracking-wider text-splash-navy/70">
            <tr>
              <th className="px-4 py-3 w-8" aria-hidden="true"></th>
              <th className="px-4 py-3">Location</th>
              <th className="px-4 py-3 text-right">Open</th>
              <th className="px-4 py-3 text-right">Closed</th>
              <th className="px-4 py-3 text-right">Approved</th>
              <th className="px-4 py-3 text-right">Denied</th>
              <th className="px-4 py-3 text-right">Avg Days Open</th>
              <th className="px-4 py-3 text-right">Cost</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-light text-splash-navy">
            {rows.map((row) => {
              const isOpen = expanded.has(row.location_code);
              return (
                <DrilldownRowFragment
                  key={row.location_code}
                  row={row}
                  isOpen={isOpen}
                  onToggle={() => toggle(row.location_code)}
                  drilldown={drilldown}
                />
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function DrilldownRowFragment({
  row,
  isOpen,
  onToggle,
  drilldown
}: {
  row: ByLocationRow;
  isOpen: boolean;
  onToggle: () => void;
  drilldown: DrilldownRow[];
}) {
  return (
    <>
      <tr
        className="cursor-pointer hover:bg-splash-blue/5"
        onClick={onToggle}
        aria-expanded={isOpen}
      >
        <td className="px-4 py-3 text-center text-splash-navy/60">
          <span aria-hidden="true">{isOpen ? "▼" : "▶"}</span>
        </td>
        <td className="px-4 py-3">
          <div className="text-splash-navy">
            {row.location_pretty ?? row.location_code}
          </div>
          <div className="font-mono text-xs text-splash-navy/60">
            {row.location_code}
          </div>
        </td>
        <td className="px-4 py-3 text-right font-mono text-xs text-splash-navy/80">
          {row.open}
        </td>
        <td className="px-4 py-3 text-right font-mono text-xs text-splash-navy/80">
          {row.closed}
        </td>
        <td className="px-4 py-3 text-right font-mono text-xs text-splash-navy/80">
          {row.approved}
        </td>
        <td className="px-4 py-3 text-right font-mono text-xs text-splash-navy/80">
          {row.denied}
        </td>
        <td className="px-4 py-3 text-right font-mono text-xs text-splash-navy/80">
          {formatAvgDays(row.avg_days_open)}
        </td>
        <td className="px-4 py-3 text-right font-mono text-xs text-splash-navy/80">
          {formatCurrency(row.repair_cost)}
        </td>
      </tr>
      {isOpen ? (
        <tr className="bg-splash-navy/[0.02]">
          <td colSpan={8} className="p-0">
            <DrilldownPanel
              locationCode={row.location_code}
              drilldown={drilldown}
            />
          </td>
        </tr>
      ) : null}
    </>
  );
}
