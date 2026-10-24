// Shared draft for the visit and delivery forms — one per site per kind.
//
// The draft of record lives in inventory.drafts (worker: /api/drafts/{site}/{kind}),
// so a count started on the site tablet can be finished on a phone, or by
// someone else. Every save also goes to this device (lib/draft.js), so a dead
// connection in a wash bay still loses nothing.
//
// Rules, agreed with the field team:
//   - last save wins;
//   - if someone ELSE saved after you opened the form, your save still lands,
//     and you are told whose work you replaced, with a button to put it back;
//   - the submitter is not part of a draft — whoever presses Submit is recorded;
//   - submitting deletes the draft (the worker does it once the record is
//     saved), and anyone still holding it is told and stops saving.
//
// Drafts are offered, never applied by themselves (see lib/draft.js for why),
// and nothing is saved while that offer is unanswered: saving then would
// overwrite somebody's draft before you had decided whether to resume it.
//
// The form owns its fields. It passes the current `values` (without the
// submitter), whether they differ from the pristine seed (`dirty`), and an
// `apply(values)` that merges a saved set into its state.

import { useEffect, useRef, useState } from 'react'
import { apiDelete, apiGet, apiPut } from './api'
import { clearDraft, draftKey, loadDraft, saveDraft, SAVE_DEBOUNCE_MS } from './draft'

// Server saves are spaced wider than device saves: every keystroke on a
// counted grid would otherwise be a request, and two people typing at once
// would trade "replaced" warnings on every digit.
const SERVER_DEBOUNCE_MS = 1500

export function useSharedDraft({ locationId, kind, email, enabled, values, dirty, apply }) {
  const localKey = enabled ? draftKey(email, locationId, kind) : ''
  const path = `/drafts/${encodeURIComponent(locationId)}/${kind}`
  const serialized = JSON.stringify(values)

  // { source: 'server' | 'device', values, by, at (ms), version }
  const [offer, setOffer] = useState(null)
  const [loaded, setLoaded] = useState(!enabled)
  // 'idle' | 'saving' | 'saved' | 'device' (server unreachable) | 'gone'
  const [status, setStatus] = useState('idle')
  // The draft someone else had saved, which our last save replaced.
  const [replaced, setReplaced] = useState(null)
  // Version this client last loaded or saved; null = started blank.
  const base = useRef(null)
  const serverDraft = useRef(null)
  // Bumped to force a save without a field changing (startNew).
  const [nonce, setNonce] = useState(0)

  // ---- load: offer the newer of the shared copy and this device's copy ----
  useEffect(() => {
    if (!enabled) return undefined
    let cancelled = false
    const local = loadDraft(localKey)
    apiGet(path)
      .then((res) => {
        if (cancelled) return
        const d = res?.draft || null
        serverDraft.current = d
        const serverAt = d ? Date.parse(d.updated_at) : 0
        if (local && (!d || local.savedAt > serverAt + 1000)) {
          // Saved here while offline, after the shared copy (or with none).
          setOffer({ source: 'device', values: local.values, by: email, at: local.savedAt, version: null })
        } else if (d) {
          setOffer({ source: 'server', values: d.values, by: d.updated_by, at: serverAt, version: d.version })
        }
        setLoaded(true)
      })
      .catch(() => {
        if (cancelled) return
        // Offline or the table isn't there yet: device copy only.
        if (local) setOffer({ source: 'device', values: local.values, by: email, at: local.savedAt, version: null })
        setStatus('device')
        setLoaded(true)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, localKey, path])

  // ---- save: device fast, server debounced ----
  useEffect(() => {
    if (!enabled || !loaded || offer) return undefined
    if (!dirty) {
      // Untouched form: nothing of ours worth keeping on this device. The
      // shared copy is left alone; it may be someone else's.
      clearDraft(localKey)
      return undefined
    }
    const tLocal = setTimeout(() => saveDraft(localKey, values), SAVE_DEBOUNCE_MS)
    if (status === 'gone') return () => clearTimeout(tLocal)
    const tServer = setTimeout(async () => {
      setStatus('saving')
      try {
        const res = await apiPut(path, { values, base_version: base.current })
        if (res?.gone) {
          setStatus('gone')
          return
        }
        base.current = res.version
        if (res.replaced) setReplaced(res.replaced)
        setStatus('saved')
      } catch {
        setStatus('device')
      }
    }, SERVER_DEBOUNCE_MS)
    return () => {
      clearTimeout(tLocal)
      clearTimeout(tServer)
    }
    // `serialized` stands in for `values`, a fresh object every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, loaded, offer, dirty, serialized, localKey, path, nonce])

  function resume() {
    if (!offer) return
    apply(offer.values || {})
    // Resuming the shared copy, or knowingly choosing this device's newer
    // copy over it, is not "replacing someone's work" — either way the next
    // save should not warn about the version that was on screen.
    base.current = serverDraft.current?.version ?? null
    setOffer(null)
  }

  async function discard() {
    clearDraft(localKey)
    setOffer(null)
    base.current = null
    if (serverDraft.current) {
      serverDraft.current = null
      try {
        await apiDelete(path)
      } catch {
        /* offline: the shared copy stays, and will be offered again */
      }
    }
  }

  // Put back what our save replaced. The next autosave writes it as a new
  // version, so it is shared again.
  function restoreReplaced() {
    if (!replaced) return
    apply(replaced.values || {})
    setReplaced(null)
  }

  // After 'gone' (someone submitted or discarded the draft we were editing):
  // share what is on screen as a fresh draft.
  function startNew() {
    base.current = null
    setStatus('idle')
    setNonce((n) => n + 1)
  }

  /** Call once the record is saved. The worker has already removed the shared copy. */
  function cleared() {
    clearDraft(localKey)
    setStatus('idle')
  }

  return {
    offer,
    loaded,
    status,
    replaced,
    resume,
    discard,
    restoreReplaced,
    dismissReplaced: () => setReplaced(null),
    startNew,
    cleared,
  }
}

/** "x@splash.com" -> "x" for banners; the full address is in the title attribute. */
export function shortName(email) {
  return String(email || 'someone').split('@')[0]
}
