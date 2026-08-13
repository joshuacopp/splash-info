// Worker bindings + env var typing for beekeeper-worker.
//
// Extends SupabaseEnv (SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_KEY)
// because the worker (a) authenticates operators via @splash/auth
// (anon-key /auth/v1/user round-trip), (b) reads/writes the Beekeeper user +
// schedule cache tables via the service-role client, and (c) audits shift
// mutations to sysadmin_audit_log.
//
// BEEKEEPER_TOKEN is the ONLY Beekeeper-specific secret. It's a Beekeeper
// bot-account API token with Admin (or location-admin) scope. Stored as a
// Wrangler secret — input as:
//
//     wrangler secret put BEEKEEPER_TOKEN

import type { SupabaseEnv } from "@splash/db-supabase";

export interface Env extends SupabaseEnv {
  /** Beekeeper bot-account API token. Secret. Sent as `Authorization: Token <v>`. */
  BEEKEEPER_TOKEN: string;


  BEEKEEPER_BASE_URL?: string;

  /**
   * Comma-separated allowlist of operator emails permitted to fire the
   * manual sync endpoint (POST /api/sync-users) in addition to super_admins.
   * Optional — when unset, only super_admins may trigger a manual sync.
   */
  SYNC_ADMIN_EMAILS?: string;

  /**
   * form_submissions.form_id of the published "employee unavailability" form.
   * Powers the read-only unavailability overlay on the week grid: approved
   * submissions for the location + week are surfaced as non-editable markers so
   * managers see who's unavailable while building the schedule. Optional — when
   * unset the overlay endpoint fails soft (returns an empty list), so the
   * schedule keeps working before the form is wired in any environment.
   */
  UNAVAILABILITY_FORM_ID?: string;
}

export const DEFAULT_BEEKEEPER_BASE_URL =
  "https://splashcarwashes.us.beekeeper.io/api/2";

export function resolveBeekeeperBaseUrl(env: Env): string {
  const raw = (env.BEEKEEPER_BASE_URL ?? "").trim();
  return raw || DEFAULT_BEEKEEPER_BASE_URL;
}
