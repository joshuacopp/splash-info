import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useData } from '../context/DataContext'
import { useAuth } from '../context/AuthContext'
import { inventorySnapshot, monthEndIso } from '../lib/calc'
import { KpiCard, SectionTitle, Pill, PageHeader, SortHeader, EmptyState } from '../components/ui'
import { fmtCurrency, fmtDate, fmtInt, todayIso } from '../lib/format'

function currentMonth() {
  return todayIso().slice(0, 7) // "YYYY-MM"
}

export default function Inventory() {
  const { dataset, idx } = useData()
  const { visibleLocationIds } = useAuth()
  const [month, setMonth] = useState(currentMonth())
  const [q, setQ] = useState('')
  const [manager, setManager] = useState('All')
  const [sort, setSort] = useState({ key: 'value', dir: 'desc' })

  const isCurrent = month === currentMonth()
  // "as of" cutoff: end of the chosen month, but never past today (the
  // current month should reflect the latest data, not a future date).
  const asOfIso = isCurrent ? todayIso() : monthEndIso(month)

  const snap = useMemo(
    () => inventorySnapshot(dataset, idx, asOfIso, visibleLocationIds),
    [dataset, idx, asOfIso, visibleLocationIds]
  )

  const managers = useMemo(() => {
    const set = new Set(snap.rows.map((r) => r.location.manager || 'Unassigned'))
    return ['All', ...[...set].sort((a, b) => (a === 'Unassigned' ? 1 : b === 'Unassigned' ? -1 : a.localeCompare(b)))]
  }, [snap.rows])

  const rows = useMemo(() => {
    let arr = snap.rows
    if (manager !== 'All') arr = arr.filter((r) => (r.location.manager || 'Unassigned') === manager)
    if (q) arr = arr.filter((r) => r.location.name.toLowerCase().includes(q.toLowerCase()))
    const dir = sort.dir === 'asc' ? 1 : -1
    const val = (r) => {
      switch (sort.key) {
        case 'name':
          return r.location.name
        case 'manager':
          return r.location.manager || 'zzz-Unassigned'
        case 'visit':
          return r.visit ? r.visit.visit_date : ''
        case 'value':
        default:
          return r.onHandValue ?? -1
      }
    }
    return arr.slice().sort((a, b) => {
      const av = val(a),
        bv = val(b)
      if (typeof av === 'string') return dir * av.localeCompare(bv)
      return dir * (av - bv)
    })
  }, [snap.rows, manager, q, sort])

  const [monthYear, monthNum] = month.split('-').map(Number)
  const monthLabel = new Date(Date.UTC(monthYear, monthNum - 1, 1)).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  })

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Network"
        title="Inventory"
        sub={
          isCurrent
            ? 'Current on-hand chemical value, per site, as of the latest recorded visit'
            : `Snapshot as of the end of ${monthLabel} — the most recent visit at or before that date`
        }
      />

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-3 py-2 shadow-sm">
          <label className="text-xs font-bold uppercase tracking-wide text-slate-400">Month</label>
          <input
            type="month"
            value={month}
            max={currentMonth()}
            onChange={(e) => setMonth(e.target.value)}
            className="rounded-lg border-0 bg-transparent text-sm font-semibold text-slate-800 outline-none"
          />
        </div>
        {!isCurrent && (
          <button onClick={() => setMonth(currentMonth())} className="btn-ghost py-2 text-xs">
            Back to current
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <KpiCard
          label={isCurrent ? 'Total inventory value' : `Value as of ${monthLabel}`}
          value={fmtCurrency(snap.totalValue, 0)}
          sub={`across ${fmtInt(snap.reportingCount)} of ${fmtInt(snap.totalCount)} sites`}
          tone="brand"
        />
        <KpiCard
          label="Avg per reporting site"
          value={fmtCurrency(snap.reportingCount ? snap.totalValue / snap.reportingCount : 0, 0)}
        />
        <KpiCard
          label="Sites with no data yet"
          value={fmtInt(snap.totalCount - snap.reportingCount)}
          sub={isCurrent ? 'never visited' : 'no visit by this date'}
          tone={snap.totalCount - snap.reportingCount > 0 ? 'warn' : 'good'}
        />
      </div>

      <div className="card overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
          <SectionTitle>{fmtInt(rows.length)} sites</SectionTitle>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex flex-wrap gap-1">
              {managers.map((m) => (
                <button
                  key={m}
                  onClick={() => setManager(m)}
                  className={`rounded-lg px-2.5 py-1 text-xs font-bold transition ${
                    manager === m ? 'bg-splash-600 text-white' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
                  }`}
                >
                  {m}
                </button>
              ))}
            </div>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search sites…" className="input w-48 py-1.5" />
          </div>
        </div>
        <div className="max-h-[640px] overflow-auto">
          <table className="min-w-full divide-y divide-slate-100">
            <thead className="sticky top-0 z-10 bg-slate-50">
              <tr>
                <SortHeader label="Site" k="name" sort={sort} setSort={setSort} />
                <SortHeader label="Manager" k="manager" sort={sort} setSort={setSort} />
                <SortHeader label="Most recent visit" k="visit" sort={sort} setSort={setSort} />
                <SortHeader label="Inventory value" k="value" sort={sort} setSort={setSort} align="right" />
                <th className="th" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((r) => (
                <tr key={r.location.id} className="group hover:bg-splash-50/40">
                  <td className="td font-semibold text-slate-900">{r.location.name}</td>
                  <td className="td text-slate-500">{r.location.manager || 'Unassigned'}</td>
                  <td className="td">
                    {r.visit ? (
                      <span className="flex items-center gap-2">
                        {fmtDate(r.visit.visit_date)}
                        {r.hasNewerVisit && <Pill tone="slate">historical</Pill>}
                      </span>
                    ) : (
                      <span className="text-slate-300">no visit yet</span>
                    )}
                  </td>
                  <td className="td text-right font-bold tabular-nums text-slate-900">
                    {r.onHandValue != null ? fmtCurrency(r.onHandValue, 0) : <span className="font-normal text-slate-300">—</span>}
                  </td>
                  <td className="td text-right">
                    {r.visit && (
                      <Link
                        to={`/location/${r.location.id}/visit/${r.visit.id}`}
                        className="text-sm font-bold text-splash-600 opacity-0 transition group-hover:opacity-100"
                      >
                        View →
                      </Link>
                    )}
                  </td>
                </tr>
              ))}
              {!rows.length && (
                <tr>
                  <td className="td py-8 text-center text-slate-400" colSpan={5}>
                    No sites match.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      {!snap.totalCount && <EmptyState>No locations to show.</EmptyState>}
    </div>
  )
}
