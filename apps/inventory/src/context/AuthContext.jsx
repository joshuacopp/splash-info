import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import { apiGet } from '../lib/api'

// Auth is now delegated to the splash SSO session. On mount we ask the worker
// (/inventory/api/me) who we are; the worker reads the host-only
// sb-access-token cookie, checks the `inventory` tool grant, and returns the
// session's role + granted location_codes. No login form lives in this app
// anymore — an unauthenticated user is bounced to the splash login page.
const AuthContext = createContext(null)

const NEXT = encodeURIComponent('/inventory')
const LOGIN_URL = `/login?next=${NEXT}`
const LOGOUT_URL = `/logout?return=${NEXT}`

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
          // Not signed in — hand off to the splash SSO login page.
          window.location.href = LOGIN_URL
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
        window.location.href = LOGIN_URL
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
