import { useMemo, useState } from 'react'
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useData } from '../context/DataContext'
import { LocationPicker } from './ui'
// Same brand assets every other worker uses (signup, forms, damage, web) so a
// logo change stays a one-file edit in packages/storage-r2/src/assets.ts.
// logoWhite is the script wordmark for dark backgrounds, logoBlue for light.
import { ASSETS } from '@splash/storage-r2/assets'

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
  const [closedSubs, setClosedSubs] = useState(() => new Set())
  const route = useLocation()

  // Two levels: manager -> region -> sites. A manager can span several RMs, and
  // the old flat shape hid that — it printed the FIRST location's region as the
  // group subtitle, so the other RMs' sites sat under a label that wasn't
  // theirs. Managers with exactly one region keep the subtitle and skip the
  // extra nesting, since a sub-header there would just be the subtitle again.
  const groups = useMemo(() => {
    let locs = (dataset?.locations || []).filter((l) => l.active !== false)
    if (visibleLocationIds) locs = locs.filter((l) => visibleLocationIds.has(l.id))
    const filtered = q
      ? locs.filter((l) => l.name.toLowerCase().includes(q.toLowerCase()))
      : locs

    const sortNames = (a, b) =>
      a === 'Unassigned' ? 1 : b === 'Unassigned' ? -1 : a.localeCompare(b)

    const byManager = new Map()
    for (const l of filtered) {
      const m = l.manager || 'Unassigned'
      const r = l.region || 'Unassigned'
      if (!byManager.has(m)) byManager.set(m, new Map())
      const regions = byManager.get(m)
      if (!regions.has(r)) regions.set(r, [])
      regions.get(r).push(l)
    }

    return [...byManager.keys()].sort(sortNames).map((manager) => {
      const regions = [...byManager.get(manager).keys()].sort(sortNames).map((region) => {
        const locations = byManager
          .get(manager)
          .get(region)
          .sort((a, b) => a.name.localeCompare(b.name))
        // rm_group is a display detail, never a grouping key — see db.ts. Take
        // it off whichever site has one; sites missing a public.locations row
        // simply don't carry it and shouldn't split the group.
        return { region, locations, group: locations.find((l) => l.region_group)?.region_group || null }
      })
      return {
        manager,
        regions,
        count: regions.reduce((n, r) => n + r.locations.length, 0),
        // Only meaningful as a subtitle when it describes the whole group.
        soleRegion:
          regions.length === 1 && regions[0].region !== 'Unassigned'
            ? regions[0].group
              ? `${regions[0].region} (${regions[0].group})`
              : regions[0].region
            : null
      }
    })
  }, [dataset, q, visibleLocationIds])

  const toggleSub = (key) =>
    setClosedSubs((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

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
                title={g.soleRegion || undefined}
              >
                <span className="min-w-0">
                  <span className="block truncate text-[11px] font-bold uppercase tracking-wider text-slate-300">
                    {g.manager}
                  </span>
                  {g.soleRegion && (
                    <span className="block truncate text-[10px] font-medium text-slate-500">
                      {g.soleRegion}
                    </span>
                  )}
                </span>
                <span className="flex shrink-0 items-center gap-1.5">
                  <span className="rounded-full bg-white/10 px-1.5 py-0.5 text-[10px] font-semibold text-slate-300">
                    {g.count}
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
                g.regions.map((sub) => {
                  const subKey = `${g.manager} ${sub.region}`
                  const nested = !g.soleRegion
                  const subOpen = !nested || q !== '' || !closedSubs.has(subKey)
                  return (
                    <div key={subKey}>
                      {nested && (
                        <button
                          type="button"
                          onClick={() => toggleSub(subKey)}
                          className="ml-2 flex w-[calc(100%-0.5rem)] items-center justify-between rounded-lg px-3 py-1 text-left hover:bg-white/5"
                        >
                          <span className="truncate text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                            {sub.region}
                            {sub.group && (
                              <span className="ml-1 font-normal text-slate-500">({sub.group})</span>
                            )}
                          </span>
                          <span className="flex shrink-0 items-center gap-1.5">
                            <span className="text-[10px] font-semibold text-slate-500">
                              {sub.locations.length}
                            </span>
                            <svg
                              className={`h-2.5 w-2.5 text-slate-500 transition-transform ${subOpen ? 'rotate-90' : ''}`}
                              viewBox="0 0 12 12"
                              fill="currentColor"
                            >
                              <path d="M4 2l4 4-4 4V2z" />
                            </svg>
                          </span>
                        </button>
                      )}
                      {subOpen &&
                        sub.locations.map((l) => {
                          const active = route.pathname.startsWith(`/location/${l.id}`)
                          return (
                            <Link
                              key={l.id}
                              to={`/location/${l.id}`}
                              onClick={onNavigate}
                              className={`sidebar-link py-1.5 ${nested ? 'ml-4' : 'ml-2'} ${active ? 'sidebar-link-active' : ''}`}
                            >
                              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-splash-300/70" />
                              <span className="truncate">{l.name}</span>
                            </Link>
                          )
                        })}
                    </div>
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
      {/* The real wordmark replaces the placeholder "S" tile. It already reads
          "Splash", so the text beside it collapses to just the app name —
          keeping both would print the brand twice. Stacked rather than
          side-by-side because the script logo is wide and the sidebar is
          288px. */}
      <Link to="/" onClick={onNavigate} className="block px-5 py-5">
        <img
          src={ASSETS.logoWhite}
          alt="Splash Car Washes"
          className="h-11 w-auto object-contain object-left"
        />
        <div className="mt-1.5 text-[10px] font-bold uppercase tracking-[0.14em] text-splash-300">
          Chemical Inventory
        </div>
      </Link>

      {/* Way back out to the tools hub.

          A plain <a>, not a <Link>, and that is not a style choice: the router is
          mounted with basename="/inventory" (main.jsx), so <Link to="/admin/dashboard">
          would resolve to /inventory/admin/dashboard and 404 against this worker's
          assets. This has to be a real navigation because /admin/dashboard is a
          different worker entirely — same origin, so the SSO cookie rides along and
          the user lands signed in.

          /admin/dashboard rather than /admin because there is no bare /admin page;
          it's DEFAULT_AUTHED_LANDING in apps/web/middleware.ts, i.e. the same place
          login sends you. */}
      <div className="px-3 pb-3">
        <a
          href="/admin/dashboard"
          className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-bold text-slate-300 transition hover:bg-white/10 hover:text-white"
        >
          <svg className="h-3.5 w-3.5 shrink-0" viewBox="0 0 20 20" fill="currentColor">
            <path
              fillRule="evenodd"
              d="M12.707 5.293a1 1 0 010 1.414L9.414 10l3.293 3.293a1 1 0 01-1.414 1.414l-4-4a1 1 0 010-1.414l4-4a1 1 0 011.414 0z"
              clipRule="evenodd"
            />
          </svg>
          Splash Tools
        </a>
      </div>

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
        {/* Blue variant here — this bar is white, and the white wordmark would
            be invisible on it. */}
        <Link to="/" className="flex min-w-0 items-center gap-2">
          <img
            src={ASSETS.logoBlue}
            alt="Splash Car Washes"
            className="h-7 w-auto shrink-0 object-contain"
          />
          <span className="truncate text-sm font-bold text-slate-900">Chemical Inventory</span>
        </Link>
        {/* Same escape hatch as the sidebar's — repeated here because on mobile
            the sidebar is behind the hamburger, and "get me out of this app" is
            not something to make someone open a drawer for. Right-aligned so it
            never squeezes the wordmark. */}
        <a
          href="/admin/dashboard"
          className="ml-auto shrink-0 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-bold text-slate-600 hover:bg-slate-50"
        >
          Splash Tools
        </a>
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
