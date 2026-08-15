import { useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useData } from '../context/DataContext'
import { useAuth } from '../context/AuthContext'
import { savePackageConfig } from '../lib/data'
import { LocationTabs, LocationHeader } from './LocationDashboard'
import { SectionTitle, EmptyState, Banner, Toast } from '../components/ui'
import { fmtCpc, fmtPct, num } from '../lib/format'

let tempCounter = 0
const tempId = () => `new-${++tempCounter}`

export default function PackageEditor() {
  const { locationId } = useParams()
  const { dataset, idx, refresh } = useData()
  const { canSubmit, visibleLocationIds } = useAuth()
  const location = idx.locationById[locationId]
  const canAccess = canSubmit && (!visibleLocationIds || visibleLocationIds.has(locationId))

  // ---- editable state, initialized from dataset ----
  const [state, setState] = useState(() => initState(dataset, locationId))
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState(null)
  const [dirty, setDirty] = useState(false)

  function initState(ds, locId) {
    const packages = (ds.packages || [])
      .filter((p) => p.location_id === locId)
      .map((p) => ({ id: p.id, name: p.name, packageType: p.package_type || 'wash', isNew: false, deleted: false }))
    const locationProducts = (ds.location_products || [])
      .filter((lp) => lp.location_id === locId)
      .map((lp) => ({
        id: lp.id,
        product_id: lp.product_id,
        target_ml_per_car: lp.target_ml_per_car ?? '',
        discount: lp.discount ?? 0,
        deleted: false,
      }))
    const pkgIds = new Set(packages.map((p) => p.id))
    const matrix = {}
    for (const pp of ds.package_products || []) {
      if (!pkgIds.has(pp.package_id)) continue
      ;(matrix[pp.package_id] ||= {})[pp.product_id] = num(pp.uses)
    }
    return { packages, locationProducts, matrix }
  }

  function mutate(fn) {
    setState((prev) => {
      const next = structuredClone(prev)
      fn(next)
      return next
    })
    setDirty(true)
  }

  const activePkgs = state.packages.filter((p) => !p.deleted)
  const activeLps = state.locationProducts.filter((lp) => !lp.deleted)

  // live computed footer: total ml + target CPC per package
  const footers = useMemo(() => {
    return activePkgs.map((pkg) => {
      let ml = 0
      let cpc = 0
      for (const lp of activeLps) {
        const uses = num(state.matrix[pkg.id]?.[lp.product_id])
        if (!uses) continue
        const product = idx.productById[lp.product_id]
        const target = num(lp.target_ml_per_car)
        ml += uses * target
        cpc += uses * target * (product ? num(product.price_per_ml) : 0) * (1 - num(lp.discount))
      }
      return { pkgId: pkg.id, ml, cpc }
    })
  }, [activePkgs, activeLps, state.matrix, idx.productById])

  // products available to add (master list minus already-stocked)
  const addable = useMemo(() => {
    const used = new Set(activeLps.map((lp) => lp.product_id))
    return (dataset.products || [])
      .filter((p) => !used.has(p.id))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [dataset.products, activeLps])

  async function onSave() {
    setBusy(true)
    try {
      await savePackageConfig(locationId, state)
      await refresh()
      setDirty(false)
      setToast({ tone: 'success', title: 'Saved', message: 'Package configuration updated.' })
    } catch (e) {
      setToast({ tone: 'error', title: 'Could not save', message: e.message || String(e) })
    } finally {
      setBusy(false)
    }
  }

  if (!location) return <EmptyState>Location not found.</EmptyState>
  if (!canAccess) return <EmptyState>You don&rsquo;t have edit access for this location.</EmptyState>

  return (
    <div className="space-y-6">
      <LocationHeader
        location={location}
        sub="Which chemicals are in each package — target CPC computes live from the mix"
        actions={
          <button onClick={onSave} disabled={busy || !dirty} className="btn-primary">
            {busy ? 'Saving…' : dirty ? 'Save changes' : 'Saved'}
          </button>
        }
      />
      <LocationTabs locationId={locationId} />

      {dirty && (
        <Banner tone="blue" title="Unsaved changes">
          Target CPC below updates live as you edit. Hit <b>Save changes</b> to apply.
        </Banner>
      )}

      <div className="card overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-5 py-4">
          <SectionTitle>Package matrix</SectionTitle>
          <div className="flex items-center gap-2">
            <button
              className="btn-ghost py-1.5 text-xs"
              onClick={() =>
                mutate((s) => {
                  s.packages.push({
                    id: tempId(),
                    name: `New Package ${s.packages.length + 1}`,
                    packageType: 'wash',
                    isNew: true,
                    deleted: false,
                  })
                })
              }
            >
              + Add package
            </button>
            {addable.length > 0 && (
              <AddProductPicker
                addable={addable}
                onAdd={(productId) =>
                  mutate((s) => {
                    s.locationProducts.push({
                      id: null,
                      product_id: productId,
                      target_ml_per_car: '',
                      discount: 0,
                      deleted: false,
                    })
                  })
                }
              />
            )}
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-100">
            <thead className="bg-slate-50/70">
              <tr>
                <th className="th sticky left-0 z-10 bg-slate-50/95">Product</th>
                <th className="th text-right">Target ml/car</th>
                <th className="th text-right">Disc</th>
                {activePkgs.map((pkg) => (
                  <th key={pkg.id} className="th text-center">
                    <div>
                      <input
                        value={pkg.name}
                        onChange={(e) =>
                          mutate((s) => {
                            s.packages.find((p) => p.id === pkg.id).name = e.target.value
                          })
                        }
                        className="w-24 rounded-lg border border-transparent bg-transparent px-1 py-0.5 text-center text-[11px] font-bold uppercase tracking-wide text-slate-600 outline-none hover:border-slate-200 focus:border-splash-300 focus:bg-white"
                      />
                      <button
                        title="Remove package"
                        onClick={() =>
                          mutate((s) => {
                            const p = s.packages.find((x) => x.id === pkg.id)
                            p.deleted = true
                          })
                        }
                        className="ml-0.5 text-slate-300 hover:text-rose-500"
                      >
                        ✕
                      </button>
                    </div>
                    <button
                      title="A wash package counts toward total wash count; an add-on (à la carte) does not."
                      onClick={() =>
                        mutate((s) => {
                          const p = s.packages.find((x) => x.id === pkg.id)
                          p.packageType = p.packageType === 'addon' ? 'wash' : 'addon'
                        })
                      }
                      className={`mt-1 rounded-full px-2 py-0.5 text-[10px] font-bold normal-case ${
                        pkg.packageType === 'addon' ? 'bg-amber-100 text-amber-700' : 'bg-splash-100 text-splash-700'
                      }`}
                    >
                      {pkg.packageType === 'addon' ? 'Add-on' : 'Wash'}
                    </button>
                  </th>
                ))}
                <th className="th" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {activeLps.map((lp) => {
                const product = idx.productById[lp.product_id]
                return (
                  <tr key={lp.product_id} className="hover:bg-slate-50/60">
                    <td className="td sticky left-0 z-10 bg-white">
                      <div className="font-semibold text-slate-900">{product ? product.name : '?'}</div>
                      {product?.description && (
                        <div className="max-w-[200px] truncate text-[11px] font-medium text-slate-400">
                          {product.description}
                        </div>
                      )}
                    </td>
                    <td className="td text-right">
                      <input
                        type="number"
                        step="any"
                        value={lp.target_ml_per_car}
                        onChange={(e) =>
                          mutate((s) => {
                            s.locationProducts.find((x) => x.product_id === lp.product_id && !x.deleted).target_ml_per_car = e.target.value
                          })
                        }
                        className="cell-input w-20"
                        placeholder="—"
                      />
                    </td>
                    <td className="td text-right text-xs font-semibold text-slate-400">
                      {num(lp.discount) > 0 ? fmtPct(num(lp.discount), 0) : '—'}
                    </td>
                    {activePkgs.map((pkg) => {
                      const uses = state.matrix[pkg.id]?.[lp.product_id] || ''
                      return (
                        <td key={pkg.id} className="td text-center">
                          <input
                            type="number"
                            step="any"
                            min="0"
                            value={uses}
                            onChange={(e) =>
                              mutate((s) => {
                                const v = e.target.value
                                s.matrix[pkg.id] ||= {}
                                if (v === '' || Number(v) <= 0) delete s.matrix[pkg.id][lp.product_id]
                                else s.matrix[pkg.id][lp.product_id] = Number(v)
                              })
                            }
                            className={`cell-input w-14 text-center ${uses ? 'border-splash-200 bg-splash-50 font-bold text-splash-700' : 'text-slate-400'}`}
                            placeholder="·"
                          />
                        </td>
                      )
                    })}
                    <td className="td text-right">
                      <button
                        title="Remove product from this location"
                        onClick={() =>
                          mutate((s) => {
                            s.locationProducts.find((x) => x.product_id === lp.product_id && !x.deleted).deleted = true
                          })
                        }
                        className="text-slate-300 hover:text-rose-500"
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                )
              })}
              {!activeLps.length && (
                <tr>
                  <td className="td py-8 text-center text-slate-400" colSpan={4 + activePkgs.length}>
                    No products configured — add one above.
                  </td>
                </tr>
              )}
            </tbody>
            <tfoot className="border-t-2 border-slate-200 bg-slate-50/70">
              <tr>
                <td className="td sticky left-0 z-10 bg-slate-50/95 font-bold text-slate-900">Total ml in package</td>
                <td className="td" />
                <td className="td" />
                {footers.map((f) => (
                  <td key={f.pkgId} className="td text-center font-bold tabular-nums text-slate-700">
                    {Math.round(f.ml)}
                  </td>
                ))}
                <td className="td" />
              </tr>
              <tr>
                <td className="td sticky left-0 z-10 bg-slate-50/95 font-bold text-slate-900">Target CPC</td>
                <td className="td" />
                <td className="td" />
                {footers.map((f) => (
                  <td key={f.pkgId} className="td text-center font-bold tabular-nums text-splash-700">
                    {fmtCpc(f.cpc)}
                  </td>
                ))}
                <td className="td" />
              </tr>
            </tfoot>
          </table>
        </div>

        <div className="border-t border-slate-100 px-5 py-3 text-[11px] font-medium text-slate-400">
          Enter how many times each product is applied per package (1 = once, 2 = twice). Blank = not in
          package. Click the <span className="rounded-full bg-splash-100 px-1.5 py-0.5 font-bold text-splash-700">Wash</span>{' '}
          / <span className="rounded-full bg-amber-100 px-1.5 py-0.5 font-bold text-amber-700">Add-on</span> pill under a
          package name to mark it à la carte — add-ons are tracked separately and never count toward total
          wash count or blended CPC. Removing a product or package here does not delete any visit history.
        </div>
      </div>

      <Toast toast={toast} onDismiss={() => setToast(null)} />
    </div>
  )
}

function AddProductPicker({ addable, onAdd }) {
  const [value, setValue] = useState('')
  return (
    <select
      value={value}
      onChange={(e) => {
        if (e.target.value) {
          onAdd(e.target.value)
          setValue('')
        }
      }}
      className="input w-auto py-1.5 text-xs font-semibold"
    >
      <option value="">+ Add product…</option>
      {addable.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
          {p.description ? ` — ${p.description.slice(0, 40)}` : ''}
        </option>
      ))}
    </select>
  )
}
