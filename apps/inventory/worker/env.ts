// Worker bindings + env var typing for splash-inventory.
//
// Extends SupabaseEnv (SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_KEY)
// because the worker (a) authenticates operators via @splash/auth (anon-key
// /auth/v1/user round-trip) and (b) reads/writes the `inventory` Postgres
// schema via the service-role client.
//
// ASSETS is the Cloudflare Static Assets binding declared in wrangler.toml
// ([assets] directory="./dist"); the worker hands non-API requests to it after
// stripping the /inventory prefix.

import type { SupabaseEnv } from "@splash/db-supabase";

export interface Env extends SupabaseEnv {
  /** Cloudflare Static Assets binding — serves the built Vite SPA (./dist). */
  ASSETS: Fetcher;

  /**
   * Optional visit-report webhook. When set, POST /inventory/api/report
   * forwards the report payload here (e.g. a Supabase Edge Function or an
   * email relay). When unset the endpoint fails soft and returns
   * { simulated: true } so the submit flow keeps working before it's wired.
   */
  INVENTORY_REPORT_WEBHOOK_URL?: string;
}
