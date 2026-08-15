import { useMemo, useState } from 'react'
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useData } from '../context/DataContext'
import { LocationPicker } from './ui'

const ROLE_LABEL = { viewer: 'Viewer', editor: 'Editor', admin: 'Admin' }

function DemoPersonaSwitcher() {
  const { demoPersona, setDemoPersona } = useAuth()
  const { dataset } = useData()
  const [open, setOpen] = useState(false)
  const locations = dataset?.locations || []

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-left hover:bg-white/10"
      >
        <span>
          <span className="block text-[10px] font-bold uppercase tracking-wider text-slate-400">
            Previewing as
          </span>
          <span className="block text-sm font-bold text-white">{ROLE_LABEL[demoPersona.role]}</span>
        </span>
        <span className="text-slate-400">▾</span>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="fade-in absolute bottom-full left-0 z-50 mb-2 w-64 rounded-2xl border border-slate-200 bg-white p-3 shadow-2xl">
            <div className="mb-2 text-[11px] font-bold uppercase tracking-wide text-slate-400">Role</div>
            <div className="mb-3 flex gap-1">
              {['viewer', 'editor', 'admin'].map((r) => (
                <button
                  key={r}
                  onClick={() => setDemoPersona({ ...demoPersona, role: r })}
                  className={`flex-1 rounded-lg px-2 py-1.5 text-xs font-bold ${
                    demoPersona.role === r ? 'bg-splash-600 text-white' : 'bg-slate-100 text-slate-600'
                  }`}
                >
                  {ROLE_LABEL[r]}
                </button>
              ))}
            </div>
            {demoPersona.role !== 'admin' && (
              <>
                <div className="mb-1 text-[11px] font-bold uppercase tracking-wide text-slate-400">
                  Visible sites
                </div>
                <LocationPicker
                  locations={locations}
                  allLocations={demoPersona.allLocations}
                  selectedIds={demoPersona.locationIds}
                  label="sites"
                  onChange={({ allLocations, ids }) =>
                    setDemoPersona({ ...demoPersona, allLocations, locationIds: ids })
                  }
                />
              </>
            )}
          </div>
        </>
      )}
    </div>
  )
}

function SidebarLocations({ onNavigate }) {
  const { dataset } = useData()
  const { visibleLocationIds } = useAuth()
  const [q, setQ] = useState('')
  const [openRegion, setOpenRegion] = useState(null)
  const route = useLocation()

  const groups = useMemo(() => {
    let locs = (dataset?.locations || []).filter((l) => l.active !== false)
    if (visibleLocationIds) locs = locs.filter((l) => visibleLocationIds.has(l.id))
    const filtered = q
      ? locs.filter((l) => l.name.toLowerCase().includes(q.toLowerCase()))
      : locs
    const byManager = {}
    for (const l of filtered) {
      const m = l.manager || 'Unassigned'
      ;(byManager[m] ||= { locations: [], region: l.region }).locations.push(l)
    }
    for (const g of Object.values(byManager)) g.locations.sort((a, b) => a.name.localeCompare(b.name))
    const keys = Object.keys(byManager).sort((a, b) =>
      a === 'Unassigned' ? 1 : b === 'Unassigned' ? -1 : a.localeCompare(b)
    )
    return keys.map((k) => ({ manager: k, region: byManager[k].region, locations: byManager[k].locations }))
  }, [dataset, q, visibleLocationIds])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="px-3 pb-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search locations…"
          className="w-full rounded-xl border border-white/10 bg-white/10 px-3 py-2 text-sm text-white outline-none placeholder:text-slate-400 focus:border-splash-300/50 focus:bg-white/15"
        />
      </div>
      <nav className="min-h-0 flex-1 space-y-1 overflow-y-auto px-3 pb-4">
        {groups.map((g) => {
          const expanded = q !== '' || openRegion === g.manager || groups.length === 1
          return (
            <div key={g.manager}>
              <button
                type="button"
                onClick={() => setOpenRegion(expanded && !q ? null : g.manager)}
                className="flex w-full items-center justify-between rounded-lg px-3 py-1.5 text-left hover:bg-white/5"
                title={g.region || undefined}
              >
                <span className="min-w-0">
                  <span className="block truncate text-[11px] font-bold uppercase tracking-wider text-slate-300">
                    {g.manager}
                  </span>
                  {g.region && (
                    <span className="block truncate text-[10px] font-medium text-slate-500">{g.region}</span>
                  )}
                </span>
                <span className="flex shrink-0 items-center gap-1.5">
                  <span className="rounded-full bg-white/10 px-1.5 py-0.5 text-[10px] font-semibold text-slate-300">
                    {g.locations.length}
                  </span>
                  <svg
                    className={`h-3 w-3 transition-transform ${expanded ? 'rotate-90' : ''}`}
                    viewBox="0 0 12 12"
                    fill="currentColor"
                  >
                    <path d="M4 2l4 4-4 4V2z" />
                  </svg>
                </span>
              </button>
              {expanded &&
                g.locations.map((l) => {
                  const active = route.pathname.startsWith(`/location/${l.id}`)
                  return (
                    <Link
                      key={l.id}
                      to={`/location/${l.id}`}
                      onClick={onNavigate}
                      className={`sidebar-link ml-2 py-1.5 ${active ? 'sidebar-link-active' : ''}`}
                    >
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-splash-300/70" />
                      <span className="truncate">{l.name}</span>
                    </Link>
                  )
                })}
            </div>
          )
        })}
        {!groups.length && (
          <p className="px-3 py-2 text-xs text-slate-400">No locations match.</p>
        )}
      </nav>
    </div>
  )
}

