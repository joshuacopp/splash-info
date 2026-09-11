// MaintainX Requests — file maintenance problems and review every request for
// the sites the operator can see.
//
// This page reads and writes MaintainX directly through
// /inventory/api/maintainx/requests. There is no local requests table: what you
// see here is what MaintainX has. That means a freshly filed request appears
// only after the refetch below, and it also means nothing can drift out of sync.

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { apiGet } from '../lib/api'
import { KpiCard, PageHeader, Pill, SectionTitle, Spinner, Toast } from '../components/ui'
import NewRequestModal from '../components/NewRequestModal'
import { fmtDate, fmtInt } from '../lib/format'

const STATUS_TONE = {
  PENDING: 'amber',
  APPROVED: 'blue',
  DONE: 'emerald',
  REJECTED: 'rose',
}

const STATUS_LABEL = {
  PENDING: 'Pending',
  APPROVED: 'Approved',
  DONE: 'Done',
  REJECTED: 'Rejected',
}

const PRIORITY_TONE = { HIGH: 'rose', MEDIUM: 'amber', LOW: 'slate' }

// Work-order status of the order an approved request was promoted into. The
// worker orders the approved group by this, so it has to be visible or the
// ordering looks arbitrary.
const WO_STATUS_LABEL = {
  OPEN: 'Open',
  IN_PROGRESS: 'In Progress',
  ON_HOLD: 'On Hold',
  DONE: 'Done',
  CANCELED: 'Cancelled',
  SKIPPED: 'Skipped',
}
const WO_STATUS_TONE = {
  OPEN: 'blue',
  IN_PROGRESS: 'amber',
  ON_HOLD: 'slate',
  DONE: 'emerald',
  CANCELED: 'slate',
  SKIPPED: 'slate',
}

// Group headings, in the order the worker sorts them. Keyed on `group`, not
// `status`: MaintainX reports a completed request as requestStatus=DONE while
// its own UI still calls it Approved, so the worker folds DONE in with
// APPROVED and orders that group by work-order status. See groupFor() in
// worker/maintainx.ts.
const GROUP_LABEL = {
  APPROVED: 'Approved',
  PENDING: 'Pending approval',
  REJECTED: 'Denied',
}

const DATE_RANGES = [
  { value: 'all', label: 'All dates', days: null },
  { value: '7', label: 'Last 7 days', days: 7 },
  { value: '30', label: 'Last 30 days', days: 30 },
  { value: '90', label: 'Last 90 days', days: 90 },
]

/** Best-effort display name from a sign-in email, as a starting value for the
 *  "who is submitting" field. Only a prefill — the field stays editable
 *  precisely because a shared site account's email is nobody's actual name. */
function nameFromEmail(email) {
  if (!email) return ''
  const local = String(email).split('@')[0] || ''
  const cleaned = local.replace(/[._-]+/g, ' ').trim()
  if (!cleaned) return ''
  return cleaned
    .split(' ')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

function daysAgoIso(days) {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - days)
  return d.toISOString()
}

