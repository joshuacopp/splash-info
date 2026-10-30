// Damage reporting (/admin/damage/reporting, damage-worker
// GET /manage/api/reporting). Pilot 3 for the kit.
//
// An aggregate report: the worker returns KPIs and rollups, not one row per
// claim, so the columns below describe the per-location rollup. What the kit
// owns here is the PERIOD: before the kit the worker resolved its five windows
// in UTC, so "this month" rolled over at 7-8 PM Eastern on the last day of a
// month. It now resolves Eastern days through the same parser the page uses.
//
// Old `?window=current_month|past_month|qtd|past_quarter|ytd` URLs keep
// working through `legacyRangeParam`.
//
// Scoping is NOT in here: damageScopeForSession in the worker decides which
// locations a caller sees.

import { defineReport } from "../define";

export interface DamageByLocationRow {
  location_code: string;
  location_pretty: string | null;
  open: number;
  awaiting_payment: number;
  closed: number;
  approved: number;
  denied: number;
  repair_cost: number;
  avg_days_open: number | null;
}

export const damageReport = defineReport<DamageByLocationRow>({
  id: "damage-reporting",
  title: "Damage Reporting",
  defaultRange: "qtd",
  presets: ["last_30", "mtd", "past_month", "qtd", "past_quarter", "ytd"],
  filters: [],
  legacyRangeParam: {
    name: "window",
    values: {
      current_month: "mtd",
      past_month: "past_month",
      qtd: "qtd",
      past_quarter: "past_quarter",
      ytd: "ytd"
    }
  },
  rowKey: (r) => r.location_code,
  columns: [
    { id: "location_code", label: "Location code", kind: "text", in: ["export"] },
    {
      id: "location_pretty",
      label: "Location",
      kind: "text",
      get: (r) => r.location_pretty ?? r.location_code
    },
    { id: "open", label: "Open", kind: "number" },
    { id: "awaiting_payment", label: "Awaiting payment", kind: "number" },
    { id: "closed", label: "Closed", kind: "number" },
    { id: "approved", label: "Approved", kind: "number" },
    { id: "denied", label: "Denied", kind: "number" },
    { id: "repair_cost", label: "Repair cost", kind: "currency" },
    { id: "avg_days_open", label: "Avg days open", kind: "number" }
  ]
});
