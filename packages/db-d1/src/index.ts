// Public surface of @splash/db-d1.
//
// All helpers take a D1Database (env.DB) as their first argument. The
// damage-worker is the only consumer today; the package exists separately
// so cross-worker D1 use (planned future work) doesn't require a refactor.
//
// Brief 33: the D1 `locations` table was retired. Slug-to-location_pretty
// resolution lives in `@splash/db-supabase` (`getActiveLocationByCode`),
// querying pricing_simple as the single source of truth for valid customer
// URLs. D1 now scopes to claim-related tables only (claims, claim_photos,
// claim_activity_log).

export * from "./claims.js";
export * from "./photos.js";
export * from "./activity.js";
