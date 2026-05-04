// Brand header — logo + eyebrow label + page title.
// Pattern from legacy/dashboard.js:401-432 (renderDashboard header).

import type { CSSProperties, ReactNode } from "react";
import { ASSETS } from "@splash/storage-r2/assets";
import { SPLASH_COLORS } from "./tokens";

export interface BrandHeaderProps {
  /** Top-line label, e.g. "Internal Tools" / "Pricing Admin". */
  eyebrow?: string;
  /** Big title under the eyebrow. */
  title: string;
  /** Right-side content — typically user email + sign-out link. */
  rightSlot?: ReactNode;
  /** Defaults to white logo (for dark backgrounds). Pass "blue" for the
   *  light-background variant. */
  logoVariant?: "white" | "blue";
}

const headerStyle: CSSProperties = {
  width: "100%",
  maxWidth: 1100,
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  color: SPLASH_COLORS.white,
  marginBottom: 36,
  gap: 16,
  flexWrap: "wrap"
};

const eyebrowStyle: CSSProperties = {
  fontSize: "0.75rem",
  fontWeight: 600,
  letterSpacing: "0.18em",
  textTransform: "uppercase",
  color: SPLASH_COLORS.sudsyBlue
};

const titleStyle: CSSProperties = {
  margin: 0,
  fontSize: "1.375rem",
  fontWeight: 700,
  letterSpacing: "-0.005em"
};

export function BrandHeader({ eyebrow, title, rightSlot, logoVariant = "white" }: BrandHeaderProps) {
  const logoSrc = logoVariant === "blue" ? ASSETS.logoBlue : ASSETS.logoWhite;
  return (
    <header style={headerStyle}>
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <img
          src={logoSrc}
          alt="Splash Car Washes"
          style={{ height: 56, width: "auto", objectFit: "contain", flexShrink: 0 }}
        />
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {eyebrow ? <span style={eyebrowStyle}>{eyebrow}</span> : null}
          <h1 style={titleStyle}>{title}</h1>
        </div>
      </div>
      {rightSlot ? <div>{rightSlot}</div> : null}
    </header>
  );
}
