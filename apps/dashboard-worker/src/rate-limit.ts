// Login rate limiter — coarse fixed-window counters in Workers KV.
//
// PURPOSE: defense-in-depth behind Turnstile. Turnstile stops the cheap
// scripted floods; this caps how many password guesses a single IP or a
// single targeted account can rack up even if a solver gets past the widget.
//
// STORAGE: Workers KV. KV is eventually consistent, so under a burst an
// attacker might squeeze a few extra attempts past the limit before the
// counter converges across colos. That's acceptable — this is a throttle,
// not a hard lock, and it sits on top of Turnstile. If we ever need exact
// counting, swap this module for a Durable Object (same call sites).
//
// POLICY (tune via the consts below):
//   - Per IP:    20 attempts / 15 min   (shared office NAT tolerance)
//   - Per email:  8 attempts / 15 min   (targeted-account protection)
// On success we clear the per-email bucket so a legitimate user who fat-
// fingered their password a few times isn't locked out afterward. The
// per-IP bucket is left to age out on its own.
//
// FAIL-OPEN: if KV is unbound (local dev) or throws, we allow the attempt.
// Turnstile is still in front, and a KV outage shouldn't take down login.

const WINDOW_MS = 15 * 60 * 1000;
const IP_LIMIT = 20;
const EMAIL_LIMIT = 8;

interface Bucket {
  count: number;
  resetAt: number; // epoch ms
}

export interface RateLimitEnv {
  LOGIN_RATE_LIMIT?: KVNamespace;
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSec: number; // 0 when allowed
}

/**
 * Record one login attempt for both the IP and the email, and report
 * whether either bucket is now over its limit. Call this BEFORE the
 * password grant so failed guesses count.
 */
export async function recordAndCheck(
  env: RateLimitEnv,
  ip: string | null,
  email: string
): Promise<RateLimitResult> {
  const kv = env.LOGIN_RATE_LIMIT;
  if (!kv) return { allowed: true, retryAfterSec: 0 }; // fail-open (dev)

  const now = Date.now();
  const keys: Array<{ key: string; limit: number }> = [
    { key: `login_rl:email:${email.toLowerCase()}`, limit: EMAIL_LIMIT }
  ];
  if (ip) keys.push({ key: `login_rl:ip:${ip}`, limit: IP_LIMIT });

  let blocked = false;
  let retryAfterSec = 0;

  for (const { key, limit } of keys) {
    try {
      const bucket = await readBucket(kv, key, now);
      bucket.count += 1;
      const ttlSec = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      await kv.put(key, JSON.stringify(bucket), { expirationTtl: ttlSec });
      if (bucket.count > limit) {
        blocked = true;
        retryAfterSec = Math.max(retryAfterSec, ttlSec);
      }
    } catch (err) {
      // KV hiccup — fail open for this key, keep checking the other.
      console.error("[dashboard] rate-limit KV error", key, err);
    }
  }

  return { allowed: !blocked, retryAfterSec };
}

/** Clear the per-email bucket after a successful login. Best-effort. */
export async function clearEmail(env: RateLimitEnv, email: string): Promise<void> {
  const kv = env.LOGIN_RATE_LIMIT;
  if (!kv) return;
  try {
    await kv.delete(`login_rl:email:${email.toLowerCase()}`);
  } catch (err) {
    console.error("[dashboard] rate-limit clear error", err);
  }
}

async function readBucket(kv: KVNamespace, key: string, now: number): Promise<Bucket> {
  const raw = await kv.get(key);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Bucket;
      if (parsed.resetAt > now) return parsed;
    } catch {
      // fall through to a fresh window
    }
  }
  return { count: 0, resetAt: now + WINDOW_MS };
}
