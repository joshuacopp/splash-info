import { useMemo } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useData } from '../context/DataContext'
import { computeVisit } from '../lib/calc'
import { EmptyState, Pill } from '../components/ui'
import { LocationTabs, LocationHeader } from './LocationDashboard'
import { fmtCurrency, fmtCpc, fmtInt, fmtDate } from '../lib/format'

export default function History() {
  const { locationId } = useParams()
  const { dataset, idx } = useData()
  const location = idx.locationById[locationId]
  const visits = idx.visitsByLocation[locationId] || []

  const rows = useMemo(
    () => visits.map((v) => ({ v, c: computeVisit(dataset, idx, v.id) })),
    [dataset, idx, visits]
  )

  if (!location) return <EmptyState>Location not found.</EmptyState>

  return (
    <div className="space-y-6">
      <LocationHeader
        location={location}
        sub={`${visits.length} recorded visit${visits.length === 1 ? '' : 's'}`}
        actions={
          <Link to={`/location/${locationId}/new`} className="btn-primary">
            + New site visit
          </Link>
        }
      />
      <LocationTabs locationId={locationId} />

      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-100">
            <thead className="bg-slate-50/70">
              <tr>
                <th className="th">Date</th>
                <th className="th">Submitter</th>
                <th className="th text-right">Wash count</th>
                <th className="th text-right">Chemical cost</th>
                <th className="th text-right">Blended CPC</th>
                <th className="th text-right">Target</th>
                <th className="th text-right">Flags</th>
                <th className="th"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map(({ v, c }) => {
                const over = c.blendedCpc != null && c.blendedTargetCpc != null && c.blendedCpc > c.blendedTargetCpc
                return (
                  <tr key={v.id} className="group transition hover:bg-splash-50/40">
                    <td className="td font-semibold text-slate-900">
                      <Link to={`/location/${locationId}/visit/${v.id}`} className="group-hover:text-splash-700">
                        {fmtDate(v.visit_date)}
                      </Link>
                    </td>
                    <td className="td">{v.submitter || '—'}</td>
                    <td className="td text-right tabular-nums">{fmtInt(c.totalWashCount)}</td>
                    <td className="td text-right tabular-nums">{fmtCurrency(c.chemicalCost)}</td>
                    <td className={`td text-right font-semibold tabular-nums ${over ? 'text-amber-600' : ''}`}>
                      {fmtCpc(c.blendedCpc)}
                    </td>
                    <td className="td text-right tabular-nums text-slate-400">{fmtCpc(c.blendedTargetCpc)}</td>
                    <td className="td text-right">
                      {c.flagCount > 0 ? <Pill tone="rose">{c.flagCount}</Pill> : <Pill tone="emerald">0</Pill>}
                    </td>
                    <td className="td text-right">
                      <Link
                        to={`/location/${locationId}/visit/${v.id}`}
                        className="text-sm font-bold text-splash-600 opacity-0 transition group-hover:opacity-100"
                      >
                        View →
                      </Link>
                    </td>
                  </tr>
                )
              })}
              {!rows.length && (
                <tr>
                  <td className="td py-8 text-center text-slate-400" colSpan={8}>
                    No visits recorded yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
