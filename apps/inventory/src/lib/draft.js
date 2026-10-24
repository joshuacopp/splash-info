// Device copy of a visit or delivery draft.
//
// Mirrors the damage claim form (apps/damage-worker/src/render/claim-form.ts,
// ~line 1134): debounced save to localStorage, a "resume or discard" banner on
// return, and a hard clear on successful submit. A site visit is a long form
// filled in on a phone in a wash bay — a dropped connection, a phone call, or
// a backgrounded tab should not cost twenty minutes of counting.
//
// Since 2026-10-23 the draft of record is SHARED, one per site per kind, in
// inventory.drafts (see useSharedDraft.js). This module is the device copy
// kept alongside it, so going offline mid-count still loses nothing; the hook
// offers whichever copy is newer.
//
// Drafts are NEVER auto-applied. Restoring silently would overwrite the values
// the form seeds from the previous visit (starting quantities, carried-forward
// equipment) with numbers the user cannot see the provenance of. The banner
// makes it a choice.

// 30 days, matching the claim form's DRAFT_TTL_MS.
const TTL_MS = 30 * 24 * 60 * 60 * 1000
export const SAVE_DEBOUNCE_MS = 500
// Bumping this discards every existing draft rather than restoring a shape the
// current form no longer understands. Change it whenever the saved value set
// changes meaning — adding a field is safe (missing keys fall back to the
// seed), repurposing one is not.
const VERSION = 1

// Keyed by kind, user AND location. localStorage is per-browser, not
// per-account, so on a shared site tablet an unkeyed copy would be offered to
// whoever signs in next. The visit key is unchanged from before kinds existed,
// so device drafts saved by the old form are still found.
export function draftKey(email, locationId, kind = 'visit') {
  if (!locationId) return ''
  return `inventory.${kind}.draft.${email || 'anon'}.${locationId}`
}

export function loadDraft(key) {
  if (!key) return null
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    if (parsed.v !== VERSION) return null
    if (typeof parsed.savedAt !== 'number') return null
    if (!parsed.values || typeof parsed.values !== 'object') return null
    const age = Date.now() - parsed.savedAt
    // A negative age means the clock moved backwards (or the draft was written
    // by a device set to the future); treat it as unusable rather than showing
    // "saved in -3 days".
    if (age < 0 || age > TTL_MS) {
      clearDraft(key)
      return null
    }
    return { values: parsed.values, savedAt: parsed.savedAt, age }
  } catch {
    // Malformed JSON, or localStorage unavailable (Safari private browsing
    // throws on access). Either way there is no draft to offer.
    return null
  }
}

export function saveDraft(key, values) {
  if (!key) return
  try {
    window.localStorage.setItem(key, JSON.stringify({ v: VERSION, savedAt: Date.now(), values }))
  } catch {
    // Quota exceeded or storage disabled. Saving a draft is a convenience, so
    // failing silently is correct — the form itself still works.
  }
}

export function clearDraft(key) {
  if (!key) return
  try {
    window.localStorage.removeItem(key)
  } catch {
    /* nothing to do */
  }
}

export function formatAge(ms) {
  const min = Math.round(ms / 60000)
  if (min < 1) return 'moments ago'
  if (min < 60) return min === 1 ? '1 min ago' : `${min} min ago`
  const hr = Math.round(min / 60)
  if (hr < 24) return hr === 1 ? '1 hr ago' : `${hr} hr ago`
  const d = Math.round(hr / 24)
  return d === 1 ? '1 day ago' : `${d} days ago`
}
