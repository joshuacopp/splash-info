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
}

// No email binding is declared here on purpose. POST /inventory/api/report
// enqueues onto the shared `outbound_emails` table via SUPABASE_SERVICE_KEY
// (already inherited from SupabaseEnv) and Power Automate drains the queue —
// the same path forms-worker and promo-worker use. There is no provider key,
// no webhook URL, and nothing extra to set before the first send works.
//
// This replaced an INVENTORY_REPORT_WEBHOOK_URL var that was never populated,
// which is why the report step returned { simulated: true } in production.
