// Brief 105 — fleet submissions status enum + matching pill colors.
//
// Single source of truth for apps/web. The worker re-validates server-side
// (apps/fleet-inquiry-worker/src/admin.js ALLOWED_STATUSES); keeping both
// lists in sync is a manual step on any future enum change.

export const FLEET_STATUS_OPTIONS = [
  "new",
  "reviewed",
  "contacted",
  "closed"
] as const;

export type FleetStatus = (typeof FLEET_STATUS_OPTIONS)[number];

export function isFleetStatus(v: string): v is FleetStatus {
  return (FLEET_STATUS_OPTIONS as readonly string[]).includes(v);
}

/**
 * Pill color classes for the four-value enum. Keys are the enum literals;
 * the fallback `default` is used when an unexpected value lands (e.g., a
 * pre-Brief-105 row with a NULL status — display "new" with the neutral
 * blue treatment).
 */
export const FLEET_STATUS_PILL_CLASS: Record<FleetStatus | "default", string> = {
  new: "bg-splash-blue/10 text-splash-blue",
  reviewed: "bg-sudsy-blue-soft text-splash-navy",
  contacted: "bg-amber-100 text-amber-900",
  closed: "bg-emerald-100 text-emerald-900",
  default: "bg-gray-light text-splash-navy/80"
};
