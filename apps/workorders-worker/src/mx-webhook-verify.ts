// MaintainX webhook signature verification.
//
// THIS IS THE ONLY GATE ON THE WEBHOOK ROUTE. Every other route on this worker
// runs through `authenticate()` against Supabase Auth; MaintainX cannot hold a
// session, so the HMAC is all there is. Treat changes here as security
// changes.
//
// The scheme (docs: help.getmaintainx.com/build/webhooks):
//
//   header  x-maintainx-webhook-body-signature
//   value   t=<timestamp>,v1=<hex hmac>
//   message <timestamp>.<raw body>          <- literal dot, raw bytes
//   key     the subscription's signing secret
//   digest  HMAC-SHA256, hex
//
// THE RAW BODY IS LOAD-BEARING. The signature covers the exact bytes MaintainX
// sent. `JSON.parse` then `JSON.stringify` changes key order, whitespace and
// number formatting, and the signature will not match. The caller must read
// `await request.text()` ONCE, verify against that string, and only then parse
// it. There is no way to recover the original bytes from a parsed object.
//
// Lives in the worker rather than packages/maintainx because this worker is
// the only webhook receiver. If a second one ever appears, move it -- the
// module has no worker-specific imports precisely so that stays cheap.

/** Why a delivery was refused. The route logs this and returns a flat 401 --
 *  the caller is never told which check failed, because a probe that learns
 *  "signature mismatch" vs "expired" learns the shape of the gate. */
export type WebhookVerifyFailure =
  | "missing_header"
  | "malformed_header"
  | "bad_timestamp"
  | "expired"
  | "future_skew"
  | "no_secret"
  | "mismatch";

export type WebhookVerifyResult =
  | { ok: true; timestampSeconds: number }
  | { ok: false; reason: WebhookVerifyFailure };

export const MX_SIGNATURE_HEADER = "x-maintainx-webhook-body-signature";

/**
 * Replay window. The docs recommend rejecting timestamps more than five
 * minutes old; the same tolerance is allowed in the FUTURE for clock skew
 * between MaintainX and the Cloudflare edge, since a receiver whose clock is
 * thirty seconds behind would otherwise reject every delivery.
 */
export const MX_TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;

interface ParsedSignatureHeader {
  timestamp: string;
  /** Every v1= value present. MaintainX documents one; a list is accepted so
   *  that a secret rotation which sends old and new side by side (the scheme
   *  Stripe uses, which this header format is modelled on) would not lock us
   *  out. Any ONE valid signature accepts -- each still requires the secret. */
  signatures: string[];
}

/**
 * Split `t=...,v1=...` into its parts.
 *
 * Deliberately strict about structure and lenient about ordering and repeats:
 * unknown keys are ignored so a future `v2=` does not break parsing, but a
 * missing `t` or a total absence of `v1` is malformed.
 */
export function parseSignatureHeader(raw: string | null): ParsedSignatureHeader | null {
  if (!raw) return null;
  let timestamp: string | null = null;
  const signatures: string[] = [];

  for (const part of raw.split(",")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (value === "") continue;
    if (key === "t") {
      // First t wins. A header with two different timestamps is malformed
      // rather than a choice to make.
      if (timestamp !== null) return null;
      timestamp = value;
    } else if (key === "v1") {
      signatures.push(value);
    }
  }

  if (timestamp === null || signatures.length === 0) return null;
  return { timestamp, signatures };
}

/**
 * Seconds since epoch from the header's `t`.
 *
 * MaintainX does not document the unit. Values are treated as seconds, which
 * is the convention for this header shape, with a magnitude check that
 * converts an obviously-millisecond value rather than rejecting it: a
 * millisecond timestamp read as seconds lands ~50,000 years in the future and
 * would fail the window every single time, which is a silent total outage
 * rather than a visible bug. Verified against a live delivery before this is
 * relied upon.
 */
function toEpochSeconds(raw: string): number | null {
  if (!/^\d{1,19}$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  // 1e12 seconds is the year 33658; 1e12 ms is 2001. Anything at or above is
  // milliseconds.
  return n >= 1e12 ? Math.floor(n / 1000) : Math.floor(n);
}

/** Length-checked, data-independent comparison. Returns after a fixed number
 *  of operations for equal-length inputs so a mismatched byte's POSITION is
 *  not observable in the response time. The length itself is not secret --
 *  a SHA-256 hex digest is always 64 characters. */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let out = "";
  for (let i = 0; i < bytes.length; i += 1) {
    out += bytes[i]!.toString(16).padStart(2, "0");
  }
  return out;
}

/** HMAC-SHA256 of `message` under `secret`, hex encoded. Exported for the test
 *  vector -- the test signs with the same primitive it verifies, so a broken
 *  encoding would cancel out; the known-good vector in the test file is the
 *  guard against that. */
export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return toHex(signature);
}

export interface VerifyWebhookInput {
  /** Raw header value, or null when absent. */
  signatureHeader: string | null;
  /** The body EXACTLY as received -- `await request.text()`, never a
   *  re-serialised object. */
  rawBody: string;
  /** The subscription signing secret. */
  secret: string | undefined;
  /** Injectable for tests. Seconds since epoch. */
  nowSeconds?: number;
  toleranceSeconds?: number;
}

/**
 * Verify a MaintainX webhook delivery.
 *
 * Order matters: cheap structural checks first, then the timestamp window,
 * then the HMAC. Doing the window before the HMAC means a flood of replayed
 * bodies costs a string compare rather than a crypto operation.
 */
export async function verifyMaintainXWebhook(
  input: VerifyWebhookInput
): Promise<WebhookVerifyResult> {
  if (!input.secret) return { ok: false, reason: "no_secret" };
  if (input.signatureHeader === null || input.signatureHeader === "") {
    return { ok: false, reason: "missing_header" };
  }

  const parsed = parseSignatureHeader(input.signatureHeader);
  if (!parsed) return { ok: false, reason: "malformed_header" };

  const timestampSeconds = toEpochSeconds(parsed.timestamp);
  if (timestampSeconds === null) return { ok: false, reason: "bad_timestamp" };

  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tolerance = input.toleranceSeconds ?? MX_TIMESTAMP_TOLERANCE_SECONDS;
  const age = now - timestampSeconds;
  if (age > tolerance) return { ok: false, reason: "expired" };
  if (age < -tolerance) return { ok: false, reason: "future_skew" };

  // The signed message is the timestamp AS SENT, not the normalised seconds --
  // MaintainX signed the literal string, so re-deriving it from a converted
  // number would not reproduce the digest.
  const expected = await hmacSha256Hex(
    input.secret,
    `${parsed.timestamp}.${input.rawBody}`
  );

  // Hex case is not secret-dependent, so normalising is not a timing leak.
  const expectedLower = expected.toLowerCase();
  for (const candidate of parsed.signatures) {
    if (timingSafeEqualHex(candidate.toLowerCase(), expectedLower)) {
      return { ok: true, timestampSeconds };
    }
  }
  return { ok: false, reason: "mismatch" };
}
