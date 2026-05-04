// Page shell — outer wrapper with the brand gradient background.
// Used by every authenticated page (dashboard, admin, performance, manage).
// Public claim form has its own light-mode bubble background; see
// BubbleBackground for that.

import type { CSSProperties, ReactNode } from "react";
import { BRAND_BACKGROUND_GRADIENT, BRAND_FONT_FAMILY, SPLASH_COLORS } from "./tokens";

export interface PageShellProps {
  children: ReactNode;
  /** Override the default vertical centering (e.g., login card). */
  center?: boolean;
  /** Extra inline style for the body div. */
  style?: CSSProperties;
}

const baseStyle: CSSProperties = {
  margin: 0,
  padding: 0,
  fontFamily: BRAND_FONT_FAMILY,
  color: SPLASH_COLORS.navy,
  background: BRAND_BACKGROUND_GRADIENT,
  minHeight: "100vh",
  boxSizing: "border-box"
};

const centerStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "20px"
};

export function PageShell({ children, center, style }: PageShellProps) {
  const combined = { ...baseStyle, ...(center ? centerStyle : {}), ...(style ?? {}) };
  return <div style={combined}>{children}</div>;
}
