import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { NavLink } from 'react-router-dom'

export function KpiCard({ label, value, sub, tone = 'default', icon }) {
  const tones = {
    default: 'text-slate-900',
    good: 'text-emerald-600',
    warn: 'text-amber-600',
    bad: 'text-rose-600',
    brand: 'text-splash-600',
  }
  return (
    <div className="card fade-in relative overflow-hidden p-5">
      <div className="absolute -right-4 -top-4 h-20 w-20 rounded-full bg-gradient-to-br from-splash-50 to-transparent" />
      <div className="relative">
        <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-400">
          {icon}
          {label}
        </div>
        <div className={`mt-1.5 text-[26px] font-extrabold leading-none tracking-tight ${tones[tone] || tones.default}`}>
          {value}
        </div>
        {sub != null && <div className="mt-1.5 text-xs font-medium text-slate-400">{sub}</div>}
      </div>
    </div>
  )
}

export function Banner({ tone = 'amber', title, children }) {
  const tones = {
    amber: 'border-amber-200/80 bg-amber-50 text-amber-900',
    rose: 'border-rose-200/80 bg-rose-50 text-rose-900',
    blue: 'border-splash-100 bg-splash-50 text-splash-700',
    slate: 'border-slate-200 bg-slate-50 text-slate-700',
    emerald: 'border-emerald-200/80 bg-emerald-50 text-emerald-900',
  }
  return (
    <div className={`fade-in rounded-2xl border p-4 ${tones[tone] || tones.amber}`}>
      {title && <div className="mb-1 text-sm font-bold">{title}</div>}
      <div className="text-sm">{children}</div>
    </div>
  )
}

