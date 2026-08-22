import { useMemo, useState } from 'react'
import { KpiCard, Banner, SectionTitle, Pill, SortHeader, Delta } from './ui'
import { meteringLabel, injectorLabel } from '../lib/calc'
import { fmtCurrency, fmtCpc, fmtInt, fmtNumber, fmtPct, fmtGal, fmtDate } from '../lib/format'

export default function VisitView({ computed }) {
  const [sort, setSort] = useState({ key: 'cost', dir: 'desc' })
  const c = computed
  const hasPrev = !!c.prevVisit

  const rows = useMemo(() => {
    const arr = c.entries.slice()
    const dir = sort.dir === 'asc' ? 1 : -1
    arr.sort((a, b) => {
      let av, bv
      switch (sort.key) {
        case 'name':
          return dir * a.name.localeCompare(b.name)
        case 'usage':
          av = a.usageGal; bv = b.usageGal; break
        case 'ending':
          av = a.endingQtyGal; bv = b.endingQtyGal; break
        case 'mlcar':
          av = a.actualMlPerCar ?? -Infinity; bv = b.actualMlPerCar ?? -Infinity; break
        case 'cost':
        default:
          av = a.cost; bv = b.cost; break
      }
      return dir * (av - bv)
    })
    return arr
  }, [c.entries, sort])

  const cpcTone =
    c.blendedCpc != null && c.blendedTargetCpc != null
      ? c.blendedCpc <= c.blendedTargetCpc ? 'good' : 'warn'
      : 'default'

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <KpiCard label="Wash count" value={fmtInt(c.totalWashCount)} sub="this visit" />
        <KpiCard
          label="Blended CPC"
          value={fmtCpc(c.blendedCpc)}
          sub={`Target ${fmtCpc(c.blendedTargetCpc)}`}
          tone={cpcTone}
        />
        <KpiCard label="Inventory on hand" value={fmtCurrency(c.onHandValue, 0)} sub="ending qty value" />
        <KpiCard
          label="Chemical cost"
          value={fmtCurrency(c.chemicalCost)}
          sub={
            hasPrev && c.prevComputed
              ? `prev visit ${fmtCurrency(c.prevComputed.chemicalCost)}`
              : 'this visit'
          }
        />
        {/* Deliberately adjacent to Chemical cost, and deliberately NOT summed
            with it. Chemical cost is what the site CONSUMED (starting +
            delivered − ending); this is what was DROPPED OFF. A drum delivered
            and barely touched makes them diverge, which is the reason to show
            both. Rendered even at $0 — most visits have no delivery, and an
            absent card would read as a broken tile rather than as "none". */}
        <KpiCard
          label="Delivery cost"
          value={fmtCurrency(c.deliveredValue)}
          sub={c.deliveredValue > 0 ? 'delivered this visit' : 'no delivery'}
        />
      </div>

      {(c.overTargetFlags.length > 0 || c.negativeUsageFlags.length > 0) && (
        <div className="space-y-3">
          {c.negativeUsageFlags.length > 0 && (
            <Banner tone="rose" title={`${c.negativeUsageFlags.length} product(s) show negative usage`}>
              <p className="mb-1 text-xs">
                Usage can&rsquo;t really be negative — it means the ending amount was recorded as more
                than starting + delivered. Almost always a delivery that wasn&rsquo;t entered, or a
                miscounted reservoir/floor.
              </p>
              <ul className="mt-1 space-y-0.5">
                {c.negativeUsageFlags.map((e) => (
                  <li key={e.id}>
                    <span className="font-semibold">{e.name}</span> — usage {fmtGal(e.usageGal)} (starting{' '}
                    {fmtNumber(e.startingQtyGal)} + delivered {fmtNumber(e.qtyDeliveredGal)} − ending{' '}
                    {fmtNumber(e.endingQtyGal)})
                  </li>
                ))}
              </ul>
            </Banner>
          )}
          {c.overTargetFlags.length > 0 && (
            <Banner tone="amber" title={`${c.overTargetFlags.length} product(s) over goal usage (>30%)`}>
              <ul className="mt-1 space-y-0.5">
                {c.overTargetFlags.map((e) => (
                  <li key={e.id}>
                    <span className="font-semibold">{e.name}</span> — {fmtNumber(e.actualMlPerCar, 1)} ml/car
                    vs goal {fmtNumber(e.targetMlPerCar, 1)} ({fmtPct(e.overTargetPct)} over)
                  </li>
                ))}
              </ul>
            </Banner>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-5">
        {/* Packages */}
        <div className="card overflow-hidden xl:col-span-2">
          <div className="border-b border-slate-100 px-5 py-3.5">
            <SectionTitle>Wash packages</SectionTitle>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-100">
              <thead className="bg-slate-50/70">
                <tr>
                  <th className="th">Package</th>
                  <th className="th text-right">Washes</th>
                  <th className="th text-right">% of total</th>
                  <th className="th text-right">Actual CPC</th>
                  <th className="th text-right">Target CPC</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {c.washPackages.map((p) => (
                  <PackageRow key={p.packageId} p={p} />
                ))}
                {!c.washPackages.length && (
                  <tr>
                    <td className="td text-slate-400" colSpan={5}>No wash counts recorded.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {c.addonPackages.length > 0 && (
            <>
              <div className="border-y border-slate-100 bg-amber-50/50 px-5 py-2.5">
                <span className="text-[11px] font-bold uppercase tracking-wider text-amber-700">
                  Add-ons (à la carte — not counted in wash totals)
                </span>
              </div>
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-slate-100">
                  <tbody className="divide-y divide-slate-100">
                    {c.addonPackages.map((p) => (
                      <PackageRow key={p.packageId} p={p} addon />
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>

        {/* Product usage */}
        <div className="card overflow-hidden xl:col-span-3">
          <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3.5">
            <SectionTitle>Product usage</SectionTitle>
            {hasPrev && (
              <span className="text-[11px] font-medium text-slate-400">
                Δ vs {fmtDate(c.prevVisit.visit_date)}
              </span>
            )}
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-100">
              <thead className="bg-slate-50/70">
                <tr>
                  <SortHeader label="Product" k="name" sort={sort} setSort={setSort} />
                  <SortHeader label="Usage" k="usage" sort={sort} setSort={setSort} align="right" />
                  <SortHeader label="Ending" k="ending" sort={sort} setSort={setSort} align="right" />
                  <SortHeader label="ml/car" k="mlcar" sort={sort} setSort={setSort} align="right" />
                  {hasPrev && <th className="th text-right">Δ prev</th>}
                  <SortHeader label="Cost" k="cost" sort={sort} setSort={setSort} align="right" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((e) => (
                  <tr key={e.id} className={e.negativeUsage ? 'bg-rose-50/60 hover:bg-rose-50' : 'hover:bg-slate-50/60'}>
                    <td className="td">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-slate-900">{e.name}</span>
                        {e.negativeUsage && <Pill tone="rose">negative</Pill>}
                      </div>
                      {e.description && (
                        <div className="max-w-[220px] truncate text-[11px] font-medium text-slate-400">
                          {e.description}
                        </div>
                      )}
                      {(meteringLabel(e) || injectorLabel(e)) && (
                        <div className="mt-0.5 flex flex-wrap gap-x-2 text-[11px] font-medium text-splash-500">
                          {meteringLabel(e) && <span>{meteringLabel(e)}</span>}
                          {injectorLabel(e) && <span>Injector: {injectorLabel(e)}</span>}
                        </div>
                      )}
                    </td>
                    <td className="td text-right tabular-nums">{fmtGal(e.usageGal)}</td>
                    <td className="td text-right tabular-nums text-slate-500">{fmtNumber(e.endingQtyGal)}</td>
                    <td className={`td text-right tabular-nums ${e.overTarget ? 'font-bold text-amber-600' : ''}`}>
                      {e.actualMlPerCar == null ? '—' : fmtNumber(e.actualMlPerCar, 1)}
                      {e.targetMlPerCar != null && (
                        <span className="ml-1 text-[11px] font-medium text-slate-400">/ {fmtNumber(e.targetMlPerCar, 0)}</span>
                      )}
                    </td>
                    {hasPrev && (
                      <td className="td text-right">
                        <Delta value={e.mlPerCarDelta} fmt={(v) => v.toFixed(1) + ' ml'} />
                      </td>
                    )}
                    <td className="td text-right font-bold tabular-nums text-slate-900">{fmtCurrency(e.cost)}</td>
                  </tr>
                ))}
                {!rows.length && (
                  <tr>
                    <td className="td text-slate-400" colSpan={hasPrev ? 6 : 5}>
                      No inventory recorded.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Rendered only when at least one reading exists. Every imported visit
          has neither, and an empty "Water" card on 1,628 of them would read as
          a defect rather than as history that predates the fields. Each value
          is tested against null rather than truthiness: 0 gpg is a real
          reading at an RO or softened site. */}
      {(c.visit.water_hardness_gpg != null || c.visit.tds_ppm != null) && (
        <div className="card p-5">
          <SectionTitle>Water</SectionTitle>
          <div className="mt-2 flex flex-wrap gap-8">
            {c.visit.water_hardness_gpg != null && (
              <div>
                <div className="text-xs font-bold text-slate-500">Hardness</div>
                <div className="text-lg font-extrabold tabular-nums text-slate-900">
                  {Number(c.visit.water_hardness_gpg)}
                  <span className="ml-1 text-xs font-bold text-slate-400">gpg</span>
                </div>
              </div>
            )}
            {c.visit.tds_ppm != null && (
              <div>
                <div className="text-xs font-bold text-slate-500">TDS</div>
                <div className="text-lg font-extrabold tabular-nums text-slate-900">
                  {Number(c.visit.tds_ppm)}
                  <span className="ml-1 text-xs font-bold text-slate-400">ppm</span>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {c.visit.notes && (
        <div className="card p-5">
          <SectionTitle>Visit notes</SectionTitle>
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-slate-700">{c.visit.notes}</p>
        </div>
      )}
    </div>
  )
}

function PackageRow({ p, addon }) {
  const over = !addon && p.actualCpc != null && p.targetCpc != null && p.actualCpc > p.targetCpc
  return (
    <tr>
      <td className="td font-semibold text-slate-900">
        {p.name}
        {addon && <span className="ml-1.5 text-[10px] font-bold uppercase text-amber-600">add-on</span>}
      </td>
      <td className="td text-right tabular-nums">{fmtInt(p.washCount)}</td>
      <td className="td text-right">
        {addon ? (
          <span className="text-slate-300">—</span>
        ) : (
          <div className="flex items-center justify-end gap-2">
            <div className="h-1.5 w-16 overflow-hidden rounded-full bg-slate-100">
              <div className="h-full rounded-full bg-splash-300" style={{ width: `${Math.min(100, p.pct * 100)}%` }} />
            </div>
            <span className="w-11 text-right text-xs font-semibold text-slate-500">{fmtPct(p.pct)}</span>
          </div>
        )}
      </td>
      <td className={`td text-right tabular-nums ${over ? 'font-bold text-amber-600' : ''}`}>{fmtCpc(p.actualCpc)}</td>
      <td className="td text-right tabular-nums text-slate-500">{fmtCpc(p.targetCpc)}</td>
    </tr>
  )
}
