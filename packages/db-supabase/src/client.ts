// Supabase client factories. Use service-key client for everything that
// bypasses RLS (admin reads, writes); use anon-key client only for
// /auth/v1/token + /auth/v1/user calls (those live in @splash/auth).

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export interface SupabaseEnv {
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  SUPABASE_SERVICE_KEY: string;
}

const SHARED_OPTIONS = {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false
  }
} as const;

/**
 * Service-role client. Bypasses RLS — use ONLY in worker code, never expose
 * to a browser. Matches the legacy fetch pattern with apikey + Authorization
 * headers set to SUPABASE_SERVICE_KEY.
 */
export function createServiceClient(env: SupabaseEnv): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, SHARED_OPTIONS);
}

/**
 * Anon-key client. Optionally attaches an access token (from the
 * sb-access-token cookie) so RLS evaluates as that user.
 */
export function createAnonClient(env: SupabaseEnv, accessToken?: string): SupabaseClient {
  const options = accessToken
    ? {
        ...SHARED_OPTIONS,
        global: { headers: { Authorization: `Bearer ${accessToken}` } }
      }
    : SHARED_OPTIONS;
  return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, options);
}

export type { SupabaseClient };
