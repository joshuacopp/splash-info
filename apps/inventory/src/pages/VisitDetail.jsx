import { useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useData } from '../context/DataContext'
import { useAuth } from '../context/AuthContext'
import { computeVisit, attachPrevDeltas } from '../lib/calc'
import { deleteVisit, resendVisitReport } from '../lib/data'
import VisitView from '../components/VisitView'
import { EmptyState, PageHeader, ConfirmDialog, Toast } from '../components/ui'
import { fmtDate } from '../lib/format'

export default function VisitDetail() {
  const { locationId, visitId } = useParams()
  const { dataset, idx, refresh } = useData()
  // Three different capabilities on this page, not one:
  //   canSubmit  -> Edit (a writer fixes their own mistyped count)
  //   isAdmin    -> Resend (mails a site's costs again) and Delete (no undo)
  // visibleLocationIds guards the scope side; null means unrestricted.
  const { canSubmit, isAdmin, visibleLocationIds } = useAuth()
  const navigate = useNavigate()
  const location = idx.locationById[locationId]
  const inScope = !visibleLocationIds || visibleLocationIds.has(locationId)
  const [confirming, setConfirming] = useState(false)
  const [resending, setResending] = useState(false)
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState(null)

  const computed = useMemo(() => {
    const c = computeVisit(dataset, idx, visitId)
    return c ? attachPrevDeltas(dataset, idx, c) : null
  }, [dataset, idx, visitId])

  async function onDelete() {
    setBusy(true)
    try {
      await deleteVisit(visitId)
      await refresh()
      navigate(`/location/${locationId}/history`)
    } catch (e) {
      setToast({ tone: 'error', title: 'Could not delete', message: e.message || String(e) })
      setBusy(false)
      setConfirming(false)
    }
  }

  // Confirmed rather than fired on click. The automatic send is deduped on the
  // visit id forever, so this is the only path that can put a second copy of a
  // site's cost figures in its managers' inboxes — worth one deliberate step.
  async function onResend() {
    setResending(true)
    try {
      const r = await resendVisitReport(visitId)
      const queued = r?.queued || 0
      const who = (r?.via || []).map((v) => `${v.email} (${v.via})`)
      setToast(
        queued
          ? {
              tone: 'success',
              title: `Report re-queued to ${queued} recipient${queued === 1 ? '' : 's'}`,
              message: who.join(', ') || undefined,
            }
          : {
              tone: 'info',
              title: 'Nothing sent',
              message:
                'No recipients resolved for this location — check the site and RM emails on the location record, or add someone under Admin.',
            }
      )
    } catch (e) {
      setToast({ tone: 'error', title: 'Resend failed', message: e.message || String(e) })
    } finally {
      setResending(false)
    }
  }

  if (!location || !computed) return <EmptyState>Visit not found.</EmptyState>

  return (
    <div className="space-y-6">
      <div>
        <div className="flex flex-wrap items-center gap-2 text-sm font-semibold">
          <Link to={`/location/${locationId}`} className="text-splash-600 hover:text-splash-700">
            {location.name}
          </Link>
          <span className="text-slate-300">/</span>
          <Link to={`/location/${locationId}/history`} className="text-splash-600 hover:text-splash-700">
            History
          </Link>
          <span className="text-slate-300">/</span>
          <span className="text-slate-400">{fmtDate(computed.visit.visit_date)}</span>
        </div>
        <PageHeader
          title={`Visit — ${fmtDate(computed.visit.visit_date)}`}
          sub={computed.visit.submitter ? `Submitted by ${computed.visit.submitter}` : null}
          actions={
            <>
              {computed.prevVisit && (
                <Link to={`/location/${locationId}/visit/${computed.prevVisit.id}`} className="btn-ghost">
                  ← Previous visit ({fmtDate(computed.prevVisit.visit_date)})
                </Link>
              )}
              {isAdmin && (
                <button onClick={onResend} disabled={resending} className="btn-ghost">
                  {resending ? 'Sending…' : 'Resend report'}
                </button>
              )}
              {inScope && canSubmit && (
                <Link to={`/location/${locationId}/visit/${visitId}/edit`} className="btn-ghost">
                  Edit
                </Link>
              )}
              {inScope && isAdmin && (
                <button onClick={() => setConfirming(true)} className="btn-danger">
                  Delete
                </button>
              )}
            </>
          }
        />
      </div>

      <VisitView computed={computed} />

      <ConfirmDialog
        open={confirming}
        title="Delete this visit?"
        body={`This permanently removes the ${fmtDate(computed.visit.visit_date)} visit and all of its inventory and wash count data for ${location.name}. This can't be undone.`}
        confirmLabel="Delete visit"
        danger
        busy={busy}
        onConfirm={onDelete}
        onCancel={() => setConfirming(false)}
      />
      <Toast toast={toast} onDismiss={() => setToast(null)} />
    </div>
  )
}
