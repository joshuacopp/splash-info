// Public surface of @splash/db-supabase.
//
// Caller pattern in workers:
//
//     import { createServiceClient } from "@splash/db-supabase";
//     import { fetchPricingResolved } from "@splash/db-supabase";
//     ...
//     const sb = createServiceClient(env);
//     const view = await fetchPricingResolved(sb);

export { createServiceClient, createAnonClient, type SupabaseEnv, type SupabaseClient } from "./client.js";

// Domain helpers — re-export everything; tree-shaking is handled by the bundler.
export * from "./auth-context.js";
export * from "./pricing.js";
export * from "./users.js";
export * from "./signups.js";
export * from "./phones.js";
export * from "./locations.js";
export * from "./performance.js";
export * from "./audit.js";
