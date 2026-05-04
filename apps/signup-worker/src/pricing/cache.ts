// Pricing cache layer — Cloudflare Cache API, per-location keys.
//
// =============================================================================
// SHAPE
// =============================================================================
// - Cache key: synthetic Request URL `https://internal-cache.splash/pricing/v{N}/{locationCode}`
//   - The `v{N}` segment is a STATIC version stamp bumped manually when the
//     cache shape changes (e.g., we add a new column to the cached payload).
//   - It is NOT bumped on price updates — those use explicit invalidation
//     via invalidatePricingCache() instead. The user-stated requirement
//     that the key change on admin updates is satisfied by deleting the old
//     key (next reader creates a fresh one).
// - Fresh window: 5 minutes — within this window, cached value is returned
//   immediately, no DB hit.
// - SWR window: 5 minutes to 24 hours — cached value returned, background
//   refresh kicked off via `waitUntil` when available.
// - Beyond 24 hours: treated as miss; synchronous DB fetch.
//
// Subrequest budget per request:
//   - cache hit (fresh):      0 DB calls
//   - cache hit (stale-SWR):  0 DB calls on the critical path; 1 in waitUntil
//   - cache miss:             1 DB call + 1 cache.put
//
// Mitigates "too many subrequests" by capturing all packages for a location
// in one DB round-trip (fetchPricingResolvedByLocation).
//
// =============================================================================
// INVALIDATION CONTRACT
// =============================================================================
// Admin pricing writes (Chunk 4) MUST call invalidatePricingCache(locationCode)
// after a successful update. Without that call, customers see stale prices
// for up to 5 minutes (fresh window) or up to 24 hours (worst-case SWR).
// Multi-location admin updates must call once per affected location.

import { fetchPricingResolvedByLocation } from "@splash/db-supabase";
import type { SupabaseClient } from "@splash/db-supabase";
import type { PricingSimpleResolvedRow } from "@splash/types/pricing";

/** Bump only when the cached payload shape changes. */
const CACHE_VERSION = 1;
const FRESH_TTL_SECONDS = 5 * 60; // 5 min
const STALE_TTL_SECONDS = 24 * 60 * 60; // 24 h

interface CachedPricingPayload {
  rows: PricingSimpleResolvedRow[];
  cachedAt: string;
}

/**
 * `caches.default` is a Cloudflare-specific extension to the standard
 * CacheStorage. The DOM lib's `CacheStorage` type doesn't know about it
 * and the `@cloudflare/workers-types` augmentation isn't reliably picked
 * up across all consumer tsconfigs. Wrapping the access here keeps the
 * cast in one place.
 */
function getDefaultCache(): Cache {
  return (caches as unknown as { default: Cache }).default;
}

function cacheKeyForLocation(locationCode: string): Request {
  // Synthetic URL — never reached over the network. Cache API uses the
  // request URL as the key. encodeURIComponent guards against odd location
  // codes; toLowerCase keeps cache lookups consistent with the DB filter.
  const code = encodeURIComponent(locationCode.toLowerCase());
  return new Request(`https://internal-cache.splash/pricing/v${CACHE_VERSION}/${code}`);
}

export interface PricingFetchOptions {
  client: SupabaseClient;
  locationCode: string;
  /**
   * ExecutionContext.waitUntil — used for stale-while-revalidate background
   * refresh. Optional: when absent, a stale value is still returned but no
   * background refresh runs (next request will refresh synchronously if
   * still stale by then).
   */
  waitUntil?: (promise: Promise<unknown>) => void;
}

/**
 * Get the resolved pricing rows for a location, with caching.
 *
 * On cache hit (fresh): returns cached rows immediately.
 * On cache hit (stale, within SWR): returns cached rows + schedules background
 *   refresh via waitUntil.
 * On miss / expired: synchronous DB fetch + cache populate.
 */
export async function getCachedPricingForLocation(
  opts: PricingFetchOptions
): Promise<PricingSimpleResolvedRow[]> {
  const cache = getDefaultCache();
  const key = cacheKeyForLocation(opts.locationCode);

  const cached = await cache.match(key);
  if (cached) {
    const ageSec = computeAgeSeconds(cached);

    if (ageSec < FRESH_TTL_SECONDS) {
      return readPayload(cached);
    }
    if (ageSec < STALE_TTL_SECONDS) {
      // Stale-but-usable: return cached, refresh in background.
      if (opts.waitUntil) {
        opts.waitUntil(refreshCache(opts.client, opts.locationCode, cache, key));
      }
      return readPayload(cached);
    }
    // Beyond SWR — fall through to fresh fetch.
  }

  return fetchAndCache(opts.client, opts.locationCode, cache, key);
}

/**
 * Cache invalidation hook — admin pricing writes call this after a
 * successful UPDATE to pricing_simple. Per-location key scheme means
 * multi-location updates (e.g., super_admin "set all sites to flash5")
 * must call this once per location.
 *
 * Returns true if a row was deleted, false if no row was cached.
 */
export async function invalidatePricingCache(locationCode: string): Promise<boolean> {
  const cache = getDefaultCache();
  const key = cacheKeyForLocation(locationCode);
  return cache.delete(key);
}

/* ============================================================
 * Internals
 * ============================================================ */

async function fetchAndCache(
  client: SupabaseClient,
  locationCode: string,
  cache: Cache,
  key: Request
): Promise<PricingSimpleResolvedRow[]> {
  const rows = await fetchPricingResolvedByLocation(client, locationCode);
  const payload: CachedPricingPayload = {
    rows,
    cachedAt: new Date().toISOString()
  };
  const response = new Response(JSON.stringify(payload), {
    headers: {
      "Content-Type": "application/json",
      // Date header drives age calculation — must be explicit so worker
      // restarts / cache moves between colos don't confuse SWR logic.
      "Date": new Date().toUTCString(),
      // Cloudflare Cache API respects this for its own LRU eviction; ours
      // is a soft hint at the SWR upper bound.
      "Cache-Control": `max-age=${STALE_TTL_SECONDS}`
    }
  });
  // Clone before put — Response body can only be consumed once.
  await cache.put(key, response.clone());
  return rows;
}

async function refreshCache(
  client: SupabaseClient,
  locationCode: string,
  cache: Cache,
  key: Request
): Promise<void> {
  try {
    await fetchAndCache(client, locationCode, cache, key);
  } catch (err) {
    // Background refresh failures are non-fatal — the next reader will
    // see the still-stale entry and try again. Logging only.
    console.error("Pricing SWR refresh failed:", err);
  }
}

async function readPayload(response: Response): Promise<PricingSimpleResolvedRow[]> {
  const payload = (await response.json()) as CachedPricingPayload;
  return payload.rows;
}

function computeAgeSeconds(response: Response): number {
  const dateHeader = response.headers.get("Date");
  if (!dateHeader) return Number.POSITIVE_INFINITY;
  const cachedTime = new Date(dateHeader).getTime();
  if (!Number.isFinite(cachedTime)) return Number.POSITIVE_INFINITY;
  return (Date.now() - cachedTime) / 1000;
}
