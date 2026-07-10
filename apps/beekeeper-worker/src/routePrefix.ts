// Shared base path for the beekeeper schedule worker.
//
// The worker is path-carved onto the apex host at splashcarwashes.info/schedule/api/*
// (same pattern as /workorders/api/*) so it shares the host-only sb-access-token
// SSO cookie the dashboard sets — a dedicated subdomain never received that
// cookie, so every request 401'd.
//
// index.ts strips this prefix off incoming pathnames before segment routing.
// The UI now lives in apps/web (app/schedule/*) and calls /schedule/api/* via
// the BEEKEEPER_WORKER service binding + same-origin browser fetches.
export const ROUTE_PREFIX = "/schedule";
