// Root layout - minimal HTML shell + globals + the global Header.
//
// The Header component renders on every page (logo always visible per
// operator preference). Admin pages get additional in-header controls
// (user identity row + Dashboard, Change Password, Sign Out) via
// usePathname-gated rendering inside the Header itself - see
// app/_components/Header.tsx.
//
// Per-route layouts are no longer needed for chrome; deleted in Brief 2's
// follow-up after the operator asked for the logo on every page.
//
// Brief 11a: layout fetches /api/me on every request to populate the
// Header's user info. The fetch is wrapped in React `cache()` so any
// further consumer in the same render (e.g., /admin/damage/[id] gating
// transitions by dc_role) reuses the same Session without amplifying the
// network call. Errors are swallowed -> public chrome — covers
// unauthenticated users, the dev cross-origin cookie limitation, and
// transient worker outages.

import type { Metadata } from "next";
import type { ReactNode } from "react";
import { ASSETS } from "@splash/storage-r2/assets";
import { Header, type HeaderUser } from "./_components/Header";
import { getMe, roleLabelFor } from "./_lib/me";
import "./globals.css";

export const metadata: Metadata = {
  title: "Splash MaxPass",
  description: "Splash Car Washes - internal tools",
  icons: {
    icon: ASSETS.favicon
  }
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const session = await getMe().catch(() => null);
  const user: HeaderUser | undefined = session
    ? { email: session.email, roleLabel: roleLabelFor(session.role) }
    : undefined;

  return (
    <html lang="en">
      <body>
        <Header user={user} />
        <main>{children}</main>
      </body>
    </html>
  );
}
