import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import { apiGet } from '../lib/api'

// Auth is now delegated to the splash SSO session. On mount we ask the worker
// (/inventory/api/me) who we are; the worker reads the host-only
// sb-access-token cookie, checks the `inventory` tool grant, and returns the
// session's role + granted location_codes. No login form lives in this app
// anymore — an unauthenticated user is bounced to the splash login page.
const AuthContext = createContext(null)

// Deep-link preservation. /inventory/* is path-carved to this worker and never
// reaches apps/web's Next middleware, so nothing upstream builds the ?return=
// for us — the SPA has to do it itself.
//
// Two bugs used to live here. The param was `?next=`, but /login reads
// `?return=` (apps/web/app/login/page.tsx), so it was ignored and everyone
// landed on /admin/dashboard. And the target was the constant '/inventory', so
// even once the name was right, a deep link like /inventory/location/binghamton
// collapsed to the app root.
//
// The path is read at redirect time rather than module-eval time so a client-
// side route change is reflected — AuthContext mounts once, but a 401 can
// surface from any page after a session expires mid-session.
const HOME = '/inventory'

/** Current same-origin path + query, for handing back to the SSO login page. */
function currentPath() {
  if (typeof window === 'undefined') return HOME
  const { pathname, search } = window.location
  const path = `${pathname}${search || ''}`
  // Guard the degenerate case: bouncing from a non-/inventory path would be
  // rejected by the worker's allowlist anyway, so fall back to the app root.
  return pathname.startsWith(HOME) ? path : HOME
}

/** /login?return=<current path>. Must be `return` — the login page ignores anything else. */
function loginUrl() {
  return `/login?return=${encodeURIComponent(currentPath())}`
}

const LOGOUT_URL = `/logout?return=${encodeURIComponent(HOME)}`

// Demo mode is gone. Layout still destructures demoPersona/isDemo, so we keep
// inert defaults: isDemo=false hides the persona switcher entirely.
const DEMO_PERSONA = { role: 'admin', allLocations: true, locationIds: [] }

export function AuthProvider({ children }) {
  const [ready, setReady] = useState(false)
  const [me, setMe] = useState(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const data = await apiGet('/me')
        if (cancelled) return
        setMe(data)
        setReady(true)
      } catch (err) {
        if (cancelled) return
        if (err && err.status === 401) {
          // Not signed in — hand off to the splash SSO login page, carrying
          // the path the user actually asked for.
          window.location.href = loginUrl()
          return
        }
        // 403 (no inventory grant) or any other error: mark ready but not
        // authed so App can show a message instead of spinning forever.
        setReady(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const value = useMemo(() => {
    const authed = !!me && me.authenticated === true
    const role = me?.role || 'location_admin'
    const isAdmin = !!me?.isAdmin
    const canSubmit = me?.canSubmit !== false && authed
    const assignedIds = me?.locations || []
    const allLocations = isAdmin
    // null = unrestricted (sees every location); otherwise a Set of codes.
    const visibleLocationIds = isAdmin ? null : new Set(assignedIds)

    return {
      isDemo: false,
      ready,
      authed,
      email: me?.email ?? null,
      role,
      isAdmin,
      canSubmit,
      allLocations,
      assignedLocationIds: assignedIds,
      visibleLocationIds,
      // Sign-in/out are owned by the splash SSO pages. signIn is retained for
      // API compatibility (the old Login page called it) but just redirects.
      async signIn() {
        window.location.href = loginUrl()
        return { error: null }
      },
      async signOut() {
        window.location.href = LOGOUT_URL
      },
      // Demo persona switcher is disabled (isDemo=false keeps it hidden).
      demoPersona: DEMO_PERSONA,
      setDemoPersona() {
        /* no-op */
      },
    }
  }, [ready, me])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
