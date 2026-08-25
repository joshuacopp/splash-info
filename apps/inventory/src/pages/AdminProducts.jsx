import { useMemo, useState } from 'react'
import { useData } from '../context/DataContext'
import { useAuth } from '../context/AuthContext'
import { upsertProduct, saveRecipients, bulkUpdateProductPrices } from '../lib/data'
import {
  PageHeader, SectionTitle, Banner, Toast, Pill, SortHeader, LocationPicker, EmptyState,
  ConfirmDialog,
} from '../components/ui'
import { fmtInt, num } from '../lib/format'
import { GAL_TO_ML } from '../lib/calc'
import { handleGridEnter } from '../lib/gridnav'

// Admin surface, trimmed for the splash-info integration. The old "Users &
// access" and "Regions & Leadership" tabs (and their invite/role/location
// editors) are gone — users, roles, tool grants and locations are now managed
// in the splash sysadmin / master tools, not here. What remains is the two
// things this app still owns: the master product price list and the visit
// report email recipients. Access is gated server-side (super_admin only) via
// the `inventory` grant, so the old client-side passcode gate is also removed.
export default function AdminProducts() {
  const { isAdmin } = useAuth()
  if (!isAdmin) {
    return (
      <EmptyState>
        This area is admin-only. Ask a Splash administrator to grant you super_admin access.
      </EmptyState>
    )
  }
  return <AdminPanel />
}

const ADMIN_TABS = [
  { key: 'products', label: 'Products & pricing' },
  { key: 'bulk', label: 'Bulk price update' },
  { key: 'recipients', label: 'Email recipients' },
]

