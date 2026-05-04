// Package picker card — rendered on /signup/{location} for each available
// package. Source: legacy/signupworker.js:1873 (renderPicker — `card` items).
//
// Lightweight version for Step 5 — no JotForm/MS Forms routing logic
// (that's a Step 7 concern when the picker page is built in apps/web).

import type { CSSProperties } from "react";
import type { PricingSimpleResolvedRow } from "@splash/types/pricing";
import { SPLASH_COLORS, SPLASH_RADII, SPLASH_SHADOWS } from "./tokens";

export interface PricingCardProps {
  row: PricingSimpleResolvedRow;
  /** Callback when the user taps the card. Receives the package code. */
  onSelect: (pkgCode: string) => void;
}

const cardStyle: CSSProperties = {
  background: SPLASH_COLORS.white,
  border: `3px solid ${SPLASH_COLORS.navy}`,
  borderRadius: SPLASH_RADII.lg,
  boxShadow: SPLASH_SHADOWS.card,
  cursor: "pointer",
  overflow: "hidden",
  display: "flex",
  flexDirection: "column",
  textAlign: "center"
};

const titleStyle: CSSProperties = {
  background: `linear-gradient(135deg, ${SPLASH_COLORS.blue} 0%, ${SPLASH_COLORS.navy} 100%)`,
  color: SPLASH_COLORS.white,
  padding: "16px 18px",
  fontSize: "1.125rem",
  fontWeight: 700
};

const priceWrapStyle: CSSProperties = {
  padding: "18px 18px 22px"
};

const todayPriceStyle: CSSProperties = {
  fontSize: "1.625rem",
  fontWeight: 800,
  color: SPLASH_COLORS.blue
};

const ongoingStyle: CSSProperties = {
  fontSize: "0.875rem",
  color: SPLASH_COLORS.grayDark,
  marginTop: 4
};

function formatMoney(n: number | null): string {
  if (n == null) return "—";
  return `$${n.toFixed(2)}`;
}

export function PricingCard({ row, onSelect }: PricingCardProps) {
  return (
    <button
      type="button"
      onClick={() => onSelect(row.pkg)}
      style={{ all: "unset", ...cardStyle }}
      data-pkg={row.pkg}
    >
      <div style={titleStyle}>{row.pretty_pkg}</div>
      <div style={priceWrapStyle}>
        <div style={todayPriceStyle}>Today: {formatMoney(row.today)}</div>
        <div style={ongoingStyle}>Then {formatMoney(row.ongoing)}/mo</div>
      </div>
    </button>
  );
}
