// Server-side fetch helpers for beekeeper-worker (the Beekeeper shift editor).
//
// Mirrors the dual-mode pattern from
// `apps/web/app/workorders/_lib/worker-fetch.ts`: prefer the BEEKEEPER_WORKER
// service binding (production, same-runtime, Cookie passthrough) and fall back
// to a URL fetch for `next dev`. The worker is API-only at /schedule/api/*;
// the pages here own /schedule and /schedule/{location}.
//
// Interactive writes (create/update/delete) do NOT go through this module —
// the client component posts same-origin to /schedule/api/loc/{code}/... and
// Cloudflare routes those to the worker. This module is read-only SSR.

import { cookies, headers } from "next/headers";
import { getCloudflareContext } from "@opennextjs/cloudflare";

/* ============================================================
 * Response shapes — match beekeeper-worker's handlers.ts JSON.
 * ============================================================ */

/** GET /schedule/api/locations */
export interface ScheduleLocation {
  code: string;
  name: string;
}

/** One assignable employee (GET .../context roster[]). */
export interface RosterMember {
  id: string;
  name: string;
}

/** GET /schedule/api/loc/{code}/context */
export interface ScheduleContext {
  locationCode: string;
  scheduleId: string;
  name: string | null;
  roster: RosterMember[];
}

/** One shift row (GET .../shifts). `startDate`/`endDate` are ET calendar
 *  dates ("YYYY-MM-DD"); hours/minutes are ET clock parts. Bucket the grid by
 *  `startDate` directly — no UTC math needed on the client. */
export interface ShiftView {
  id: string;
  userId: string;
  userName: string;
  title: string;
  /** metadata.color from Beekeeper (hex string), or undefined. */
  color?: string;
  startUtc: string;
  endUtc: string;
  startDate: string;
  startHour: number;
  startMinute: number;
  endDate: string;
  endHour: number;
  endMinute: number;
}

export type ScheduleResult<T> =
  | { kind: "ok"; data: T }
  | { kind: "denied" } // 401 or 403
  | { kind: "error"; status: number; message: string };

/* ============================================================
 * Dual-mode GET
 * ============================================================ */

async function workerUrl(path: string): Promise<string> {
  const trimmed = path.startsWith("/") ? path : `/${path}`;
  const base = process.env.NEXT_PUBLIC_BEEKEEPER_WORKER_URL;
  if (base) return `${base}${trimmed}`;
  const headerStore = await headers();
  const host = headerStore.get("host") ?? "localhost:3000";
  const proto = headerStore.get("x-forwarded-proto") ?? "https";
  return `${proto}://${host}${trimmed}`;
}

async function beekeeperGetResponse(path: string): Promise<Response> {
  const cookieStore = await cookies();
  const cookieHeader = cookieStore.toString();

  try {
    const { env } = await getCloudflareContext({ async: true });
    if (env.BEEKEEPER_WORKER) {
      const trimmed = path.startsWith("/") ? path : `/${path}`;
      const req = new Request(`https://internal${trimmed}`, {
        method: "GET",
        headers: { Cookie: cookieHeader }
      });
      return env.BEEKEEPER_WORKER.fetch(req);
    }
  } catch {
    // Fall through to URL-based fetch (next dev / non-Workers runtime).
  }

  const url = await workerUrl(path);
  return fetch(url, {
    method: "GET",
    headers: { Cookie: cookieHeader },
    cache: "no-store"
  });
}

async function beekeeperGet<T>(path: string): Promise<ScheduleResult<T>> {
  const resp = await beekeeperGetResponse(path);
  if (resp.status === 401 || resp.status === 403) return { kind: "denied" };
  if (!resp.ok) {
    let message = `Worker GET ${path} failed: ${resp.status}`;
    try {
      const body = (await resp.json()) as { error?: unknown };
      if (typeof body?.error === "string" && body.error) message = body.error;
    } catch {
      // ignore non-JSON error bodies
    }
    return { kind: "error", status: resp.status, message };
  }
  const data = (await resp.json()) as T;
  return { kind: "ok", data };
}

/* ============================================================
 * Typed endpoint helpers
 * ============================================================ */

export function fetchScheduleLocations(): Promise<
  ScheduleResult<{ locations: ScheduleLocation[] }>
> {
  return beekeeperGet<{ locations: ScheduleLocation[] }>(
    "/schedule/api/locations"
  );
}

export function fetchScheduleContext(
  locationCode: string
): Promise<ScheduleResult<ScheduleContext>> {
  return beekeeperGet<ScheduleContext>(
    `/schedule/api/loc/${encodeURIComponent(locationCode)}/context`
  );
}

export function fetchScheduleShifts(
  locationCode: string,
  startIso: string,
  endIso: string
): Promise<ScheduleResult<{ shifts: ShiftView[] }>> {
  const qs = `start=${encodeURIComponent(startIso)}&end=${encodeURIComponent(endIso)}`;
  return beekeeperGet<{ shifts: ShiftView[] }>(
    `/schedule/api/loc/${encodeURIComponent(locationCode)}/shifts?${qs}`
  );
}

/* ============================================================
 * Week-model helpers (pure calendar-string math, DST-proof).
 *
 * Shifts already carry ET `startDate`, so the grid buckets by that string and
 * never touches UTC. These helpers only decide WHICH Monday-anchored week is
 * shown and build a generously-padded UTC query window (the worker also clamps
 * defensively, and the client re-filters by ET startDate).
 * ============================================================ */

/** Add N calendar days to a "YYYY-MM-DD" string via a UTC-noon anchor. */
export function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d!, 12));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/** Monday (YYYY-MM-DD) of the ISO week containing `dateStr`. */
export function mondayOf(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dow = new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay(); // 0=Sun..6=Sat
  const sinceMonday = (dow + 6) % 7;
  return addDays(dateStr, -sinceMonday);
}

/** The seven Mon–Sun date strings for a Monday-anchored week. */
export function weekDates(monday: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}

/** Today's ET calendar date "YYYY-MM-DD". */
export function etToday(): string {
  // en-CA renders ISO YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York"
  }).format(new Date());
}

/** UTC [start,end) ISO window that safely covers the ET week (±1 day pad so
 *  DST + late-night ET shifts are never clipped; the client re-buckets by
 *  startDate). */
export function weekQueryWindow(monday: string): { startIso: string; endIso: string } {
  const startIso = `${addDays(monday, -1)}T00:00:00Z`;
  const endIso = `${addDays(monday, 8)}T00:00:00Z`;
  return { startIso, endIso };
}
