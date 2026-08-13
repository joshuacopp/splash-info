"use client";

// Sliding-session keepalive (Phase 1). Silently pings the dashboard-worker's
// POST /api/refresh so an open session never hits the 1-hour access-token
// wall. The worker trades the sb-refresh-token cookie for a fresh access+
// refresh pair and re-sets both cookies; GoTrue preserves AAL, so an MFA'd
// (aal2) session stays MFA'd across refreshes — no re-2FA while a tab is open.
//
// Two triggers:
//   1. A timer every REFRESH_INTERVAL_MS (< the 1-hour token life, with margin)
//      — keeps foreground AND idle-with-tab-open sessions alive.
//   2. tab-refocus (visibilitychange → visible) — catches the case where the
//      browser throttled/froze a background tab and the timer was paused;
//      clicking back in refreshes before the next navigation.
//
// Only rendered for authenticated sessions (layout gates on session presence),
// so it never pings on public pages like /login.
//
// Single-flighted + min-interval throttled so rapid tab switches or an overlap
// with the timer can't fire two concurrent refreshes — that would race
// GoTrue's refresh-token rotation and could spuriously invalidate the session.

import { useEffect, useRef } from "react";

// 45 min: comfortably inside the 1-hour access-token life, leaving a 15-min
// margin so a slightly-late timer (throttled tab) still lands before expiry.
const REFRESH_INTERVAL_MS = 45 * 60 * 1000;
// Don't refresh more than once per 5 min regardless of trigger — bounds
// rotation churn when a user rapidly switches tabs.
const MIN_REFRESH_GAP_MS = 5 * 60 * 1000;

export function SessionKeepalive() {
  const inFlight = useRef(false);
  const lastRefresh = useRef(0);
  const stopped = useRef(false);

  useEffect(() => {
    const refresh = async () => {
      if (stopped.current || inFlight.current) return;
      if (Date.now() - lastRefresh.current < MIN_REFRESH_GAP_MS) return;
      inFlight.current = true;
      try {
        const r = await fetch("/api/refresh", {
          method: "POST",
          credentials: "include",
          // No body; the refresh token rides in the cookie. Header keeps the
          // worker's isOriginAllowed check happy without a preflight.
          headers: { "Content-Type": "application/x-www-form-urlencoded" }
        });
        if (r.ok) {
          lastRefresh.current = Date.now();
        } else if (r.status === 401) {
          // Refresh token expired/revoked — session is genuinely over. Stop
          // pinging; the user's next navigation falls through to /login.
          stopped.current = true;
        }
        // Other statuses (transient worker error): leave lastRefresh alone so
        // the next tick retries.
      } catch {
        // Network blip — swallow; the next tick retries.
      } finally {
        inFlight.current = false;
      }
    };

    const interval = window.setInterval(refresh, REFRESH_INTERVAL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  return null;
}
