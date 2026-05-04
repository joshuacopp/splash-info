// Status pill for the damage-claim manager UI.
// Source: legacy/damagemanager.js:4325 + 5469-5482 — the `status-{lifecycle}`
// class drives the color, the body text is the full claim_status string.

import type { CSSProperties } from "react";
import type { ClaimStatus, LifecycleState } from "@splash/types/claims";
import { SPLASH_COLORS } from "./tokens";

export interface StatusBadgeProps {
  status: ClaimStatus;
  lifecycle: LifecycleState;
}

const baseStyle: CSSProperties = {
  display: "inline-block",
  padding: "4px 10px",
  borderRadius: 999,
  fontSize: "0.75rem",
  fontWeight: 700,
  letterSpacing: "0.04em",
  whiteSpace: "nowrap"
};

const palettes: Record<LifecycleState, CSSProperties> = {
  Open: {
    background: SPLASH_COLORS.sudsyBlueSoft,
    color: SPLASH_COLORS.navy,
    border: `1px solid ${SPLASH_COLORS.sudsyBlue}`
  },
  Closed: {
    background: SPLASH_COLORS.grayLight,
    color: SPLASH_COLORS.grayDark,
    border: `1px solid ${SPLASH_COLORS.grayDark}`
  }
};

export function StatusBadge({ status, lifecycle }: StatusBadgeProps) {
  return <span style={{ ...baseStyle, ...palettes[lifecycle] }}>{status}</span>;
}
