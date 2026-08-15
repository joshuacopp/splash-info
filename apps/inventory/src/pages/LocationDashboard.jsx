import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useData } from '../context/DataContext'
import { useAuth } from '../context/AuthContext'
import { computeVisit, attachPrevDeltas, DATE_WINDOWS, filterByWindow } from '../lib/calc'
import VisitView from '../components/VisitView'
import { CostOverTimeChart, CpcOverTimeChart } from '../components/charts'
import { SectionTitle, EmptyState, PageHeader, TabNav, Pill } from '../components/ui'
import { fmtDate } from '../lib/format'

export function LocationTabs({ locationId }) {
  return (
    <TabNav
      tabs={[
        { to: `/location/${locationId}`, label: 'Overview', end: true },
        { to: `/location/${locationId}/trends`, label: 'Usage Trends' },
        { to: `/location/${locationId}/packages`, label: 'Packages' },
        { to: `/location/${locationId}/history`, label: 'History' },
      ]}
    />
  )
}

export function DateWindowPicker({ value, onChange }) {
  return (
    <div className="flex shrink-0 rounded-lg border border-slate-200 p-0.5">
      {DATE_WINDOWS.map((w) => (
        <button
          key={w.key}
          onClick={() => onChange(w.key)}
          className={`rounded-md px-2 py-1 text-[11px] font-bold ${
            value === w.key ? 'bg-splash-600 text-white' : 'text-slate-500 hover:bg-slate-100'
          }`}
        >
          {w.label}
        </button>
      ))}
    </div>
  )
}

export function LocationHeader({ location, sub, actions }) {
  return (
    <PageHeader
      eyebrow={location.manager ? `${location.manager}${location.region ? ' · ' + location.region : ''}` : 'Location'}
      title={
        <span className="inline-flex items-center gap-2">
          {location.name}
          {location.active === false && <Pill tone="slate">inactive</Pill>}
        </span>
      }
      sub={sub}
      actions={actions}
    />
  )
}

export default function LocationDashboard() {
  const { locationId } = useParams()
  const { dataset, idx } = useData()
  const { canSubmit, visibleLocationIds } = useAuth()
  const location = idx.locationById[locationId]
  const visits = idx.visitsByLocation[locationId] || []
  const latest = visits[0]
  const [windowKey, setWindowKey] = useState('6m')
  const canAccess = canSubmit && (!visibleLocationIds || visibleLocationIds.has(locationId))

  const computed = useMemo(() => {
    if (!latest) return null
    return attachPrevDeltas(dataset, idx, computeVisit(dataset, idx, latest.id))
  }, [dataset, idx, latest])

  const fullSeries = useMemo(
    () =>
      visits
        .slice()
        .reverse()
        .map((v) => {
          const c = computeVisit(dataset, idx, v.id)
          return {
            isoDate: v.visit_date,
            date: fmtDate(v.visit_date),
            cost: c.chemicalCost,
            actual: c.blendedCpc,
            target: c.blendedTargetCpc,
          }
        }),
    [dataset, idx, visits]
  )
  const windowDays = DATE_WINDOWS.find((w) => w.key === windowKey)?.days
  const series = useMemo(() => filterByWindow(fullSeries, windowDays), [fullSeries, windowDays])

  if (!location) return <EmptyState>Location not found.</EmptyState>

  return (
    <div className="space-y-6">
      <LocationHeader
        location={location}
        sub={
          latest
            ? `Latest visit ${fmtDate(latest.visit_date)}${latest.submitter ? ` · ${latest.submitter}` : ''}`
            : 'No visits yet'
        }
        actions={
          canAccess && (
            <Link to={`/location/${locationId}/new`} className="btn-primary">
              + New site visit
            </Link>
          )
        }
      />

      <LocationTabs locationId={locationId} />

      {computed ? (
        <>
          <VisitView computed={computed} />
          <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
            <div className="card p-5">
              <div className="mb-3 flex items-center justify-between gap-3">
                <SectionTitle>Chemical cost per visit</SectionTitle>
                <DateWindowPicker value={windowKey} onChange={setWindowKey} />
              </div>
              {series.length > 1 ? (
                <CostOverTimeChart data={series} />
              ) : (
                <p className="p-8 text-center text-sm text-slate-500">Need at least two visits for a trend.</p>
              )}
            </div>
            <div className="card p-5">
              <div className="mb-3 flex items-center justify-between gap-3">
                <SectionTitle>Cost per car vs target</SectionTitle>
                <DateWindowPicker value={windowKey} onChange={setWindowKey} />
              </div>
              {series.length > 1 ? (
                <CpcOverTimeChart data={series} />
              ) : (
                <p className="p-8 text-center text-sm text-slate-500">Need at least two visits for a trend.</p>
              )}
            </div>
          </div>
        </>
      ) : (
        <EmptyState>
          No site visits recorded for this location yet.{' '}
          <Link to={`/location/${locationId}/new`} className="font-semibold text-splash-600">
            Add the first one →
          </Link>
        </EmptyState>
      )}
    </div>
  )
}
