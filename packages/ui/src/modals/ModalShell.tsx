// Shared modal frame — overlay + centered card. Used by every signup-flow
// modal (Success / Deny / Warn / Monitor). Source: legacy/signupworker.js
// createModalOverlay + modalBaseStyle (the inline JS overlay code).

import type { CSSProperties, ReactNode } from "react";

export interface ModalShellProps {
  open: boolean;
  /** Click handler for the overlay (clicking outside the card). Pass undefined
   *  to disable click-out-to-dismiss (legacy behavior — modals are dismissed
   *  via explicit buttons). */
  onOverlayClick?: () => void;
  children: ReactNode;
  ariaLabel?: string;
}

const overlayStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0, 0, 0, 0.7)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 9999,
  padding: 20
};

const cardStyle: CSSProperties = {
  background: "white",
  borderRadius: 16,
  padding: "40px 30px",
  maxWidth: 420,
  width: "100%",
  textAlign: "center",
  boxShadow: "0 20px 60px rgba(0, 0, 0, 0.3)"
};

export function ModalShell({ open, onOverlayClick, children, ariaLabel }: ModalShellProps) {
  if (!open) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
      style={overlayStyle}
      onClick={onOverlayClick}
    >
      <div style={cardStyle} onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}

/** Reusable button style for modal CTAs. */
export function modalButtonStyle(background: string): CSSProperties {
  return {
    width: "100%",
    padding: "14px 24px",
    fontSize: "1rem",
    fontWeight: 700,
    color: "white",
    background,
    border: "none",
    borderRadius: 10,
    cursor: "pointer",
    boxShadow: "0 4px 12px rgba(0,0,0,0.15)"
  };
}