function AdminPanel() {
  const { dataset, refresh } = useData()
  const [toast, setToast] = useState(null)
  const [tab, setTab] = useState('products')

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Admin"
        title="Admin"
        sub="Master price list and visit report emails"
      />
      <div className="flex gap-1 rounded-2xl border border-slate-200 bg-white p-1 shadow-sm">
        {ADMIN_TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`flex-1 rounded-xl px-4 py-2 text-sm font-semibold transition ${
              tab === t.key ? 'bg-splash-600 text-white shadow' : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'products' && <ProductsSection dataset={dataset} refresh={refresh} setToast={setToast} />}
      {tab === 'bulk' && <BulkPricesSection dataset={dataset} refresh={refresh} setToast={setToast} />}
      {tab === 'recipients' && <RecipientsSection dataset={dataset} refresh={refresh} setToast={setToast} />}
      <Toast toast={toast} onDismiss={() => setToast(null)} />
    </div>
  )
}

// --------------------------------------------------------------------------
function ProductsSection({ dataset, refresh, setToast }) {
  const [q, setQ] = useState('')
  const [sort, setSort] = useState({ key: 'name', dir: 'asc' })
  const [editing, setEditing] = useState(null) // product object being edited
  const [busy, setBusy] = useState(false)

  const usageCount = useMemo(() => {
    const m = {}
    for (const lp of dataset.location_products || []) {
      m[lp.product_id] = (m[lp.product_id] || 0) + 1
    }
    return m
  }, [dataset.location_products])

  const rows = useMemo(() => {
    let arr = dataset.products || []
    if (q) {
      const needle = q.toLowerCase()
      arr = arr.filter(
        (p) =>
          p.name.toLowerCase().includes(needle) ||
          (p.description || '').toLowerCase().includes(needle)
      )
    }
    const dir = sort.dir === 'asc' ? 1 : -1
    const val = (p) => {
      switch (sort.key) {
        case 'price': return num(p.price_per_ml)
        case 'gal': return num(p.price_per_ml) * GAL_TO_ML
        case 'sites': return usageCount[p.id] || 0
        default: return p.name
      }
    }
    return arr.slice().sort((a, b) => {
      const av = val(a), bv = val(b)
      if (typeof av === 'string') return dir * av.localeCompare(bv)
      return dir * (av - bv)
    })
  }, [dataset.products, q, sort, usageCount])

  async function save(product) {
    setBusy(true)
    try {
      await upsertProduct(product)
      await refresh()
      setEditing(null)
      setToast({ tone: 'success', title: 'Saved', message: `${product.name} updated.` })
    } catch (e) {
      setToast({ tone: 'error', title: 'Could not save', message: e.message || String(e) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
        <SectionTitle>Master product list ({fmtInt((dataset.products || []).length)})</SectionTitle>
        <div className="flex items-center gap-2">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search products…"
            className="input w-56 py-1.5"
          />
          <button
            className="btn-primary py-1.5 text-xs"
            onClick={() =>
              setEditing({ id: null, name: '', price_per_ml: '', unit_type: '', description: '' })
            }
          >
            + New product
          </button>
        </div>
      </div>

      <div className="max-h-[560px] overflow-auto">
        <table className="min-w-full divide-y divide-slate-100">
          <thead className="sticky top-0 z-10 bg-slate-50">
            <tr>
              <SortHeader label="Product" k="name" sort={sort} setSort={setSort} />
              <th className="th">Description</th>
              <SortHeader label="$ / ml" k="price" sort={sort} setSort={setSort} align="right" />
              <SortHeader label="$ / gal" k="gal" sort={sort} setSort={setSort} align="right" />
              <SortHeader label="Sites" k="sites" sort={sort} setSort={setSort} align="right" />
              <th className="th" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((p) => (
              <tr key={p.id} className="hover:bg-slate-50/60">
                <td className="td font-semibold text-slate-900">
                  {p.name}
                  {p.unit_type && <span className="ml-2 text-[11px] font-medium text-slate-400">{p.unit_type}</span>}
                </td>
                <td className="td max-w-[260px] truncate text-slate-500">{p.description || '—'}</td>
                <td className="td text-right tabular-nums">{num(p.price_per_ml).toFixed(6)}</td>
                <td className="td text-right tabular-nums text-slate-500">
                  ${(num(p.price_per_ml) * GAL_TO_ML).toFixed(2)}
                </td>
                <td className="td text-right">
                  {usageCount[p.id] ? <Pill tone="blue">{usageCount[p.id]}</Pill> : <span className="text-slate-300">0</span>}
                </td>
                <td className="td text-right">
                  <button
                    onClick={() => setEditing({ ...p })}
                    className="text-sm font-bold text-splash-600 hover:text-splash-700"
                  >
                    Edit
                  </button>
                </td>
              </tr>
            ))}
            {!rows.length && (
              <tr>
                <td className="td py-8 text-center text-slate-400" colSpan={6}>
                  No products match.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {editing && (
        <EditProductModal
          product={editing}
          busy={busy}
          onCancel={() => setEditing(null)}
          onSave={save}
        />
      )}
    </div>
  )
}

function EditProductModal({ product, busy, onCancel, onSave }) {
  const [p, setP] = useState(product)
  const perGal = num(p.price_per_ml) * GAL_TO_ML
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-slate-900/50" onClick={onCancel} />
      <div className="card fade-in relative w-full max-w-md p-6">
        <h3 className="mb-4 text-lg font-extrabold text-slate-900">
          {p.id ? 'Edit product' : 'New product'}
        </h3>
        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-bold text-slate-500">Name</label>
            <input className="input" value={p.name} onChange={(e) => setP({ ...p, name: e.target.value })} />
          </div>
          <div>
            <label className="mb-1 block text-xs font-bold text-slate-500">Description</label>
            <input
              className="input"
              value={p.description || ''}
              onChange={(e) => setP({ ...p, description: e.target.value })}
              placeholder="optional"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-bold text-slate-500">Price per ml ($)</label>
              <input
                type="number"
                step="any"
                className="input"
                value={p.price_per_ml}
                onChange={(e) => setP({ ...p, price_per_ml: e.target.value })}
              />
              <p className="mt-1 text-[11px] font-medium text-slate-400">
                = ${Number.isFinite(perGal) ? perGal.toFixed(2) : '0.00'} per gallon
              </p>
            </div>
            <div>
              <label className="mb-1 block text-xs font-bold text-slate-500">Unit type</label>
              <input
                className="input"
                value={p.unit_type || ''}
                onChange={(e) => setP({ ...p, unit_type: e.target.value })}
                placeholder='e.g. "5gal case"'
              />
            </div>
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button className="btn-ghost" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn-primary" disabled={busy || !p.name} onClick={() => onSave(p)}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

// --------------------------------------------------------------------------
// Bulk price update.
//
// The per-product modal above is the right tool for one product and the wrong
// tool for a vendor price letter, which moves thirty at once. This is the same
// list with the price cells made editable and a single Save.
//
// Two editable columns, $/gal and $/ml, because those are two ways of writing
// the same number and which one you have depends on where you got it: vendors
// quote per gallon, the database stores per ml. Typing in either recomputes the
// other, and the cell you typed in is the authoritative one — the value sent to
// the server is resolved straight from your text, never round-tripped through
// the other column's display formatting.
//
// One draft per product, carrying which unit it was typed in, so the units
// cannot fight. The consequence to know: typing in the OTHER cell replaces the
// draft rather than refining it, so a sub-cent $/ml edit followed by a keystroke
// in that row's $/gal cell is discarded in favour of the two-decimal figure. The
// Change column is the tell — it goes back to a dash.
//
// The precision rule is the load-bearing part. price_per_ml is a plain numeric
// carrying ~12 decimals (0.005969868522 is a real one). $/gal at two decimals
// and $/ml at six both hide digits, so *rendering a price and saving it back
// silently truncates it*. Three defences: the $/ml cell prefills at FULL stored
// precision rather than the .toFixed(6) the read-only table uses; a row only
// counts as changed if it differs at the precision it was typed in, so retyping
// what's on screen is a no-op; and only changed rows are sent. The server
// independently drops numeric no-ops as a fourth.
//
// Editing is tracked per product id, not per visible row, so the search box
// filters the view without discarding pending edits — and the change counter
// deliberately counts rows the filter is currently hiding.
// --------------------------------------------------------------------------

// Full stored precision, no trailing-zero noise. toPrecision(15) then back
// through Number() strips the float-repr fuzz (0.1+0.2 tails) without the
// truncation a fixed decimal count would cause. 15 rather than 17 because the
// stored numerics run to ~12 significant digits and the last two of a 17-digit
// round trip are the noise, not the price.
const mlText = (v) => (Number.isFinite(v) ? String(Number(v.toPrecision(15))) : '')

// Four decimals, not the two the read-only table shows.
//
// This column is both the display AND the comparison baseline — a row counts as
// changed only if it differs at this precision — so every digit dropped here
// becomes a band of real edits that are silently ignored. At two decimals that
// band is half a cent per gallon, which is small but not nothing, and the way it
// failed was ugly: the $/ml cell would repaint with the new number while the row
// stayed white and Save still read "No changes". Four decimals shrinks it to
// half a hundredth of a cent, far below any price a vendor quotes, and costs
// only two quiet trailing zeros on the usual case.
const galText = (v) => (Number.isFinite(v) ? (v * GAL_TO_ML).toFixed(4) : '')

function BulkPricesSection({ dataset, refresh, setToast }) {
  const [q, setQ] = useState('')
  const [sort, setSort] = useState({ key: 'name', dir: 'asc' })
  // { [productId]: { raw: string, unit: 'gal' | 'ml' } } — absence means untouched.
  const [drafts, setDrafts] = useState({})
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)

  // Memoised so `|| []` doesn't hand every downstream memo a brand-new array on
  // each render and defeat them.
  const products = useMemo(() => dataset.products || [], [dataset.products])

  // One pass over every product — not just the visible ones — producing the
  // display text for both cells plus whether the row counts as changed. The
  // submit set and the counter both read off this, so what you're told is
  // pending and what actually gets written can't drift apart.
  const state = useMemo(() => {
    const m = {}
    for (const p of products) {
      const stored = num(p.price_per_ml)
      const d = drafts[p.id]
      if (!d) {
        m[p.id] = { gal: galText(stored), ml: mlText(stored), stored, changed: false, invalid: false }
        continue
      }
      const n = Number(d.raw)
      const invalid = d.raw.trim() === '' || !Number.isFinite(n) || n < 0
      const resolved = invalid ? NaN : d.unit === 'gal' ? n / GAL_TO_ML : n
      // A row counts as changed only if the new price differs from the stored one
      // *at the precision the admin typed it in*.
      //
      // This is the guard against silent truncation, and a plain `resolved !==
      // stored` is not enough. $/gal is rounded for display; retyping "22.6" over
      // a displayed "22.6000" resolves to a per-ml value that is not
      // bit-identical to the 12-decimal number in the database, so a numeric test
      // would call that row edited and write away six digits of precision that
      // the admin never saw and did not intend to touch. Comparing the two
      // through the same formatter the admin was looking at asks the right
      // question: is this a different price, or the same price retyped?
      //
      // Typing in $/ml is exact for the same reason — mlText is full precision,
      // so there the comparison degenerates to equality, which is correct.
      const fmt = d.unit === 'gal' ? galText : mlText
      const changed = !invalid && fmt(resolved) !== fmt(stored)
      m[p.id] = {
        gal: d.unit === 'gal' ? d.raw : invalid ? '' : galText(resolved),
        ml: d.unit === 'ml' ? d.raw : invalid ? '' : mlText(resolved),
        stored,
        resolved,
        changed,
        invalid,
      }
    }
    return m
  }, [products, drafts])

  const changedIds = useMemo(
    () => products.filter((p) => state[p.id]?.changed).map((p) => p.id),
    [products, state]
  )
  const invalidCount = useMemo(
    () => products.filter((p) => state[p.id]?.invalid).length,
    [products, state]
  )
  // "Dirty" is changed OR invalid, and it's what the hidden-rows banner counts.
  // An invalid row is not in changedIds — it can't be saved — but it IS the
  // reason Save is disabled, so a filter that hides it while the rose banner
  // says "fix the highlighted prices" would strand the admin looking for a
  // highlight that isn't on screen.
  const dirtyIds = useMemo(
    () => products.filter((p) => state[p.id]?.changed || state[p.id]?.invalid).map((p) => p.id),
    [products, state]
  )

  const rows = useMemo(() => {
    let arr = products
    if (q) {
      const needle = q.toLowerCase()
      arr = arr.filter(
        (p) =>
          p.name.toLowerCase().includes(needle) ||
          (p.description || '').toLowerCase().includes(needle)
      )
    }
    const dir = sort.dir === 'asc' ? 1 : -1
    const val = (p) => (sort.key === 'price' ? num(p.price_per_ml) : p.name)
    return arr.slice().sort((a, b) => {
      const av = val(a), bv = val(b)
      if (typeof av === 'string') return dir * av.localeCompare(bv)
      return dir * (av - bv)
    })
  }, [products, q, sort])

  function edit(id, unit, raw) {
    setDrafts((prev) => ({ ...prev, [id]: { raw, unit } }))
  }
  function revert(id) {
    setDrafts((prev) => {
      const next = { ...prev }
      delete next[id]
      return next
    })
  }

  async function save() {
    setBusy(true)
    try {
      const prices = changedIds.map((id) => ({ id, price_per_ml: state[id].resolved }))
      const res = await bulkUpdateProductPrices(prices)
      await refresh()
      setDrafts({})
      // The server drops rows whose price didn't actually move, so a batch can
      // come back with nothing written. Reporting "0 products repriced" in a
      // green success toast reads as a bug; say what happened instead.
      setToast(
        res.updated
          ? {
              tone: 'success',
              title: 'Prices updated',
              message: `${fmtInt(res.updated)} product${res.updated === 1 ? '' : 's'} repriced.`,
            }
          : {
              tone: 'info',
              title: 'Nothing to change',
              message: 'Those prices already match what is stored.',
            }
      )
    } catch (e) {
      // Drafts are deliberately left intact on failure — the whole batch was
      // rejected server-side, so throwing away forty typed prices would be the
      // worst possible response to a single bad row.
      setToast({ tone: 'error', title: 'Could not save', message: e.message || String(e) })
    } finally {
      // Closed either way, so the toast isn't hidden behind the dialog.
      setConfirming(false)
      setBusy(false)
    }
  }

  const visibleIds = useMemo(() => new Set(rows.map((p) => p.id)), [rows])
  const hiddenDirty = dirtyIds.filter((id) => !visibleIds.has(id)).length

  return (
    <div className="card overflow-hidden" onKeyDown={(e) => handleGridEnter(e, e.currentTarget)}>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
        <SectionTitle>Bulk price update ({fmtInt(products.length)} products)</SectionTitle>
        <div className="flex items-center gap-2">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search products…"
            className="input w-56 py-1.5"
          />
          {/* Enabled on ANY draft, not just savable ones. A row blanked to
              invalid isn't in changedIds, and if the search box is also hiding
              its per-row Revert then a Reset gated on changedIds would leave no
              way out of the disabled-Save state at all. */}
          <button
            className="btn-ghost py-1.5 text-xs"
            disabled={busy || !Object.keys(drafts).length}
            onClick={() => setDrafts({})}
          >
            Reset
          </button>
          <button
            className="btn-primary py-1.5 text-xs"
            disabled={busy || !changedIds.length || invalidCount > 0}
            onClick={() => setConfirming(true)}
          >
            {changedIds.length
              ? `Save ${changedIds.length} price change${changedIds.length === 1 ? '' : 's'}`
              : 'No changes'}
          </button>
        </div>
      </div>

      <div className="space-y-3 px-5 pt-4">
        <Banner tone="slate" title="New prices apply going forward, not to past visits">
          Each visit records what its chemicals cost on the day it was filed, so repricing here
          changes visits filed from now on and leaves already-reported figures alone. Editing an
          old visit later &mdash; to fix a miscounted reservoir, say &mdash; keeps its original
          prices too.
        </Banner>
        {invalidCount > 0 && (
          <Banner tone="rose" title="Fix the highlighted prices">
            {invalidCount} row{invalidCount === 1 ? ' has' : 's have'} a blank or negative price.
            Clear or correct {invalidCount === 1 ? 'it' : 'them'} before saving.
          </Banner>
        )}
        {hiddenDirty > 0 && (
          <Banner tone="slate" title="Edits hidden by your search">
            {hiddenDirty} edited product{hiddenDirty === 1 ? ' is' : 's are'} filtered out of the list
            below. Clear the search to see {hiddenDirty === 1 ? 'it' : 'them'}.
          </Banner>
        )}
      </div>

      <div className="mt-4 max-h-[560px] overflow-auto">
        <table className="min-w-full divide-y divide-slate-100">
          <thead className="sticky top-0 z-10 bg-slate-50">
            <tr>
              <SortHeader label="Product" k="name" sort={sort} setSort={setSort} />
              <th className="th text-right">$ / gal</th>
              <th className="th text-right">$ / ml</th>
              <SortHeader label="Current $ / ml" k="price" sort={sort} setSort={setSort} align="right" />
              <th className="th text-right">Change</th>
              <th className="th" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((p) => {
              const s = state[p.id] || {}
              const pct =
                s.changed && s.stored > 0 ? ((s.resolved - s.stored) / s.stored) * 100 : null
              return (
                <tr
                  key={p.id}
                  className={
                    s.invalid ? 'bg-rose-50/70' : s.changed ? 'bg-amber-50/60' : 'hover:bg-slate-50/60'
                  }
                >
                  <td className="td font-semibold text-slate-900">
                    {p.name}
                    {p.unit_type && (
                      <span className="ml-2 text-[11px] font-medium text-slate-400">{p.unit_type}</span>
                    )}
                  </td>
                  <td className="td text-right">
                    <PriceInput
                      value={s.gal ?? ''}
                      onChange={(v) => edit(p.id, 'gal', v)}
                      col="gal"
                      invalid={s.invalid}
                    />
                  </td>
                  <td className="td text-right">
                    <PriceInput
                      value={s.ml ?? ''}
                      onChange={(v) => edit(p.id, 'ml', v)}
                      col="ml"
                      invalid={s.invalid}
                      width="w-36"
                    />
                  </td>
                  <td className="td text-right tabular-nums text-slate-400">
                    {num(p.price_per_ml).toFixed(6)}
                  </td>
                  <td className="td text-right tabular-nums">
                    {!s.changed ? (
                      <span className="text-slate-300">—</span>
                    ) : pct === null ? (
                      // Priced at zero until now, so a percentage is undefined
                      // rather than zero — say so instead of showing a dash that
                      // reads as "unchanged" on a row that is about to change.
                      <Pill tone="amber">new</Pill>
                    ) : (
                      <Pill tone={pct > 0 ? 'rose' : 'emerald'}>
                        {pct > 0 ? '+' : ''}
                        {pct.toFixed(1)}%
                      </Pill>
                    )}
                  </td>
                  <td className="td text-right">
                    {drafts[p.id] ? (
                      <button
                        onClick={() => revert(p.id)}
                        className="text-sm font-bold text-slate-400 hover:text-slate-700"
                      >
                        Revert
                      </button>
                    ) : null}
                  </td>
                </tr>
              )
            })}
            {!rows.length && (
              <tr>
                <td className="td py-8 text-center text-slate-400" colSpan={6}>
                  No products match.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <ConfirmDialog
        open={confirming}
        busy={busy}
        title={`Update ${changedIds.length} price${changedIds.length === 1 ? '' : 's'}?`}
        body="This also changes the reported chemical cost of every past visit that used these products."
        confirmLabel="Update prices"
        onCancel={() => setConfirming(false)}
        onConfirm={save}
      />
    </div>
  )
}

