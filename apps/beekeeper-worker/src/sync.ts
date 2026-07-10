// Beekeeper user + schedule cache sync.
//
// Runs daily from the `scheduled` handler and on-demand via
// POST /api/sync-users. Paginates the tenant-wide /users endpoint and pulls
// the full schedule list, upserting both into Supabase. Mirrors the
// workorders-worker MaintainX sync posture (Brief 71): the read paths join the
// cache; a fresh cache is a nicety, never a hard dependency.

import { listAllUsers, listSchedules } from "./beekeeper.js";
import {
  sbClient,
  upsertBeekeeperSchedules,
  upsertBeekeeperUsers
} from "./db.js";
import type { Env } from "./env.js";

export interface SyncResult {
  ok: boolean;
  users: number;
  schedules: number;
  startedAt: string;
  finishedAt: string;
  error?: string;
}

/** Full refill of both cache tables. Never throws — returns ok:false + error
 *  so the scheduled handler stays fail-soft and the manual endpoint can surface
 *  the message. */
export async function runBeekeeperSync(env: Env): Promise<SyncResult> {
  const startedAt = new Date().toISOString();
  const sb = sbClient(env);
  try {
    const [users, schedules] = await Promise.all([
      listAllUsers(env),
      listSchedules(env)
    ]);
    const [userCount, scheduleCount] = await Promise.all([
      upsertBeekeeperUsers(sb, users),
      upsertBeekeeperSchedules(sb, schedules)
    ]);
    return {
      ok: true,
      users: userCount,
      schedules: scheduleCount,
      startedAt,
      finishedAt: new Date().toISOString()
    };
  } catch (err) {
    return {
      ok: false,
      users: 0,
      schedules: 0,
      startedAt,
      finishedAt: new Date().toISOString(),
      error: err instanceof Error ? err.message : "sync failed"
    };
  }
}
