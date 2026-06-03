// Shared types for the Splash MaxPass monorepo.
// Each domain has its own file — re-exported here for convenience.
//
// Subpath imports preferred at call sites (e.g. `@splash/types/pricing`)
// to keep tree-shaking surgical.

export * from "./pricing.js";
export * from "./signups.js";
export * from "./claims.js";
export * from "./auth.js";
export * from "./locations.js";
export * from "./performance.js";
export * from "./session.js";
export * from "./email-validate.js";
