import { useMemo, useState } from 'react'
import { useData } from '../context/DataContext'
import { useAuth } from '../context/AuthContext'
import { upsertProduct, saveRecipients } from '../lib/data'
import {
  PageHeader, SectionTitle, Banner, Toast, Pill, SortHeader, LocationPicker, EmptyState,
} from '../components/ui'
import { fmtInt, num } from '../lib/format'
import { GAL_TO_ML } from '../lib/calc'

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
