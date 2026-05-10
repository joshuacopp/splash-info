// Cloudflare Turnstile siteverify wrapper. Mirrors the fleet-inquiry-worker
// pattern (Brief 81 — `verifyTurnstile` in `apps/fleet-inquiry-worker/src/
// index.js`): POST to siteverify with the secret + the form-supplied token,
// honor an 8-second AbortSignal so a Turnstile outage doesn't block the
// submit thread indefinitely.
//
// FAIL-SOFT POSTURE: when the secret is unbound the function returns
// `{ ok: true }` without contacting siteverify. Matches CLAUDE.md's
// posture for fleet — keeps local-dev convenient. Production deploys MUST
// bind `TURNSTILE_SECRET_KEY` for public-audience forms (PRE_DEPLOY_FORMS.md
// Section 2 surfaces this as a pre-deploy operator step).

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
    console.warn("[forms] Turnstile secret unbound; skipping verification.");
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
    console.error("[forms] Turnstile siteverify fetch threw", err);
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
