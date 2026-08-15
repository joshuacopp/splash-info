import { useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useData } from '../context/DataContext'
import { useAuth } from '../context/AuthContext'
import { computeVisit, attachPrevDeltas } from '../lib/calc'
import { deleteVisit } from '../lib/data'
import VisitView from '../components/VisitView'
import { EmptyState, PageHeader, ConfirmDialog, Toast } from '../components/ui'
import { fmtDate } from '../lib/format'

export default function VisitDetail() {
  const { locationId, visitId } = useParams()
  const { dataset, idx, refresh } = useData()
  const { isAdmin } = useAuth()
  const navigate = useNavigate()
  const location = idx.locationById[locationId]
  const [confirming, setConfirming] = useState(false)
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
                <>
                  <Link to={`/location/${locationId}/visit/${visitId}/edit`} className="btn-ghost">
                    Edit
                  </Link>
                  <button onClick={() => setConfirming(true)} className="btn-danger">
                    Delete
                  </button>
                </>
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
