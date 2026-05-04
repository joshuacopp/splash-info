// Worker bindings + env var typing for signup-worker.
//
// SIGNATURE_MODE is the flippable switch between inline rendering (default,
// production path) and JotForm redirection (dormant; preserved as a
// known-good escape hatch for the legally-binding-signature scenario).
// See apps/signup-worker/src/signature/{inline,jotform}.ts.

import type { SupabaseEnv } from "@splash/db-supabase";

/** Signature collection mode. Driven by env var SIGNATURE_MODE. */
export type SignatureMode = "inline" | "jotform";

export interface Env extends SupabaseEnv {
  /**
   * Signature collection mode.
   *   "inline"  — worker renders the signup form HTML and POSTs straight
   *               to maxpass_signups (production default; what production
   *               does today).
   *   "jotform" — worker 302-redirects to a JotForm with prefilled fields;
   *               JotForm captures the signature and POSTs back. Dormant.
   *
   * Wrangler vars are always strings, so we coerce + default in
   * `resolveSignatureMode()` rather than typing the raw env field as
   * SignatureMode (which would be a lie at runtime).
   */
  SIGNATURE_MODE?: string;
}

const VALID_MODES: ReadonlySet<SignatureMode> = new Set(["inline", "jotform"]);

/**
 * Resolve env.SIGNATURE_MODE to a typed mode. Defaults to "inline" when
 * the var is absent or unrecognized — matches production behavior.
 */
export function resolveSignatureMode(env: Env): SignatureMode {
  const raw = (env.SIGNATURE_MODE ?? "").toLowerCase();
  return VALID_MODES.has(raw as SignatureMode) ? (raw as SignatureMode) : "inline";
}
