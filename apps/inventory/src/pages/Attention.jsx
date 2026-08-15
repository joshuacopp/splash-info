import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useData } from '../context/DataContext'
import { useAuth } from '../context/AuthContext'
import { networkSummary, isOlderThanMonths, STALE_AFTER_DAYS } from '../lib/calc'
import { resolveFlag, unresolveFlag } from '../lib/data'
import { PageHeader, SectionTitle, Pill, KpiCard, Toast, EmptyState } from '../components/ui'
import { fmtCurrency, fmtNumber, fmtPct, fmtDate, fmtInt, todayIso } from '../lib/format'

const EXPIRE_MONTHS = 3

export default function Attention() {
  const { dataset, idx, refresh } = useData()
  const { visibleLocationIds, isAdmin } = useAuth()
  const [toast, setToast] = useState(null)
  const [openLocId, setOpenLocId] = useState(null)
  const [openManager, setOpenManager] = useState(null)
  const [view, setView] = useState('open')
  const [resolvedQ, setResolvedQ] = useState('')

  const s = useMemo(() => networkSummary(dataset, idx, visibleLocationIds), [dataset, idx, visibleLocationIds])
  const today = todayIso()

  const resolutionByKey = useMemo(() => {
    const m = {}
    for (const r of dataset.flag_resolutions || []) m[r.flag_key] = r
    return m
  }, [dataset.flag_resolutions])

  const groups = useMemo(() => {
    const out = []
    for (const r of s.rows) {
      if (!r.computed) continue
      const visit = r.computed.visit
      const expired = isOlderThanMonths(visit.visit_date, EXPIRE_MONTHS, today)
      const items = expired
        ? []
        : [
            ...r.computed.overTargetFlags.map((e) => ({
              type: 'over',
              flagKey: e.flagKeyOverTarget,
              entry: e,
              excessCost:
                e.targetMlPerCar && e.actualMlPerCar
                  ? ((e.actualMlPerCar - e.targetMlPerCar) / e.actualMlPerCar) * e.cost
                  : 0,
            })),
            ...r.computed.reconFlags.map((e) => ({ type: 'recon', flagKey: e.flagKeyRecon, entry: e })),
            ...r.computed.negativeUsageFlags.map((e) => ({ type: 'negative', flagKey: e.flagKeyNegative, entry: e })),
          ]
      if (!items.length && !r.stale) continue
      const openCount = items.filter((i) => !resolutionByKey[i.flagKey]).length + (r.stale ? 1 : 0)
      out.push({ location: r.location, visit, items, stale: r.stale, staleDays: r.staleDays, latest: r.latest, openCount })
    }
    out.sort((a, b) => b.openCount - a.openCount || a.location.name.localeCompare(b.location.name))
    return out
  }, [s.rows, resolutionByKey, today])

  // Group by manager/region — same grouping as the sidebar — so a busy
  // Attention page (dozens of sites) can be scanned by who owns what.
  const managerGroups = useMemo(() => {
    const byManager = {}
    for (const g of groups) {
      const m = g.location.manager || 'Unassigned'
      // "Unassigned" is a grab-bag of unrelated sites (some Region 4, some
      // with no region at all) — never label it with one site's region.
      const region = m === 'Unassigned' ? null : g.location.region
      ;(byManager[m] ||= { manager: m, region, locations: [], openCount: 0 }).locations.push(g)
      byManager[m].openCount += g.openCount
    }
    return Object.values(byManager).sort(
      (a, b) => b.openCount - a.openCount || (a.manager === 'Unassigned' ? 1 : b.manager === 'Unassigned' ? -1 : a.manager.localeCompare(b.manager))
    )
  }, [groups])

  const totals = useMemo(() => {
    let overOpen = 0, reconOpen = 0, negativeOpen = 0, excess = 0
    for (const g of groups) {
      for (const i of g.items) {
        if (resolutionByKey[i.flagKey]) continue
        if (i.type === 'over') { overOpen++; excess += i.excessCost }
        else if (i.type === 'negative') negativeOpen++
        else reconOpen++
      }
    }
    const staleOpen = groups.filter((g) => g.stale).length
    return { overOpen, reconOpen, negativeOpen, excess, staleOpen }
  }, [groups, resolutionByKey])

  // Flat audit list — every resolved item across every visible location,
  // newest resolution first. Inherits the same site-access filtering as
  // everything else on this page (built from `groups`, which is already
  // scoped to visibleLocationIds via networkSummary above).
  const resolvedFlat = useMemo(() => {
    const out = []
    for (const g of groups) {
      for (const item of g.items) {
        const res = resolutionByKey[item.flagKey]
        if (!res) continue
        out.push({ location: g.location, visit: g.visit, item, resolution: res })
      }
    }
    out.sort((a, b) => (a.resolution.resolved_at < b.resolution.resolved_at ? 1 : -1))
    if (!resolvedQ) return out
    const needle = resolvedQ.toLowerCase()
    return out.filter(
      (r) =>
        r.location.name.toLowerCase().includes(needle) ||
        r.resolution.resolved_by.toLowerCase().includes(needle) ||
        r.item.entry.name.toLowerCase().includes(needle)
    )
  }, [groups, resolutionByKey, resolvedQ])

  async function handleResolve(flagKey, locationId, name) {
    await resolveFlag(flagKey, name, locationId)
    await refresh()
  }
  async function handleUndo(flagKey) {
    await unresolveFlag(flagKey)
    await refresh()
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Network"
        title="Attention"
        sub={
          view === 'open'
            ? 'Open issues by location — click a site to see and resolve them. Items auto-clear after 3 months.'
            : 'Audit trail of every resolved issue — who resolved it, and when.'
        }
      />

      <div className="flex gap-1 rounded-2xl border border-slate-200 bg-white p-1 shadow-sm sm:w-fit">
        <button
          onClick={() => setView('open')}
          className={`flex-1 rounded-xl px-4 py-2 text-sm font-semibold transition sm:flex-none ${
            view === 'open' ? 'bg-splash-600 text-white shadow' : 'text-slate-600 hover:bg-slate-100'
          }`}
        >
          Open Issues
        </button>
        <button
          onClick={() => setView('resolved')}
          className={`flex-1 rounded-xl px-4 py-2 text-sm font-semibold transition sm:flex-none ${
            view === 'resolved' ? 'bg-splash-600 text-white shadow' : 'text-slate-600 hover:bg-slate-100'
          }`}
        >
          Resolved ({resolvedFlat.length})
        </button>
      </div>

      {view === 'resolved' ? (
        <div className="card overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
            <SectionTitle>{fmtInt(resolvedFlat.length)} resolved items</SectionTitle>
            <input
              value={resolvedQ}
              onChange={(e) => setResolvedQ(e.target.value)}
              placeholder="Search site, product, or name…"
              className="input w-64 py-1.5"
            />
          </div>
          <div className="max-h-[640px] overflow-auto">
            <table className="min-w-full divide-y divide-slate-100">
              <thead className="sticky top-0 z-10 bg-slate-50">
                <tr>
                  <th className="th">Site</th>
                  <th className="th">Issue</th>
                  <th className="th">Resolved by</th>
                  <th className="th">Resolved on</th>
                  <th className="th" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {resolvedFlat.map(({ location, visit, item, resolution }) => (
                  <tr key={item.flagKey} className="hover:bg-slate-50/60">
                    <td className="td">
                      <div className="font-semibold text-slate-900">{location.name}</div>
                      <div className="text-[11px] font-medium text-slate-400">{location.manager || 'Unassigned'}</div>
                    </td>
                    <td className="td text-sm">
                      <FlagLabel item={item} />
                    </td>
                    <td className="td font-semibold text-slate-700">{resolution.resolved_by}</td>
                    <td className="td text-slate-500">{fmtDate(resolution.resolved_at)}</td>
                    <td className="td text-right">
                      <Link to={`/location/${location.id}/visit/${visit.id}`} className="text-sm font-bold text-splash-600 hover:text-splash-700">
                        View visit →
                      </Link>
                    </td>
                  </tr>
                ))}
                {!resolvedFlat.length && (
                  <tr>
                    <td className="td py-8 text-center text-slate-400" colSpan={5}>
                      Nothing resolved yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <KpiCard
              label="Products over target"
              value={fmtInt(totals.overOpen)}
              sub={`≈ ${fmtCurrency(totals.excess, 0)} excess chemical spend`}
              tone={totals.overOpen ? 'warn' : 'good'}
            />
            <KpiCard
              label="Negative usage"
              value={fmtInt(totals.negativeOpen)}
              sub="ending exceeds starting + delivered"
              tone={totals.negativeOpen ? 'bad' : 'good'}
            />
            <KpiCard
              label="Count mismatches"
              value={fmtInt(totals.reconOpen)}
              sub="reservoir + floor ≠ ending"
              tone={totals.reconOpen ? 'bad' : 'good'}
            />
            <KpiCard
              label="Stale sites"
              value={fmtInt(totals.staleOpen)}
              sub={`no visit in ${STALE_AFTER_DAYS}+ days`}
              tone={totals.staleOpen ? 'warn' : 'good'}
            />
          </div>

          <div className="space-y-3">
        {managerGroups.map((mg) => {
          const expanded = openManager === mg.manager || managerGroups.length === 1
          return (
            <div key={mg.manager} className="card overflow-hidden">
              <button
                type="button"
                onClick={() => setOpenManager(expanded && managerGroups.length > 1 ? null : mg.manager)}
                className="flex w-full flex-wrap items-center justify-between gap-3 px-5 py-4 text-left hover:bg-slate-50/60"
              >
                <div className="flex items-center gap-3">
                  <svg
                    className={`h-4 w-4 shrink-0 text-slate-400 transition-transform ${expanded ? 'rotate-90' : ''}`}
                    viewBox="0 0 12 12"
                    fill="currentColor"
                  >
                    <path d="M4 2l4 4-4 4V2z" />
                  </svg>
                  <div>
                    <div className="font-extrabold text-slate-900">{mg.manager}</div>
                    <div className="text-xs text-slate-400">
                      {mg.region ? `${mg.region} · ` : ''}
                      {mg.locations.length} site{mg.locations.length === 1 ? '' : 's'} with items
                    </div>
                  </div>
                </div>
                {mg.openCount > 0 ? <Pill tone="rose">{mg.openCount} open</Pill> : <Pill tone="emerald">all clear</Pill>}
              </button>

              {expanded && (
                <div className="space-y-3 border-t border-slate-100 bg-slate-50/40 p-3">
                  {mg.locations.map((g) => (
                    <LocationGroup
                      key={g.location.id}
                      group={g}
                      open={openLocId === g.location.id}
                      onToggle={() => setOpenLocId(openLocId === g.location.id ? null : g.location.id)}
                      resolutionByKey={resolutionByKey}
                      isAdmin={isAdmin}
                      onResolve={handleResolve}
                      onUndo={handleUndo}
                      setToast={setToast}
                    />
                  ))}
                </div>
              )}
            </div>
          )
        })}
            {!managerGroups.length && (
              <EmptyState>Nothing needs attention right now. 🎉</EmptyState>
            )}
          </div>
        </>
      )}

      <Toast toast={toast} onDismiss={() => setToast(null)} />
    </div>
  )
}

function LocationGroup({ group: g, open, onToggle, resolutionByKey, isAdmin, onResolve, onUndo, setToast }) {
  const [busyKey, setBusyKey] = useState(null)
  const [resolvingKey, setResolvingKey] = useState(null)
  const [nameInput, setNameInput] = useState('')

  const openItems = g.items.filter((i) => !resolutionByKey[i.flagKey])
  const resolvedItems = g.items.filter((i) => resolutionByKey[i.flagKey])

  async function confirm(item) {
    if (!nameInput.trim()) return
    setBusyKey(item.flagKey)
    try {
      await onResolve(item.flagKey, g.location.id, nameInput.trim())
      setResolvingKey(null)
      setNameInput('')
    } catch (e) {
      setToast({ tone: 'error', title: 'Could not save', message: e.message || String(e) })
    } finally {
      setBusyKey(null)
    }
  }
  async function undo(item) {
    setBusyKey(item.flagKey)
    try {
      await onUndo(item.flagKey)
    } catch (e) {
      setToast({ tone: 'error', title: 'Could not undo', message: e.message || String(e) })
    } finally {
      setBusyKey(null)
    }
  }

  return (
    <div className="card overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full flex-wrap items-center justify-between gap-3 px-5 py-4 text-left hover:bg-slate-50/60"
      >
        <div className="flex items-center gap-3">
          <svg
            className={`h-4 w-4 shrink-0 text-slate-400 transition-transform ${open ? 'rotate-90' : ''}`}
            viewBox="0 0 12 12"
            fill="currentColor"
          >
            <path d="M4 2l4 4-4 4V2z" />
          </svg>
          <div>
            <div className="font-bold text-slate-900">{g.location.name}</div>
            <div className="text-xs text-slate-400">
              {g.location.manager || 'Unassigned'}
              {g.latest ? ` · latest visit ${fmtDate(g.latest.visit_date)}` : ''}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {g.stale && <Pill tone="amber">{g.staleDays}d overdue</Pill>}
          {openItems.length > 0 ? (
            <Pill tone="rose">{openItems.length} open</Pill>
          ) : (
            <Pill tone="emerald">all clear</Pill>
          )}
        </div>
      </button>

      {open && (
        <div className="border-t border-slate-100 px-5 py-4">
          {g.stale && (
            <div className="mb-3 flex items-center justify-between rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900">
              <span>
                No visit recorded in {g.staleDays} days — resolves automatically once a new visit is logged.
              </span>
              <Link to={`/location/${g.location.id}/new`} className="font-bold text-splash-600 hover:text-splash-700">
                Record visit →
              </Link>
            </div>
          )}

          <div className="space-y-2">
            {openItems.map((item) => (
              <FlagRow
                key={item.flagKey}
                item={item}
                locationId={g.location.id}
                visitId={g.visit.id}
                resolving={resolvingKey === item.flagKey}
                busy={busyKey === item.flagKey}
                nameInput={nameInput}
                setNameInput={setNameInput}
                onCheck={() => setResolvingKey(item.flagKey)}
                onCancel={() => setResolvingKey(null)}
                onConfirm={() => confirm(item)}
              />
            ))}
            {!openItems.length && !g.stale && (
              <p className="py-2 text-sm text-slate-400">No open flags — nice work.</p>
            )}
          </div>

          {resolvedItems.length > 0 && (
            <details className="mt-3">
              <summary className="cursor-pointer text-xs font-bold text-slate-400 hover:text-slate-600">
                {resolvedItems.length} resolved
              </summary>
              <div className="mt-2 space-y-2">
                {resolvedItems.map((item) => {
                  const res = resolutionByKey[item.flagKey]
                  return (
                    <div key={item.flagKey} className="flex items-center justify-between gap-3 rounded-xl bg-slate-50 px-4 py-2.5">
                      <div className="flex items-center gap-2 text-sm text-slate-400 line-through">
                        <FlagLabel item={item} />
                      </div>
                      <div className="flex shrink-0 items-center gap-2 text-xs text-slate-400">
                        <span>
                          resolved by <b className="text-slate-500">{res.resolved_by}</b> · {fmtDate(res.resolved_at)}
                        </span>
                        {isAdmin && (
                          <button
                            onClick={() => undo(item)}
                            disabled={busyKey === item.flagKey}
                            className="font-bold text-rose-500 hover:text-rose-600"
                          >
                            Undo
                          </button>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            </details>
          )}

          <div className="mt-3 flex justify-end">
            <Link
              to={`/location/${g.location.id}/visit/${g.visit.id}`}
              className="text-sm font-bold text-splash-600 hover:text-splash-700"
            >
              View visit →
            </Link>
          </div>
        </div>
      )}
    </div>
  )
}

function FlagLabel({ item }) {
  const e = item.entry
  if (item.type === 'over') {
    return (
      <span>
        <b className="text-slate-700">{e.name}</b> — {fmtNumber(e.actualMlPerCar, 1)} ml/car vs target{' '}
        {fmtNumber(e.targetMlPerCar, 1)} ({fmtPct(e.overTargetPct, 0)} over)
      </span>
    )
  }
  if (item.type === 'negative') {
    return (
      <span>
        <b className="text-slate-700">{e.name}</b> — usage {fmtNumber(e.usageGal)} gal (starting{' '}
        {fmtNumber(e.startingQtyGal)} + delivered {fmtNumber(e.qtyDeliveredGal)} − ending{' '}
        {fmtNumber(e.endingQtyGal)}) — likely a missed delivery or count error
      </span>
    )
  }
  return (
    <span>
      <b className="text-slate-700">{e.name}</b> — reservoir {fmtNumber(e.reservoirCountGal)} + floor{' '}
      {fmtNumber(e.floorCountGal)} = {fmtNumber(e.reservoirCountGal + e.floorCountGal)} gal, but ending ={' '}
      {fmtNumber(e.endingQtyGal)} gal
    </span>
  )
}

function FlagRow({ item, resolving, busy, nameInput, setNameInput, onCheck, onCancel, onConfirm }) {
  const tone = item.type === 'over' ? 'bg-amber-50' : 'bg-rose-50'
  return (
    <div className={`rounded-xl ${tone} px-4 py-2.5`}>
      <div className="flex items-center justify-between gap-3">
        <label className="flex flex-1 items-center gap-2.5 text-sm">
          <input
            type="checkbox"
            checked={false}
            onChange={onCheck}
            disabled={resolving}
            className="h-4 w-4 shrink-0 rounded accent-splash-600"
          />
          <FlagLabel item={item} />
        </label>
        {item.type === 'over' && item.excessCost > 0 && (
          <span className="shrink-0 text-xs font-bold text-amber-700">{fmtCurrency(item.excessCost, 0)} excess</span>
        )}
      </div>
      {resolving && (
        <div className="mt-2 flex items-center gap-2 pl-6">
          <input
            autoFocus
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && onConfirm()}
            placeholder="Your name"
            className="input w-48 py-1.5 text-xs"
          />
          <button className="btn-primary py-1.5 text-xs" disabled={busy || !nameInput.trim()} onClick={onConfirm}>
            {busy ? 'Saving…' : 'Mark resolved'}
          </button>
          <button className="text-xs font-semibold text-slate-400 hover:text-slate-600" onClick={onCancel}>
            Cancel
          </button>
        </div>
      )}
    </div>
  )
}
