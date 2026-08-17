import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useData } from '../context/DataContext'
import { useAuth } from '../context/AuthContext'
import { networkSummary } from '../lib/calc'
import { KpiCard, SectionTitle, Pill, PageHeader, SortHeader } from '../components/ui'
import { CpcByLocationChart } from '../components/charts'
import { fmtCurrency, fmtCpc, fmtInt, fmtDate } from '../lib/format'

export default function MasterDashboard() {
  const { dataset, idx } = useData()
  const { visibleLocationIds } = useAuth()
  const s = useMemo(() => networkSummary(dataset, idx, visibleLocationIds), [dataset, idx, visibleLocationIds])
  const [q, setQ] = useState('')
  const [region, setRegion] = useState('All')
  const [sort, setSort] = useState({ key: 'ytdCars', dir: 'desc' })

  const regions = useMemo(() => {
    const set = new Set(s.rows.map((r) => r.location.manager || 'Unassigned'))
    return ['All', ...[...set].sort((a, b) => (a === 'Unassigned' ? 1 : b === 'Unassigned' ? -1 : a.localeCompare(b)))]
  }, [s.rows])

  const rows = useMemo(() => {
    let arr = s.rows
    if (region !== 'All') arr = arr.filter((r) => (r.location.manager || 'Unassigned') === region)
    if (q) arr = arr.filter((r) => r.location.name.toLowerCase().includes(q.toLowerCase()))
    const dir = sort.dir === 'asc' ? 1 : -1
    const val = (r) => {
      switch (sort.key) {
        case 'name': return r.location.name
        case 'lastVisit': return r.latest ? r.latest.visit_date : ''
        case 'ytdCars': return r.ytdCars
        case 'ytdCpc': return r.ytdCpc ?? -1
        case 'lastCpc': return r.computed?.blendedCpc ?? -1
        case 'onHand': return r.computed?.onHandValue ?? -1
        case 'flags': return r.computed?.flagCount ?? -1
        default: return r.ytdCars
      }
    }
    return arr.slice().sort((a, b) => {
      const av = val(a), bv = val(b)
      if (typeof av === 'string') return dir * av.localeCompare(bv)
      return dir * (av - bv)
    })
  }, [s.rows, q, region, sort])

  // Chart: top 16 by cars YTD, drawn from the same filtered `rows` the table
  // renders — so the manager chips and the search box drive both, and the
  // chart reads as a drill-down of the table rather than an unrelated view.
  //
  // Ranked on ytdCars deliberately. This used to rank on the LATEST visit's
  // totalWashCount, which is traffic x days-since-the-previous-visit, so a
  // site visited every three weeks outranked a busier site visited weekly and
  // the chart order contradicted the table it sits above. "Busiest" now means
  // the same thing in both places.
  //
  // The bars themselves are still the latest visit's actual vs target CPC —
  // there is no YTD target to plot, since blendedTargetCpc is only defined
  // per-visit. Same pairing the table uses (Cars YTD alongside CPC last visit).
  //
  // Sites with only a handful of washes on that latest visit (brand-new
  // locations still ramping up) stay excluded: their cost-per-car is at or
  // near $0.00, which renders as an empty bar indistinguishable from missing
  // data. They remain fully visible in the table as plain numbers.
  const MIN_WASHES_FOR_CHART = 20
  const chartData = useMemo(
    () =>
      rows
        .filter((r) => r.computed && r.computed.blendedCpc != null && r.computed.totalWashCount >= MIN_WASHES_FOR_CHART)
        .sort((a, b) => b.ytdCars - a.ytdCars)
        .slice(0, 16)
        .map((r) => ({
          name: r.location.name,
          actual: r.computed.blendedCpc,
          target: r.computed.blendedTargetCpc,
        })),
    [rows]
  )

  const cpcTone =
    s.networkBlendedCpc != null && s.networkTargetCpc != null
      ? s.networkBlendedCpc <= s.networkTargetCpc ? 'good' : 'warn'
      : 'default'

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Network"
        title="Master Dashboard"
        sub={`${s.rows.length} locations · data through ${fmtDate(s.maxDate)}`}
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <KpiCard label={`Cars YTD ${s.ytdYear || ''}`} value={fmtInt(s.ytdCars)} sub={`${fmtCurrency(s.ytdCost, 0)} chemical spend`} tone="brand" />
        <KpiCard label="Avg CPC YTD" value={fmtCpc(s.ytdCpc)} sub="cost ÷ cars, all visits" />
        <KpiCard
          label="CPC last visits"
          value={fmtCpc(s.networkBlendedCpc)}
          sub={`Target ${fmtCpc(s.networkTargetCpc)}`}
          tone={cpcTone}
        />
        <KpiCard label="Inventory on hand" value={fmtCurrency(s.totalOnHandValue, 0)} sub="across latest visits" />
        <Link to="/attention" className="block transition hover:-translate-y-0.5">
          <KpiCard
            label="Attention →"
            value={`${s.totalFlags} flags`}
            sub={`${s.staleCount} site${s.staleCount === 1 ? '' : 's'} overdue for a visit — click for details`}
            tone={s.totalFlags > 0 ? 'bad' : 'good'}
          />
        </Link>
      </div>

      <div className="card p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <SectionTitle>Actual vs. target CPC — busiest locations</SectionTitle>
          {/* The chips that drive this live in the table header below, so name
              the active filter here or the chart looks like it ignored it. */}
          {(region !== 'All' || q) && (
            <span className="text-xs font-medium text-slate-500">
              {region !== 'All' ? region : 'All managers'}
              {q ? ` · “${q}”` : ''}
            </span>
          )}
        </div>
        {chartData.length ? (
          <CpcByLocationChart key={chartData.map((d) => d.name).join('|')} data={chartData} />
        ) : (
          <p className="p-8 text-center text-sm text-slate-500">
            {!rows.length
              ? 'No locations match the current filter.'
              : rows.some((r) => r.computed)
                ? `Not enough visit history yet — sites need at least ${MIN_WASHES_FOR_CHART} washes recorded to chart.`
                : 'No visit data yet.'}
          </p>
        )}
      </div>

      <div className="card overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
          <SectionTitle>All locations</SectionTitle>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex flex-wrap gap-1">
              {regions.map((r) => (
                <button
                  key={r}
                  onClick={() => setRegion(r)}
                  className={`rounded-lg px-2.5 py-1 text-xs font-bold transition ${
                    region === r ? 'bg-splash-600 text-white' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
                  }`}
                >
                  {r}
                </button>
              ))}
            </div>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search…"
              className="input w-40 py-1.5"
            />
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-100">
            <thead className="bg-slate-50/70">
              <tr>
                <SortHeader label="Location" k="name" sort={sort} setSort={setSort} />
                <SortHeader label="Last visit" k="lastVisit" sort={sort} setSort={setSort} />
                <SortHeader label="Cars YTD" k="ytdCars" sort={sort} setSort={setSort} align="right" />
                <SortHeader label="CPC YTD" k="ytdCpc" sort={sort} setSort={setSort} align="right" />
                <SortHeader label="CPC last visit" k="lastCpc" sort={sort} setSort={setSort} align="right" />
                <SortHeader label="On hand" k="onHand" sort={sort} setSort={setSort} align="right" />
                <SortHeader label="Flags" k="flags" sort={sort} setSort={setSort} align="right" />
                <th className="th"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((r) => {
                const c = r.computed
                const overTarget =
                  c && c.blendedCpc != null && c.blendedTargetCpc != null && c.blendedCpc > c.blendedTargetCpc
                return (
                  <tr key={r.location.id} className="group transition hover:bg-splash-50/40">
                    <td className="td">
                      <Link to={`/location/${r.location.id}`} className="flex items-center gap-2 font-semibold text-slate-900 group-hover:text-splash-700">
                        {r.location.name}
                        {r.stale && <Pill tone="amber">stale</Pill>}
                      </Link>
                      <div className="text-[11px] font-medium text-slate-400">{r.location.manager || 'Unassigned'}</div>
                    </td>
                    <td className="td">{r.latest ? fmtDate(r.latest.visit_date) : <span className="text-slate-300">no visits</span>}</td>
                    <td className="td text-right tabular-nums">{r.ytdCars ? fmtInt(r.ytdCars) : '—'}</td>
                    <td className="td text-right font-semibold tabular-nums">{fmtCpc(r.ytdCpc)}</td>
                    <td className={`td text-right font-semibold tabular-nums ${overTarget ? 'text-amber-600' : ''}`}>
                      {c ? fmtCpc(c.blendedCpc) : '—'}
                      {c && c.blendedTargetCpc != null && (
                        <span className="ml-1 text-[11px] font-medium text-slate-400">/ {fmtCpc(c.blendedTargetCpc)}</span>
                      )}
                    </td>
                    <td className="td text-right tabular-nums">{c ? fmtCurrency(c.onHandValue, 0) : '—'}</td>
                    <td className="td text-right">
                      {c ? (
                        c.flagCount > 0 ? <Pill tone="rose">{c.flagCount}</Pill> : <Pill tone="emerald">0</Pill>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="td text-right">
                      <Link
                        to={`/location/${r.location.id}`}
                        className="text-sm font-bold text-splash-600 opacity-0 transition group-hover:opacity-100"
                      >
                        Open →
                      </Link>
                    </td>
                  </tr>
                )
              })}
              {!rows.length && (
                <tr>
                  <td className="td py-8 text-center text-slate-400" colSpan={8}>
                    No locations match.
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
