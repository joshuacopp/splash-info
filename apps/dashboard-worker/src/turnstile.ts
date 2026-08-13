// Cloudflare Turnstile siteverify wrapper for the login endpoint.
//
// Mirrors forms-worker/src/submit/turnstile.ts (Brief 91) so the two
// surfaces behave identically: POST to siteverify with the secret + the
// client-supplied token, honor an 8-second AbortSignal so a Turnstile
// outage can't wedge the login thread.
//
// FAIL-SOFT ON UNBOUND SECRET: when TURNSTILE_SECRET_KEY is not bound the
// function returns { ok: true } WITHOUT contacting siteverify. This keeps
// local dev convenient (no Turnstile needed on localhost). Production MUST
// bind the secret — see wrangler.toml. Note the asymmetry: unbound secret
// = skip (dev), but bound secret + MISSING token = fail closed. That's the
// important half for prod: once the secret is set, a login with no token is
// rejected, so an attacker can't strip the widget to bypass the check.

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const SITEVERIFY_TIMEOUT_MS = 8000;

export type TurnstileResult = { ok: true } | { ok: false; reason: string };

interface TurnstileResponse {
  success: boolean;
  "error-codes"?: string[];
}

export async function verifyTurnstile(
  secret: string | undefined,
  token: string | null,
  remoteIp: string | null
): Promise<TurnstileResult> {
  if (!secret) {
    console.warn("[dashboard] Turnstile secret unbound; skipping login verification.");
    return { ok: true };
  }
  if (!token) {
    return { ok: false, reason: "missing_token" };
  }

  const body = new FormData();
  body.append("secret", secret);
  body.append("response", token);
  if (remoteIp) body.append("remoteip", remoteIp);

  let response: Response;
  try {
    response = await fetch(SITEVERIFY_URL, {
      method: "POST",
      body,
      signal: AbortSignal.timeout(SITEVERIFY_TIMEOUT_MS)
    });
  } catch (err) {
    const reason = err instanceof Error ? err.name : "unknown";
    console.error("[dashboard] Turnstile siteverify fetch threw", err);
    return { ok: false, reason: `siteverify_${reason}` };
  }
  if (!response.ok) {
    return { ok: false, reason: `siteverify_${response.status}` };
  }

  let data: TurnstileResponse;
  try {
    data = (await response.json()) as TurnstileResponse;
  } catch {
    return { ok: false, reason: "siteverify_parse" };
  }
  if (data.success) return { ok: true };
  const codes = data["error-codes"] ?? ["unknown"];
  return { ok: false, reason: codes.join(",") };
}