// A price cell. `col` opts it into Enter-walks-down (see lib/gridnav) — the
// whole point of this screen is typing a column of numbers off a vendor letter,
// which is the same motion as filling a site visit.
function PriceInput({ value, onChange, col, invalid, width = 'w-28' }) {
  return (
    <input
      type="number"
      inputMode="decimal"
      step="any"
      min="0"
      data-grid="prices"
      data-col={col}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onFocus={(e) => e.target.select()}
      className={`input ${width} py-1 text-right tabular-nums ${
        invalid ? 'border-rose-300 bg-rose-50' : ''
      }`}
    />
  )
}

// --------------------------------------------------------------------------
function RecipientsSection({ dataset, refresh, setToast }) {
  const [rows, setRows] = useState(() =>
    (dataset.notification_recipients || []).map((r) => ({
      ...r,
      deleted: false,
      allLocations: r.all_locations !== false,
      locationIds: (dataset.notification_recipient_locations || [])
        .filter((x) => x.recipient_id === r.id)
        .map((x) => x.location_id),
    }))
  )
  const [busy, setBusy] = useState(false)
  const [dirty, setDirty] = useState(false)
  const locations = dataset.locations || []

  function mutate(fn) {
    setRows((prev) => {
      const next = structuredClone(prev)
      fn(next)
      return next
    })
    setDirty(true)
  }

  async function save() {
    setBusy(true)
    try {
      const saved = await saveRecipients(rows)
      await refresh()
      setRows(saved.map((r) => ({ ...r, deleted: false })))
      setDirty(false)
      setToast({ tone: 'success', title: 'Saved', message: 'Recipient list updated.' })
    } catch (e) {
      setToast({ tone: 'error', title: 'Could not save', message: e.message || String(e) })
    } finally {
      setBusy(false)
    }
  }

  const visible = rows.filter((r) => !r.deleted)

  return (
    <div className="card overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
        <SectionTitle>Visit report emails</SectionTitle>
        <div className="flex items-center gap-2">
          <button
            className="btn-ghost py-1.5 text-xs"
            onClick={() =>
              mutate((r) =>
                r.push({ id: null, email: '', name: '', active: true, deleted: false, allLocations: true, locationIds: [] })
              )
            }
          >
            + Add recipient
          </button>
          <button className="btn-primary py-1.5 text-xs" disabled={busy || !dirty} onClick={save}>
            {busy ? 'Saving…' : dirty ? 'Save' : 'Saved'}
          </button>
        </div>
      </div>

      <div className="p-5">
        <Banner tone="blue" title="How report emails work">
          When a tech submits a site visit, everyone on this list gets the report by email.
          Delivery is handled server-side by the inventory worker&rsquo;s report webhook; until
          that webhook is configured, sends are recorded but not delivered.
        </Banner>

        <div className="mt-4 space-y-2">
          {rows.map((r, i) =>
            r.deleted ? null : (
              <div key={i} className="flex flex-wrap items-center gap-2">
                <input
                  className="input w-64"
                  type="email"
                  placeholder="email@splashcarwashes.com"
                  value={r.email}
                  onChange={(e) => mutate((rows2) => (rows2[i].email = e.target.value))}
                />
                <input
                  className="input w-44"
                  placeholder="Name (optional)"
                  value={r.name || ''}
                  onChange={(e) => mutate((rows2) => (rows2[i].name = e.target.value))}
                />
                <label className="flex items-center gap-1.5 text-xs font-semibold text-slate-500">
                  <input
                    type="checkbox"
                    checked={r.active !== false}
                    onChange={(e) => mutate((rows2) => (rows2[i].active = e.target.checked))}
                    className="h-4 w-4 rounded accent-splash-600"
                  />
                  active
                </label>
                <LocationPicker
                  locations={locations}
                  allLocations={r.allLocations}
                  selectedIds={r.locationIds}
                  label="sites"
                  onChange={({ allLocations, ids }) =>
                    mutate((rows2) => {
                      rows2[i].allLocations = allLocations
                      rows2[i].locationIds = ids
                    })
                  }
                />
                <button
                  onClick={() => mutate((rows2) => (rows2[i].deleted = true))}
                  className="text-slate-300 hover:text-rose-500"
                  title="Remove"
                >
                  ✕
                </button>
              </div>
            )
          )}
          {!visible.length && (
            <p className="text-sm text-slate-400">No recipients yet — add the people who should get visit reports.</p>
          )}
        </div>
      </div>
    </div>
  )
}