export function Pill({ tone = 'slate', children }) {
  const tones = {
    slate: 'bg-slate-100 text-slate-600',
    amber: 'bg-amber-100 text-amber-700',
    rose: 'bg-rose-100 text-rose-700',
    emerald: 'bg-emerald-100 text-emerald-700',
    blue: 'bg-splash-100 text-splash-700',
  }
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-bold ${tones[tone] || tones.slate}`}
    >
      {children}
    </span>
  )
}

export function Spinner({ label = 'Loading…' }) {
  return (
    <div className="flex items-center justify-center gap-3 p-20 text-slate-500">
      <div className="h-5 w-5 animate-spin rounded-full border-2 border-slate-300 border-t-splash-600" />
      <span className="text-sm font-medium">{label}</span>
    </div>
  )
}

export function SectionTitle({ children, right }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3">
      <h2 className="text-[12px] font-bold uppercase tracking-wider text-slate-400">{children}</h2>
      {right}
    </div>
  )
}

export function EmptyState({ children }) {
  return <div className="card p-10 text-center text-sm text-slate-500">{children}</div>
}

export function PageHeader({ eyebrow, title, sub, actions }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {eyebrow && (
          <div className="mb-0.5 text-[11px] font-bold uppercase tracking-[0.14em] text-splash-600">
            {eyebrow}
          </div>
        )}
        <h1 className="truncate text-2xl font-extrabold tracking-tight text-slate-900">{title}</h1>
        {sub && <p className="mt-0.5 text-sm text-slate-500">{sub}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  )
}

export function TabNav({ tabs }) {
  return (
    <div className="flex flex-wrap gap-1 rounded-2xl border border-slate-200 bg-white p-1 shadow-sm">
      {tabs.map((t) => (
        <NavLink
          key={t.to}
          to={t.to}
          end={t.end}
          className={({ isActive }) =>
            `rounded-xl px-4 py-2 text-sm font-semibold transition ${
              isActive ? 'bg-splash-600 text-white shadow' : 'text-slate-600 hover:bg-slate-100'
            }`
          }
        >
          {t.label}
        </NavLink>
      ))}
    </div>
  )
}

export function SortHeader({ label, k, sort, setSort, align = 'left' }) {
  const active = sort.key === k
  return (
    <th
      className={`th cursor-pointer select-none ${align === 'right' ? 'text-right' : ''}`}
      onClick={() => setSort({ key: k, dir: active && sort.dir === 'desc' ? 'asc' : 'desc' })}
    >
      <span className={`inline-flex items-center gap-1 ${active ? 'text-splash-600' : ''}`}>
        {label}
        <span className="text-[9px]">{active ? (sort.dir === 'asc' ? '▲' : '▼') : ''}</span>
      </span>
    </th>
  )
}

export function Toast({ toast, onDismiss }) {
  if (!toast) return null
  const tones = {
    success: 'border-emerald-200 bg-white text-emerald-800',
    error: 'border-rose-200 bg-white text-rose-800',
    info: 'border-splash-100 bg-white text-splash-700',
  }
  return (
    <div className="fixed bottom-6 right-6 z-50 fade-in">
      <div
        className={`flex max-w-md items-start gap-3 rounded-2xl border p-4 shadow-xl ${tones[toast.tone] || tones.info}`}
      >
        <div className="text-sm">
          {toast.title && <div className="font-bold">{toast.title}</div>}
          <div>{toast.message}</div>
        </div>
        <button onClick={onDismiss} className="ml-2 text-slate-400 hover:text-slate-600">
          ✕
        </button>
      </div>
    </div>
  )
}

// Button that opens a searchable checkbox popover for picking specific
// locations, plus an "all locations" toggle. Shared by the demo persona
// switcher, Users admin, and per-site email recipients.
//
// The panel renders through a portal into document.body and is positioned
// with `fixed` coordinates computed from the button's own position — this
// is deliberate, not decorative: any consuming page can freely wrap this in
// a card with `overflow-hidden` (most table/card containers do, to clip
// square corners) without the popover getting clipped, since it's no
// longer a DOM descendant of that container.
export function LocationPicker({ locations, allLocations, selectedIds, onChange, label = 'sites' }) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [pos, setPos] = useState(null)
  const btnRef = useRef(null)
  const selected = useMemo(() => new Set(selectedIds || []), [selectedIds])

  useEffect(() => {
    if (!open || !btnRef.current) return
    const r = btnRef.current.getBoundingClientRect()
    const panelH = 320
    const openUp = window.innerHeight - r.bottom < panelH && r.top > panelH
    setPos({
      left: Math.max(8, Math.min(r.right - 288, window.innerWidth - 296)),
      top: openUp ? undefined : r.bottom + 6,
      bottom: openUp ? window.innerHeight - r.top + 6 : undefined,
    })
  }, [open])

  const filtered = useMemo(() => {
    const arr = locations.slice().sort((a, b) => a.name.localeCompare(b.name))
    if (!q) return arr
    return arr.filter((l) => l.name.toLowerCase().includes(q.toLowerCase()))
  }, [locations, q])

  function toggle(id) {
    const next = new Set(selected)
    next.has(id) ? next.delete(id) : next.add(id)
    onChange({ allLocations: false, ids: [...next] })
  }

  const summary = allLocations
    ? `All ${label}`
    : selected.size === 0
      ? `No ${label} selected`
      : `${selected.size} ${label}`

  return (
    <>
      <button ref={btnRef} type="button" onClick={() => setOpen((v) => !v)} className="btn-ghost py-1.5 text-xs">
        {summary} <span className="text-slate-400">▾</span>
      </button>
      {open &&
        pos &&
        createPortal(
          <>
            <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
            <div
              className="fade-in fixed z-50 w-72 rounded-2xl border border-slate-200 bg-white p-3 shadow-xl"
              style={{ left: pos.left, top: pos.top, bottom: pos.bottom }}
            >
              <label className="mb-2 flex items-center gap-2 rounded-lg bg-slate-50 px-2 py-1.5 text-xs font-bold text-slate-600">
                <input
                  type="checkbox"
                  checked={allLocations}
                  onChange={(e) => onChange({ allLocations: e.target.checked, ids: [...selected] })}
                  className="h-4 w-4 rounded accent-splash-600"
                />
                All locations
              </label>
              {!allLocations && (
                <>
                  <input
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder="Search…"
                    className="input mb-2 py-1.5 text-xs"
                    autoFocus
                  />
                  <div className="max-h-56 space-y-0.5 overflow-y-auto">
                    {filtered.map((l) => (
                      <label
                        key={l.id}
                        className="flex items-center gap-2 rounded-lg px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                      >
                        <input
                          type="checkbox"
                          checked={selected.has(l.id)}
                          onChange={() => toggle(l.id)}
                          className="h-3.5 w-3.5 rounded accent-splash-600"
                        />
                        <span className="truncate">{l.name}</span>
                      </label>
                    ))}
                    {!filtered.length && <p className="px-2 py-1 text-xs text-slate-400">No matches.</p>}
                  </div>
                </>
              )}
            </div>
          </>,
          document.body
        )}
    </>
  )
}

export function ConfirmDialog({ open, title, body, confirmLabel = 'Confirm', danger, busy, onConfirm, onCancel }) {
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-slate-900/50" onClick={onCancel} />
      <div className="card fade-in relative w-full max-w-sm p-6">
        <h3 className="text-lg font-extrabold text-slate-900">{title}</h3>
        {body && <p className="mt-2 text-sm text-slate-500">{body}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button className="btn-ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button className={danger ? 'btn-danger' : 'btn-primary'} onClick={onConfirm} disabled={busy}>
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

export function Delta({ value, goodWhenNegative = true, fmt }) {
  if (value == null || !Number.isFinite(value) || Math.abs(value) < 0.005) {
    return <span className="text-[11px] font-semibold text-slate-300">–</span>
  }
  const up = value > 0
  const good = goodWhenNegative ? !up : up
  return (
    <span
      className={`inline-flex items-center gap-0.5 text-[11px] font-bold ${
        good ? 'text-emerald-600' : 'text-rose-500'
      }`}
    >
      {up ? '▲' : '▼'} {fmt ? fmt(Math.abs(value)) : Math.abs(value).toFixed(1)}
    </span>
  )
}