function SidebarContent({ onNavigate }) {
  const { email, isDemo, signOut, isAdmin } = useAuth()
  return (
    <div className="flex h-full min-h-0 flex-col">
      <Link to="/" onClick={onNavigate} className="flex items-center gap-3 px-5 py-5">
        <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-gradient-to-br from-splash-300 to-splash-600 text-lg font-black text-white shadow-lg">
          S
        </div>
        <div className="leading-tight">
          <div className="text-[15px] font-extrabold tracking-tight text-white">Splash</div>
          <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-splash-300">
            Chemical Inventory
          </div>
        </div>
      </Link>

      <div className="px-3 pb-2">
        <NavLink
          to="/"
          end
          onClick={onNavigate}
          className={({ isActive }) => `sidebar-link ${isActive ? 'sidebar-link-active' : ''}`}
        >
          <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
            <path d="M2 4a2 2 0 012-2h4v8H2V4zm10-2h4a2 2 0 012 2v4h-6V2zM2 12h6v6H4a2 2 0 01-2-2v-4zm10 0h6v4a2 2 0 01-2 2h-4v-6z" />
          </svg>
          Master Dashboard
        </NavLink>
        <NavLink
          to="/inventory"
          onClick={onNavigate}
          className={({ isActive }) => `sidebar-link ${isActive ? 'sidebar-link-active' : ''}`}
        >
          <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
            <path d="M3 4a1 1 0 011-1h12a1 1 0 011 1v2a1 1 0 01-1 1H4a1 1 0 01-1-1V4zm0 6a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H4a1 1 0 01-1-1v-6zm10 0a1 1 0 011-1h2a1 1 0 011 1v6a1 1 0 01-1 1h-2a1 1 0 01-1-1v-6z" />
          </svg>
          Inventory
        </NavLink>
        <NavLink
          to="/attention"
          onClick={onNavigate}
          className={({ isActive }) => `sidebar-link ${isActive ? 'sidebar-link-active' : ''}`}
        >
          <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
            <path
              fillRule="evenodd"
              d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z"
              clipRule="evenodd"
            />
          </svg>
          Attention
        </NavLink>
        {isAdmin && (
          <NavLink
            to="/admin"
            onClick={onNavigate}
            className={({ isActive }) => `sidebar-link ${isActive ? 'sidebar-link-active' : ''}`}
          >
            <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
              <path
                fillRule="evenodd"
                d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.53 1.53 0 01-2.29.95c-1.37-.84-2.94.73-2.1 2.1.51.83.06 1.94-.95 2.29-1.56.38-1.56 2.6 0 2.98 1.01.35 1.46 1.46.95 2.29-.84 1.37.73 2.94 2.1 2.1a1.53 1.53 0 012.29.95c.38 1.56 2.6 1.56 2.98 0a1.53 1.53 0 012.29-.95c1.37.84 2.94-.73 2.1-2.1a1.53 1.53 0 01.95-2.29c1.56-.38 1.56-2.6 0-2.98a1.53 1.53 0 01-.95-2.29c.84-1.37-.73-2.94-2.1-2.1a1.53 1.53 0 01-2.29-.95zM10 13a3 3 0 100-6 3 3 0 000 6z"
                clipRule="evenodd"
              />
            </svg>
            Admin
          </NavLink>
        )}
      </div>

      <div className="mx-5 mb-2 border-t border-white/10" />
      <div className="px-5 pb-1 text-[11px] font-bold uppercase tracking-wider text-slate-500">
        Locations
      </div>

      <SidebarLocations onNavigate={onNavigate} />

      <div className="border-t border-white/10 px-5 py-3">
        {isDemo ? (
          <DemoPersonaSwitcher />
        ) : (
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-xs text-slate-400">{email}</span>
            <button
              onClick={signOut}
              className="rounded-lg px-2 py-1 text-xs font-semibold text-slate-300 hover:bg-white/10 hover:text-white"
            >
              Sign out
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

export default function Layout() {
  const [mobileOpen, setMobileOpen] = useState(false)

  return (
    <div className="flex min-h-full">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-72 flex-col bg-gradient-to-b from-[#0c2b52] via-[#0e3565] to-[#134b8e] lg:flex">
        <SidebarContent />
      </aside>

      {/* Mobile top bar + drawer */}
      <div className="fixed inset-x-0 top-0 z-30 flex items-center gap-3 border-b border-slate-200 bg-white/90 px-4 py-3 backdrop-blur lg:hidden">
        <button
          onClick={() => setMobileOpen(true)}
          className="rounded-lg border border-slate-200 p-2 text-slate-600"
          aria-label="Open menu"
        >
          <svg className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
            <path
              fillRule="evenodd"
              d="M3 5a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 5a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 5a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1z"
              clipRule="evenodd"
            />
          </svg>
        </button>
        <Link to="/" className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-splash-600 text-xs font-black text-white">
            S
          </div>
          <span className="text-sm font-bold text-slate-900">Splash Inventory</span>
        </Link>
      </div>
      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-slate-900/50" onClick={() => setMobileOpen(false)} />
          <aside className="absolute inset-y-0 left-0 flex w-72 flex-col bg-gradient-to-b from-[#0c2b52] via-[#0e3565] to-[#134b8e]">
            <SidebarContent onNavigate={() => setMobileOpen(false)} />
          </aside>
        </div>
      )}

      <main className="min-w-0 flex-1 px-4 pb-12 pt-16 lg:ml-72 lg:px-8 lg:pt-8">
        <div className="mx-auto max-w-[1440px]">
          <Outlet />
        </div>
      </main>
    </div>
  )
}
