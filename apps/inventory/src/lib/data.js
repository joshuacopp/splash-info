// ---------------------------------------------------------------------------
// Data access layer.
//
// This used to talk to Supabase directly (or a demo overlay). It now calls the
// inventory worker API (/inventory/api/*), which authenticates the SSO session,
// scopes every response to the user's granted locations, and translates the
// DB's location_code column <-> the SPA's location_id field. The exported
// function signatures and return shapes are unchanged, so calc.js and every
// page keep working without edits.
// ---------------------------------------------------------------------------
import { apiGet, apiPost, apiPut, apiDelete } from './api'

// Returns a fresh dataset object: { locations, products, ... } (13 keys).
export async function loadData() {
  return apiGet('/data')
}

// ---------------------------------------------------------------------------
// Site visits
// ---------------------------------------------------------------------------
// payload: { location_id, visit_date, submitter, notes, entries[], washCounts[] }
export async function createVisit(payload) {
  return apiPost('/visits', payload) // -> { visitId }
}

// Admin-only (worker enforces super_admin). Replaces the visit's own fields
// plus its full set of entries/wash_counts.
export async function updateVisit(visitId, payload) {
  return apiPut(`/visits/${encodeURIComponent(visitId)}`, payload) // -> { visitId }
}

// Admin-only.
export async function deleteVisit(visitId) {
  await apiDelete(`/visits/${encodeURIComponent(visitId)}`)
}

// ---------------------------------------------------------------------------
// Products admin (super_admin)
// ---------------------------------------------------------------------------
export async function upsertProduct(product) {
  return apiPost('/products', product) // -> row
}

// ---------------------------------------------------------------------------
// Package configuration (per location)
// payload: {
//   packages: [{id?, name, isNew?, deleted?, packageType}],
//   locationProducts: [{id?, product_id, target_ml_per_car, discount, deleted?}],
//   matrix: { [packageIdOrTempId]: { [productId]: uses } }
// }
// ---------------------------------------------------------------------------
export async function savePackageConfig(locationId, payload) {
  return apiPost('/package-config', { locationId, payload }) // -> { packages, products }
}

// ---------------------------------------------------------------------------
// Email recipients (super_admin)
// list items: { id?, email, name, active, deleted, allLocations, locationIds:[] }
// ---------------------------------------------------------------------------
export async function saveRecipients(list) {
  return apiPost('/recipients', list) // -> normalized list
}

// ---------------------------------------------------------------------------
// Visit report email.
//
// The worker resolves the recipient list, renders the body and writes one row
// per recipient onto the shared `outbound_emails` queue (Power Automate
// delivers). Send only the visit's facts — recipients, the link origin and the
// dedup key are all decided server-side.
//
// Returns { queued, duplicates, recipients[] }. `duplicates` is non-zero when
// this visit was already queued for that address, which is how a double-tapped
// Submit is absorbed instead of mailing everybody twice.
// ---------------------------------------------------------------------------
export async function sendVisitReport(payload) {
  return apiPost('/report', payload)
}

// ---------------------------------------------------------------------------
// Flag resolutions (Attention page)
// ---------------------------------------------------------------------------
export async function resolveFlag(flagKey, resolvedBy, locationId, note) {
  return apiPost('/flags/resolve', { flagKey, resolvedBy, locationId, note }) // -> row
}

export async function unresolveFlag(flagKey) {
  await apiPost('/flags/unresolve', { flagKey })
}

// ---------------------------------------------------------------------------
// Obsolete admin surface — user, location and demo management now live in the
// splash sysadmin/master tools, not this app. The Users & Regions admin tabs
// that called these were removed from AdminProducts. Kept as throwing stubs so
// any stray import fails loudly at call time rather than at build time.
// ---------------------------------------------------------------------------
const removed = (what) => () => {
  throw new Error(`${what} is managed in the Splash admin tools, not the inventory app.`)
}
export const inviteUser = removed('User invites')
export const saveUserProfile = removed('User roles')
export const removeUser = removed('User removal')
export const saveLocation = removed('Location editing')
export const deleteLocation = removed('Location deletion')
export const renameAcrossLocations = removed('Region/manager renaming')
export function resetDemoData() {
  /* no-op: demo mode is gone */
}
