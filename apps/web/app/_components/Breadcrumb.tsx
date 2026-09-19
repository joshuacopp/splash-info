"use client";

// Where am I, and how do I get back one level.
//
// The page set is three deep -- Dashboard / Operations / Mechanical /
// Maintenance Tracker -- and until now the only way back from a leaf was the
// logo, which jumps all the way to the top. That makes the middle layers
// unreachable except by starting over, so in practice nobody used them.
//
// The trail is DERIVED from the dashboard's own navigation data rather than
// configured per page (see _lib/nav.ts). A page cannot be added to the
// dashboard without appearing here correctly, and no page needs to know it has
// a breadcrumb.
//
// Renders nothing off the dashboard -- /login, /change-password, the dashboard
// root. A breadcrumb showing only "Dashboard" while you are standing on the
// dashboard is furniture, not navigation.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { resolveTrail } from "../admin/dashboard/_lib/nav";

export function Breadcrumb() {
  const pathname = usePathname() ?? "";
  const trail = resolveTrail(pathname);
  if (trail.length === 0) return null;

  // The last linked crumb is "one level up", which is what the back affordance
  // points at. On a leaf that is the subgroup or group; on a detail page it is
  // the tile itself.
  const back = [...trail].reverse().find((c) => c.href !== null) ?? null;

  return (
    <nav
      aria-label="Breadcrumb"
      className="border-b border-gray-light bg-white/60 px-5 py-2"
    >
      <div className="mx-auto flex w-full max-w-[1100px] items-center gap-1.5 text-sm">
        {back ? (
          <Link
            href={back.href as string}
            className="mr-1 inline-flex shrink-0 items-center gap-1 rounded-splash-md px-2 py-1 font-semibold text-splash-navy hover:bg-gray-light/60"
          >
            <span aria-hidden="true">&larr;</span>
            <span className="max-w-[10rem] truncate sm:max-w-none">{back.label}</span>
          </Link>
        ) : null}

        {/* The full trail is the "jump back several levels" affordance. It is
            hidden on phones, where it wraps into two lines and pushes the page
            down; the back button alone carries the small screen. */}
        <ol className="hidden min-w-0 items-center gap-1.5 sm:flex">
          {trail.map((crumb, i) => (
            <li key={`${crumb.label}-${i}`} className="flex min-w-0 items-center gap-1.5">
              {i > 0 ? (
                <span aria-hidden="true" className="text-splash-navy/30">
                  /
                </span>
              ) : null}
              {crumb.href ? (
                <Link
                  href={crumb.href}
                  className="truncate text-splash-navy/70 hover:text-splash-navy hover:underline"
                >
                  {crumb.label}
                </Link>
              ) : (
                <span
                  aria-current="page"
                  className="truncate font-semibold text-splash-navy"
                >
                  {crumb.label}
                </span>
              )}
            </li>
          ))}
        </ol>
      </div>
    </nav>
  );
}

export default Breadcrumb;
