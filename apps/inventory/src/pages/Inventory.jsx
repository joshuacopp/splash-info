import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useData } from '../context/DataContext'
import { useAuth } from '../context/AuthContext'
import { inventorySnapshot, monthEndIso } from '../lib/calc'
import { KpiCard, SectionTitle, Pill, PageHeader, SortHeader, EmptyState } from '../components/ui'
import { fmtCurrency, fmtDate, fmtInt, todayIso } from '../lib/format'
import {
  buildInventoryWorkbook,
  downloadBytes,
  inventoryExportFilename,
} from '../lib/export-inventory'

function currentMonth() {
  return todayIso().slice(0, 7) // "YYYY-MM"
}

/** Table ordering. Module-level so the on-screen list and an unfiltered
 *  export can't drift in sort order. */
function sortRows(arr, sort) {
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
}

/** Export dropdown in the page header.
 *
 * The workbook is built from what is on screen, so the menu is rendered by the
 * page rather than lifted into ui.jsx — the handler needs the live filter
 * state, and a generic component would have to be handed all of it anyway. */
function ExportMenu({ onExcel, onPdf, filtered, viewCount, allCount }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  // Defaults to the current view — exporting what you are looking at is the
  // least surprising behaviour. Resets whenever the filters stop mattering.
  const [scope, setScope] = useState('view')
  const ref = useRef(null)

  useEffect(() => {
    if (!filtered) setScope('view')
  }, [filtered])

  useEffect(() => {
    if (!open) return
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  // Deferred a frame so the button paints its busy state before the work
  // starts — building a workbook blocks the main thread, and the PDF path
  // additionally has to fetch the pdf-lib chunk. Awaited because that path is
  // async; a rejected promise must still clear `busy` or the menu stays dead.
  function run(fn) {
    setBusy(true)
    setOpen(false)
    setTimeout(async () => {
      try {
        await fn()
      } catch (err) {
        console.error('[inventory.export] failed:', err)
        window.alert(`Export failed: ${err?.message || err}`)
      } finally {
        setBusy(false)
      }
    }, 0)
  }

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={busy}
        aria-haspopup="menu"
        aria-expanded={open}
        className="btn-ghost flex items-center gap-2"
      >
        {busy ? 'Preparing…' : 'Export'}
        <span className="text-slate-400">▾</span>
      </button>
      {open && (
        <div
          role="menu"
          className="fade-in absolute right-0 z-50 mt-2 w-80 overflow-hidden rounded-2xl border border-slate-200 bg-white p-2 shadow-2xl"
        >
          {/* Scope first, because it changes what both formats contain. When
              no filters are active the two are identical, so the choice is
              hidden rather than offering a distinction without a difference. */}
          {filtered && (
            <div className="px-2 pb-2 pt-1">
              <div className="mb-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-400">
                Include
              </div>
              <div className="flex gap-1">
                <button
                  type="button"
                  onClick={() => setScope('view')}
                  className={`flex-1 rounded-lg px-2 py-1.5 text-xs font-bold transition ${
                    scope === 'view' ? 'bg-splash-600 text-white' : 'bg-slate-100 text-slate-600'
                  }`}
                >
                  Current view ({fmtInt(viewCount)})
                </button>
                <button
                  type="button"
                  onClick={() => setScope('all')}
                  className={`flex-1 rounded-lg px-2 py-1.5 text-xs font-bold transition ${
                    scope === 'all' ? 'bg-splash-600 text-white' : 'bg-slate-100 text-slate-600'
                  }`}
                >
                  All sites ({fmtInt(allCount)})
                </button>
              </div>
            </div>
          )}

          <button
            role="menuitem"
            type="button"
            onClick={() => run(() => onExcel(scope))}
            className="flex w-full items-start gap-3 rounded-xl p-3 text-left hover:bg-slate-50"
          >
            <span className="mt-0.5 shrink-0 rounded-lg bg-emerald-50 px-2 py-1 text-[10px] font-extrabold text-emerald-700">
              XLSX
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-bold text-slate-900">Export to Excel</span>
              <span className="block text-xs text-slate-500">Formatted workbook with sheets</span>
            </span>
          </button>

          <button
            role="menuitem"
            type="button"
            onClick={() => run(() => onPdf(scope))}
            className="flex w-full items-start gap-3 rounded-xl p-3 text-left hover:bg-slate-50"
          >
            <span className="mt-0.5 shrink-0 rounded-lg bg-rose-50 px-2 py-1 text-[10px] font-extrabold text-rose-700">
              PDF
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-bold text-slate-900">Export to PDF</span>
              <span className="block text-xs text-slate-500">
                Print-ready report with page numbers
              </span>
            </span>
          </button>
        </div>
      )}
    </div>
  )
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
    return sortRows(arr, sort)
  }, [snap.rows, manager, q, sort])

  // Unfiltered rows in the same order as the table. Exporting "all sites"
  // should differ from the on-screen list only by the filters, never by the
  // ordering, so both go through sortRows().
  const allRows = useMemo(() => sortRows(snap.rows, sort), [snap.rows, sort])

  const isFiltered = manager !== 'All' || q !== ''

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
        actions={
          <ExportMenu
            filtered={isFiltered}
            viewCount={rows.length}
            allCount={allRows.length}
            onExcel={(scope) => {
              const picked = scope === 'all' ? allRows : rows
              downloadBytes(
                buildInventoryWorkbook({
                  snap,
                  rows: picked,
                  monthLabel,
                  isCurrent,
                  asOfIso,
                  manager: scope === 'all' ? 'All' : manager,
                  query: scope === 'all' ? '' : q,
                }),
                inventoryExportFilename(month, 'xlsx'),
                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
              )
            }}
            onPdf={async (scope) => {
              const picked = scope === 'all' ? allRows : rows
              // Dynamic import keeps pdf-lib (~300 kB) out of the initial
              // bundle — see the header comment in export-pdf.js.
              const { buildInventoryPdf } = await import('../lib/export-pdf')
              const bytes = await buildInventoryPdf({
                rows: picked,
                monthLabel,
                isCurrent,
                asOfIso,
                manager: scope === 'all' ? 'All' : manager,
                query: scope === 'all' ? '' : q,
                scopeLabel:
                  scope === 'all'
                    ? `All ${fmtInt(allRows.length)} sites`
                    : `${fmtInt(picked.length)} of ${fmtInt(allRows.length)} sites`,
              })
              downloadBytes(bytes, inventoryExportFilename(month, 'pdf'), 'application/pdf')
            }}
          />
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
