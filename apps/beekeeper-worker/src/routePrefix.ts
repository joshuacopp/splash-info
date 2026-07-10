// Shared base path for the beekeeper schedule worker.
//
// The worker is path-carved onto the apex host at splashcarwashes.info/schedule/*
// (same pattern as /pertrack, /manage, /workorders) so it shares the host-only
// sb-access-token SSO cookie the dashboard sets — a dedicated subdomain never
// received that cookie, so every request 401'd.
//
// index.ts strips this prefix off incoming pathnames before segment routing;
// ui.ts prefixes every internal link + fetch with it. Kept in one place so the
// two never drift.
export const ROUTE_PREFIX = "/schedule";
