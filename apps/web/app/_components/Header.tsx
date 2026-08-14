"use client";

// Global header - the white-script Splash logo on a dark splash-navy bar,
// rendered on EVERY page from the root layout.
//
// Path-aware admin controls:
//   - On /admin/*, /sysadmin/*, /workorders/*, and /forms (the apps/web
//     index added in Brief 99) the header additionally renders a user
//     identity row (email + role label, with a small "Change password"
//     text link beneath the role badge) plus Dashboard + Sign Out
//     buttons. /workorders was added to the gate in Brief 77 — Brief 70
//     introduced it as a top-level route (intentionally outside
//     /admin/*) and the gate hadn't been updated. /forms was added in
//     Brief 99 as the credentialed-user discovery surface for internal
//     forms; /forms/{slug} (the public render) is served by splash-forms
//     worker and never sees this Header.
//   - "Change Password" is intentionally a small text link rather than a
//     third button (Brief 77): it's a low-frequency action (once per ~90
//     days or after a forced reset) and the third button was crushing the
//     logo at iPhone widths (operator screenshot 2026-05-08).
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
import type { MfaEnrollmentStatus } from "@splash/types/session";
import { SignOutButton } from "./SignOutButton";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
];

/** Format an ISO "YYYY-MM-DD" deadline as "August 28, 2026" without going
 *  through `new Date()` — parsing a date-only string as UTC then formatting in
 *  local time can slip a day. Split the parts and format directly. */
function formatDeadline(iso: string): string {
  const [y, m, d] = iso.split("-").map((n) => parseInt(n, 10));
  const month = MONTHS[(m ?? 1) - 1] ?? "";
  return `${month} ${d}, ${y}`;
}

// Match /admin, /admin/..., /sysadmin, /sysadmin/..., /workorders,
// /workorders/..., /forms, /forms/... - the four admin-context path
// families. Public surfaces (/, /login, /signup/*, /q/*, /join/*,
// /claims/*, /change-password) all fall through to logo-only chrome.
//
// Note: /forms/{slug} (the public form render) is served by splash-forms
// worker, not apps/web — this regex only ever runs on apps/web-rendered
// pages, so including `forms` here is safe and only affects the apps/web
// `/forms` index page added in Brief 99.
//
// `new RegExp(...)` rather than a regex literal - avoids TS-transpile-mode
// parser ambiguity in .tsx files where `/<...` looks like a JSX closing
// tag prefix to lightweight parsers. Real Next.js builds handle either
// form; the constructor form is unambiguous everywhere.
const ADMIN_PATH_RE = new RegExp("^/(admin|sysadmin|workorders|forms)(/|$)");

export interface HeaderUser {
  email: string;
  /** "Super Admin" | "Location Admin" | (forward-compat fallback "Admin"). */
  roleLabel: string;
}

export interface HeaderProps {
  user?: HeaderUser;
  /** MFA enrollment countdown, forwarded from the root layout's session.
   *  When present + `required`, a banner nudges the user to enroll. Undefined
   *  when the policy is off or the user already has a verified factor. */
  mfaEnrollment?: MfaEnrollmentStatus;
}

export function Header({ user, mfaEnrollment }: HeaderProps = {}) {
  const pathname = usePathname() ?? "";
  const isAdminContext = ADMIN_PATH_RE.test(pathname);
  const logoHref = isAdminContext ? "/admin/dashboard" : "/";

  // Show the countdown for an authenticated user who still needs to enroll,
  // everywhere except the enrollment page itself (no point nagging them while
  // they're already there).
  const showMfaBanner =
    !!user && !!mfaEnrollment?.required && !pathname.startsWith("/mfa/enroll");

  return (
    <>
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
              <Link
                href="/change-password"
                className="text-xs text-white/70 hover:text-white hover:underline"
              >
                Change password
              </Link>
            </div>
          ) : null}
          <div className="flex items-center gap-3">
            <Link
              href="/admin/dashboard"
              className="rounded-splash-sm border border-white/30 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-white/10"
            >
              Dashboard
            </Link>
            <SignOutButton />
          </div>
        </nav>
      ) : null}
    </header>
    {showMfaBanner && mfaEnrollment ? (
      <div
        role="status"
        className={`flex w-full flex-wrap items-center justify-center gap-x-3 gap-y-1 px-6 py-2 text-sm ${
          mfaEnrollment.overdue
            ? "bg-red-600 text-white"
            : "bg-amber-100 text-amber-900"
        }`}
      >
        <span className="font-medium">
          {mfaEnrollment.overdue
            ? "Two-factor authentication is now required to keep access."
            : `Two-factor authentication must be enabled by ${formatDeadline(
                mfaEnrollment.deadline
              )}${
                mfaEnrollment.daysRemaining >= 0
                  ? ` — ${mfaEnrollment.daysRemaining} day${
                      mfaEnrollment.daysRemaining === 1 ? "" : "s"
                    } left.`
                  : "."
              }`}
        </span>
        <Link
          href="/mfa/enroll?required=true"
          className={`font-semibold underline underline-offset-2 ${
            mfaEnrollment.overdue ? "text-white" : "text-amber-900"
          }`}
        >
          Set it up now
        </Link>
      </div>
    ) : null}
    </>
  );
}
