"use client";

// Global header - the white-script Splash logo on a dark splash-navy bar,
// rendered on EVERY page from the root layout.
//
// Path-aware admin controls:
//   - On /admin/* and /sysadmin/* the header additionally renders a user
//     identity row (email + role label) plus Dashboard + Change Password +
//     Sign Out buttons (matching the legacy /admin/* chrome - see Josh's
//     reference screenshots).
//   - On all other paths (/, /login, /change-password, /signup/*, etc.)
//     the header is logo-only.
//   - Logo-link target also flips: admin pages link the logo to
//     /admin/dashboard; everywhere else to /.
//
// Why a client component (vs. server with a route-group layout):
//   - Single-bar legacy parity requires the admin controls to live INSIDE
//     the same header bar that public pages also render. With root-layout-
//     owned chrome, that means the admin variant has to be decided by the
//     same component the root layout renders. usePathname() does it
//     declaratively in one place; route-group layouts would require
//     restructuring app/(public)/, app/(admin)/ and moving every existing
//     page file.
//   - usePathname() is SSR-safe in Next.js App Router (returns the current
//     pathname during the server render too), so there's no hydration
//     mismatch - the admin controls render identically on server and
//     client for any given URL.
//
// User identity (email + role label) — Brief 11a:
//   The root layout fetches /api/me from dashboard-worker via getMe() and
//   passes a `user` prop. When the prop is provided AND we're in admin
//   context, the header renders email + role label inline before the
//   buttons. When the prop is undefined (public page, or unauthenticated
//   in dev cross-origin), the header renders exactly as it did pre-11a.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ASSETS } from "@splash/storage-r2/assets";
import { SignOutButton } from "./SignOutButton";

// Match /admin, /admin/..., /sysadmin, /sysadmin/... - the two admin-context
// path families. Public surfaces (/, /login, /signup/*, /q/*, /join/*,
// /claims/*, /change-password) all fall through to logo-only chrome.
//
// `new RegExp(...)` rather than a regex literal - avoids TS-transpile-mode
// parser ambiguity in .tsx files where `/<...` looks like a JSX closing
// tag prefix to lightweight parsers. Real Next.js builds handle either
// form; the constructor form is unambiguous everywhere.
const ADMIN_PATH_RE = new RegExp("^/(admin|sysadmin)(/|$)");

export interface HeaderUser {
  email: string;
  /** "Super Admin" | "Location Admin" | (forward-compat fallback "Admin"). */
  roleLabel: string;
}

export interface HeaderProps {
  user?: HeaderUser;
}

export function Header({ user }: HeaderProps = {}) {
  const pathname = usePathname() ?? "";
  const isAdminContext = ADMIN_PATH_RE.test(pathname);
  const logoHref = isAdminContext ? "/admin/dashboard" : "/";

  return (
    <header className="flex w-full items-center justify-between bg-splash-navy px-6 py-3 shadow-splash-btn">
      <Link
        href={logoHref}
        className="flex items-center"
        aria-label="Splash MaxPass"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={ASSETS.logoWhite}
          alt="Splash Car Washes"
          className="h-10 w-auto"
        />
      </Link>
      {isAdminContext ? (
        <nav className="flex flex-wrap items-center justify-end gap-x-4 gap-y-2">
          {user ? (
            <div className="flex flex-col items-end leading-tight">
              <span className="text-sm text-white/90">{user.email}</span>
              <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-sudsy-blue">
                {user.roleLabel}
              </span>
            </div>
          ) : null}
          <div className="flex items-center gap-3">
            <Link
              href="/admin/dashboard"
              className="rounded-splash-sm border border-white/30 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-white/10"
            >
              Dashboard
            </Link>
            <Link
              href="/change-password"
              className="rounded-splash-sm border border-white/30 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-white/10"
            >
              Change Password
            </Link>
            <SignOutButton />
          </div>
        </nav>
      ) : null}
    </header>
  );
}
