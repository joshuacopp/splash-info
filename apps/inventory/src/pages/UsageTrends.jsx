import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useData } from '../context/DataContext'
import { usageTrends } from '../lib/calc'
import { LocationTabs, LocationHeader } from './LocationDashboard'
import { SectionTitle, EmptyState, Pill } from '../components/ui'
import { fmtNumber, fmtDate, fmtCpc } from '../lib/format'

const VISIT_OPTIONS = [4, 8, 12, 20]

export default function UsageTrends() {
  const { locationId } = useParams()
  const { dataset, idx } = useData()
  const location = idx.locationById[locationId]
  const [lastN, setLastN] = useState(8)
  const [mode, setMode] = useState('ml') // 'ml' | 'cost'

  const t = useMemo(() => usageTrends(dataset, idx, locationId, lastN), [dataset, idx, locationId, lastN])

  if (!location) return <EmptyState>Location not found.</EmptyState>

  return (
    <div className="space-y-6">
      <LocationHeader
        location={location}
        sub="Per-product usage across visits — latest first, color-coded against target"
        actions={
          <Link to={`/location/${locationId}/new`} className="btn-primary">
            + New site visit
          </Link>
        }
      />
      <LocationTabs locationId={locationId} />

      <div className="card overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
          <SectionTitle>
            {mode === 'ml' ? 'Chemical usage per car (ml/car)' : 'Chemical cost per car ($/car)'}
          </SectionTitle>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex rounded-xl border border-slate-200 p-0.5">
              <button
                onClick={() => setMode('ml')}
                className={`rounded-lg px-3 py-1 text-xs font-bold ${mode === 'ml' ? 'bg-splash-600 text-white' : 'text-slate-500'}`}
              >
                ml / car
              </button>
              <button
                onClick={() => setMode('cost')}
                className={`rounded-lg px-3 py-1 text-xs font-bold ${mode === 'cost' ? 'bg-splash-600 text-white' : 'text-slate-500'}`}
              >
                $ / car
              </button>
            </div>
            <select
              value={lastN}
              onChange={(e) => setLastN(Number(e.target.value))}
              className="input w-auto py-1.5 text-xs font-semibold"
            >
              {VISIT_OPTIONS.map((n) => (
                <option key={n} value={n}>
                  last {n} visits
                </option>
              ))}
            </select>
          </div>
        </div>

        {t.visits.length ? (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-100">
              <thead className="bg-slate-50/70">
                <tr>
                  <th className="th sticky left-0 z-10 bg-slate-50/95">Product</th>
                  <th className="th text-right">Target</th>
                  {t.visits.map((v) => (
                    <th key={v.id} className="th text-right">
                      <Link to={`/location/${locationId}/visit/${v.id}`} className="hover:text-splash-600">
                        {fmtDate(v.visit_date)}
                      </Link>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {t.rows.map((r) => (
                  <tr key={r.productId} className="hover:bg-slate-50/60">
                    <td className="td sticky left-0 z-10 bg-white font-semibold text-slate-900">
                      {r.name}
                      {r.description && (
                        <div className="max-w-[200px] truncate text-[11px] font-medium text-slate-400">
                          {r.description}
                        </div>
                      )}
                    </td>
                    <td className="td text-right font-bold tabular-nums text-slate-400">
                      {mode === 'ml' ? (r.targetMlPerCar != null ? fmtNumber(r.targetMlPerCar, 1) : '—') : ''}
                    </td>
                    {r.cells.map((cell, i) => {
                      if (!cell || (mode === 'ml' ? cell.mlPerCar == null : cell.costPerCar == null)) {
                        return (
                          <td key={i} className="td text-right text-slate-200">
                            ·
                          </td>
                        )
                      }
                      const val = mode === 'ml' ? cell.mlPerCar : cell.costPerCar
                      const over = mode === 'ml' && cell.overTarget
                      const under =
                        mode === 'ml' &&
                        !cell.overTarget &&
                        r.targetMlPerCar != null &&
                        r.targetMlPerCar > 0 &&
                        cell.mlPerCar <= r.targetMlPerCar
                      return (
                        <td
                          key={i}
                          className={`td text-right tabular-nums ${
                            over
                              ? 'bg-amber-50 font-bold text-amber-700'
                              : under
                                ? 'text-emerald-700'
                                : 'text-slate-600'
                          }`}
                        >
                          {mode === 'ml' ? fmtNumber(val, 1) : fmtCpc(val)}
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t-2 border-slate-200 bg-slate-50/70">
                <tr>
                  <td className="td sticky left-0 z-10 bg-slate-50/95 font-bold text-slate-900">
                    Blended CPC
                  </td>
                  <td className="td" />
                  {t.computed.map((c, i) => (
                    <td key={i} className="td text-right font-bold tabular-nums text-splash-700">
                      {fmtCpc(c.blendedCpc)}
                    </td>
                  ))}
                </tr>
              </tfoot>
            </table>
          </div>
        ) : (
          <p className="p-10 text-center text-sm text-slate-500">No visits yet.</p>
        )}

        <div className="flex flex-wrap items-center gap-4 border-t border-slate-100 px-5 py-3 text-[11px] font-medium text-slate-400">
          <span className="flex items-center gap-1.5">
            <span className="h-3 w-3 rounded bg-amber-100 ring-1 ring-amber-300" /> over target by &gt;15%
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-3 w-3 rounded bg-emerald-100 ring-1 ring-emerald-300" /> at or under target
          </span>
          <span className="ml-auto">
            <Pill tone="blue">latest visit first</Pill>
          </span>
        </div>
      </div>
    </div>
  )
}