export default function MaintainXRequests() {
  const { email, canSubmit } = useAuth()
  const [state, setState] = useState({ loading: true, error: null, data: null })
  const [modalOpen, setModalOpen] = useState(false)
  const [toast, setToast] = useState(null)

  const [q, setQ] = useState('')
  const [location, setLocation] = useState('all')
  const [status, setStatus] = useState('all')
  const [range, setRange] = useState('all')

  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true }))
    try {
      const data = await apiGet('/maintainx/requests')
      setState({ loading: false, error: null, data })
    } catch (err) {
      setState({ loading: false, error: err.message || 'Could not load requests.', data: null })
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const data = state.data
  const requests = data?.requests || []
  const locations = data?.locations || []

  const filtered = useMemo(() => {
    const cutoff = (() => {
      const r = DATE_RANGES.find((d) => d.value === range)
      return r && r.days ? daysAgoIso(r.days) : null
    })()
    const needle = q.trim().toLowerCase()

    return requests.filter((r) => {
      if (location !== 'all' && String(r.locationId) !== location) return false
      if (status !== 'all' && r.status !== status) return false
      if (cutoff && (!r.createdAt || r.createdAt < cutoff)) return false
      if (needle) {
        const hay =
          `${r.title} ${r.description} ${r.locationName || ''} ${r.filedBy || ''}`.toLowerCase()
        if (!hay.includes(needle)) return false
      }
      return true
    })
  }, [requests, q, location, status, range])

  // Tiles describe the FILTERED view, so they stay honest when someone narrows
  // to one site — a "12 pending" that ignores the active filter reads as a bug.
  const stats = useMemo(() => {
    const weekAgo = daysAgoIso(7)
    return {
      pending: filtered.filter((r) => r.status === 'PENDING').length,
      recent: filtered.filter((r) => r.createdAt && r.createdAt >= weekAgo).length,
      locations: new Set(filtered.map((r) => r.locationId).filter((v) => v != null)).size,
      promoted: filtered.filter((r) => r.workOrderId != null).length,
    }
  }, [filtered])

  const filtersActive = q !== '' || location !== 'all' || status !== 'all' || range !== 'all'
  const clearFilters = () => {
    setQ('')
    setLocation('all')
    setStatus('all')
    setRange('all')
  }

  function onFiled(res) {
    setModalOpen(false)
    if (res && res.photosFailed > 0) {
      // Not an error — the request reached MaintainX. Only the images are
      // short, and the filer needs to know so they can add them there.
      setToast({
        tone: 'info',
        title: 'Filed, with photos missing',
        message: `Request #${res.requestId} was created, but ${res.photosFailed} of ${res.photosTotal} photos failed to attach. Add them in MaintainX.`,
      })
    } else {
      setToast({
        tone: 'success',
        title: 'Request filed',
        message: `Request #${res?.requestId} is now in MaintainX.`,
      })
    }
    load()
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Operations"
        title="MaintainX Requests"
        sub="Maintenance problems reported from this app. Requests filed elsewhere in MaintainX are not listed here."
        actions={
          canSubmit && (
            <button className="btn-primary" onClick={() => setModalOpen(true)}>
              + New request
            </button>
          )
        }
      />

      {/* An unbound MAINTAINX_API_KEY is a deploy state, not an error — say what
          is missing rather than showing a failure banner. */}
      {data && data.configured === false && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4">
          <h2 className="text-sm font-extrabold text-amber-900">MaintainX is not connected yet</h2>
          <p className="mt-1 text-sm text-amber-900/80">
            This worker has no <code className="rounded bg-amber-100 px-1">MAINTAINX_API_KEY</code>{' '}
            bound. Run{' '}
            <code className="rounded bg-amber-100 px-1">wrangler secret put MAINTAINX_API_KEY</code>{' '}
            on <strong>splash-inventory</strong> with the same value already set on splash-damage
            and splash-workorders. Everything else in the inventory app works without it.
          </p>
        </div>
      )}

      {/* A partial read still shows its rows — better a short list plus a
          warning than an empty page. */}
      {data && data.configured !== false && data.ok === false && (
        <div className="rounded-2xl border border-rose-200 bg-rose-50 px-5 py-4 text-sm text-rose-800">
          <strong className="font-extrabold">MaintainX read was incomplete.</strong>{' '}
          {data.error || 'The request list below may be missing rows.'}
        </div>
      )}

      {data && data.truncated && (
        <div className="rounded-2xl border border-slate-200 bg-slate-50 px-5 py-4 text-sm text-slate-600">
          Showing the most recent {fmtInt(requests.length)} requests. Older ones exist in
          MaintainX.
        </div>
      )}

      {state.error && (
        <div className="rounded-2xl border border-rose-200 bg-rose-50 px-5 py-4 text-sm font-semibold text-rose-700">
          {state.error}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          label="Pending in MaintainX"
          value={fmtInt(stats.pending)}
          sub="Awaiting triage"
          tone={stats.pending > 0 ? 'warn' : 'default'}
        />
        <KpiCard label="Last 7 days" value={fmtInt(stats.recent)} sub="Recently submitted" />
        <KpiCard
          label="Locations affected"
          value={fmtInt(stats.locations)}
          sub="Across visible requests"
        />
        {/* Mockup asked for "Photos attached" here. The MaintainX list endpoint
            returns no attachment count, so that tile could only ever show a
            fabricated number; this one is derived from workOrderId, which the
            endpoint does return, and answers a more useful question anyway. */}
        <KpiCard
          label="Promoted to work order"
          value={fmtInt(stats.promoted)}
          sub="Accepted by maintenance"
          tone={stats.promoted > 0 ? 'good' : 'default'}
        />
      </div>

      <div className="card px-5 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search problems, locations, or people…"
            className="input min-w-[240px] flex-1 py-2"
          />
          <select
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            className="input py-2"
          >
            <option value="all">All locations</option>
            {locations
              .slice()
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((l) => (
                <option key={l.id} value={String(l.maintainx_id)}>
                  {l.name}
                </option>
              ))}
          </select>
          <select value={status} onChange={(e) => setStatus(e.target.value)} className="input py-2">
            <option value="all">All statuses</option>
            {Object.keys(STATUS_LABEL).map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
          <select value={range} onChange={(e) => setRange(e.target.value)} className="input py-2">
            {DATE_RANGES.map((d) => (
              <option key={d.value} value={d.value}>
                {d.label}
              </option>
            ))}
          </select>
          <button className="btn-ghost py-2" onClick={clearFilters} disabled={!filtersActive}>
            Clear
          </button>
        </div>
      </div>

      <div className="card overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
          <SectionTitle>
            {fmtInt(filtered.length)}
            {filtered.length === requests.length ? '' : ` of ${fmtInt(requests.length)}`} requests
          </SectionTitle>
          <button className="btn-ghost py-1.5 text-xs" onClick={load} disabled={state.loading}>
            {state.loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>

        {state.loading && !data ? (
          <div className="px-5 py-10">
            <Spinner label="Loading requests…" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-5 py-12 text-center text-sm text-slate-400">
            {requests.length === 0
              ? 'No maintenance requests yet. Use “New request” to report the first problem.'
              : 'No requests match these filters.'}
          </div>
        ) : (
          <ul className="divide-y divide-slate-100">
            {filtered.map((r, i) => (
              <Fragment key={r.id}>
                {/* Group heading whenever the status changes. The list arrives
                    already sorted by the worker, so a change of status is a
                    group boundary — no regrouping needed here. */}
                {(i === 0 || filtered[i - 1].group !== r.group) && (
                  <li className="sticky top-0 z-10 flex items-center gap-2 border-y border-slate-100 bg-slate-50/95 px-5 py-2 backdrop-blur">
                    <span className="text-[11px] font-extrabold uppercase tracking-wider text-slate-500">
                      {GROUP_LABEL[r.group] || r.group}
                    </span>
                    <span className="text-[11px] font-bold text-slate-400">
                      {fmtInt(filtered.filter((x) => x.group === r.group).length)}
                    </span>
                  </li>
                )}
                <li className="px-5 py-4 hover:bg-splash-50/40">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-bold text-slate-900">{r.title}</span>
                      <Pill tone={STATUS_TONE[r.status] || 'slate'}>
                        {STATUS_LABEL[r.status] || r.status}
                      </Pill>
                      {r.priority && (
                        <Pill tone={PRIORITY_TONE[r.priority] || 'slate'}>{r.priority}</Pill>
                      )}
                      {r.workOrderId != null && (
                        <Pill tone={WO_STATUS_TONE[r.workOrderStatus] || 'blue'}>
                          WO #{r.workOrderId}
                          {r.workOrderStatus
                            ? ` · ${WO_STATUS_LABEL[r.workOrderStatus] || r.workOrderStatus}`
                            : ''}
                        </Pill>
                      )}
                    </div>
                    <div className="mt-1 text-xs font-semibold text-slate-500">
                      {r.locationName || `MaintainX location #${r.locationId}`}
                      {r.createdAt && <span className="text-slate-300"> · </span>}
                      {r.createdAt && fmtDate(r.createdAt.slice(0, 10))}
                      {r.filedBy && <span className="text-slate-300"> · </span>}
                      {r.filedBy}
                    </div>
                    {r.description && (
                      <p className="mt-1.5 line-clamp-2 text-sm text-slate-500">{r.description}</p>
                    )}
                  </div>
                  <span className="shrink-0 text-xs font-bold tabular-nums text-slate-300">
                    #{r.id}
                  </span>
                </div>
                </li>
              </Fragment>
            ))}
          </ul>
        )}
      </div>

      <NewRequestModal
        open={modalOpen}
        locations={locations}
        defaultName={nameFromEmail(email)}
        onClose={() => setModalOpen(false)}
        onFiled={onFiled}
      />
      <Toast toast={toast} onDismiss={() => setToast(null)} />
    </div>
  )
}
