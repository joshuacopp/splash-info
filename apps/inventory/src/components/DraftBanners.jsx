// Banners for a shared draft (lib/useSharedDraft.js), shared by the visit and
// delivery forms so both say the same thing the same way.

import { Banner } from './ui'
import { formatAge } from '../lib/draft'
import { shortName } from '../lib/useSharedDraft'

function when(at) {
  return formatAge(Date.now() - at)
}

function timeOf(iso) {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

export default function DraftBanners({ draft, noun, email }) {
  const { offer, replaced, status } = draft
  const mine = offer && (offer.by || '').toLowerCase() === (email || '').toLowerCase()

  return (
    <>
      {/* Offered, never applied automatically: restoring silently would
          replace the values the form just seeded with numbers the user has no
          way to trace. Nothing is saved until this is answered. */}
      {offer && (
        <Banner tone="blue" title={`Unfinished ${noun} found`}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>
              {offer.source === 'device' ? (
                <>
                  Saved on this device <strong>{when(offer.at)}</strong>
                  {status === 'device' ? ', while offline' : ''}.
                </>
              ) : (
                <>
                  Saved by <strong title={offer.by}>{mine ? 'you' : shortName(offer.by)}</strong>{' '}
                  <strong>{when(offer.at)}</strong>. Anyone at this site can pick it up.
                </>
              )}{' '}
              Pick up where it left off?
            </span>
            <span className="flex gap-2">
              <button type="button" className="btn-primary py-1.5 text-xs" onClick={draft.resume}>
                Resume
              </button>
              <button
                type="button"
                className="btn-ghost py-1.5 text-xs"
                onClick={draft.discard}
                title={offer.source === 'server' ? 'Deletes the draft for everyone at this site' : undefined}
              >
                {offer.source === 'server' && !mine ? 'Discard for everyone' : 'Start over'}
              </button>
            </span>
          </div>
        </Banner>
      )}

      {replaced && (
        <Banner tone="amber" title="You replaced someone's changes">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>
              <strong title={replaced.updated_by}>{shortName(replaced.updated_by)}</strong> saved this{' '}
              {noun} draft at {timeOf(replaced.updated_at)}, after you opened it. Your save replaced
              theirs. If you are both working on it, agree who carries on.
            </span>
            <span className="flex gap-2">
              <button type="button" className="btn-primary py-1.5 text-xs" onClick={draft.restoreReplaced}>
                Use their version
              </button>
              <button type="button" className="btn-ghost py-1.5 text-xs" onClick={draft.dismissReplaced}>
                Keep mine
              </button>
            </span>
          </div>
        </Banner>
      )}

      {status === 'gone' && (
        <Banner tone="amber" title="This draft was already submitted or discarded">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>
              Someone else finished or discarded it while you were editing. What is on your screen is
              kept on this device only. Check the site&rsquo;s history before submitting, or you may
              file it twice.
            </span>
            <button type="button" className="btn-ghost py-1.5 text-xs" onClick={draft.startNew}>
              Share as a new draft
            </button>
          </div>
        </Banner>
      )}
    </>
  )
}

/** One quiet line under the header saying where the draft is. */
export function DraftStatus({ draft }) {
  const text = {
    saving: 'Saving draft…',
    saved: 'Draft saved · shared with this site',
    device: 'Draft saved on this device only (offline)',
  }[draft.status]
  if (!text) return null
  return (
    <p className={`text-xs font-medium ${draft.status === 'device' ? 'text-amber-700' : 'text-slate-400'}`}>
      {text}
    </p>
  )
}
