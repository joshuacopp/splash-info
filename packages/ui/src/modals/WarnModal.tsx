// Warn modal — shown on 3rd-9th use of a phone number (Warn tier).
// User can confirm or change the number.
// Source: legacy/signupworker.js:2904 showWarningModal.

import { ModalShell, modalButtonStyle } from "./ModalShell";

export interface WarnModalProps {
  open: boolean;
  message: string;
  /** Called when the user confirms it's their number — the caller should
   *  re-submit the form with `user_confirmed: true`. */
  onConfirm: () => void;
  /** Called when the user wants to enter a different number. */
  onChangeNumber: () => void;
}

export function WarnModal({ open, message, onConfirm, onChangeNumber }: WarnModalProps) {
  return (
    <ModalShell open={open} ariaLabel="Phone number warning">
      <div style={{ fontSize: 80, marginBottom: 20, color: "#f59e0b" }}>⚠</div>
      <h2
        style={{
          color: "#f59e0b",
          fontSize: 32,
          marginBottom: 15,
          fontWeight: "bold"
        }}
      >
        Phone Number Warning
      </h2>
      <p style={{ color: "#64748b", fontSize: 16, marginBottom: 35, lineHeight: 1.5 }}>
        {message}
      </p>
      <div style={{ display: "grid", gap: 12 }}>
        <button
          type="button"
          onClick={onConfirm}
          style={modalButtonStyle("linear-gradient(135deg, #059669 0%, #10b981 100%)")}
        >
          This is My Phone Number
        </button>
        <button
          type="button"
          onClick={onChangeNumber}
          style={modalButtonStyle("linear-gradient(135deg, #6b7280 0%, #9ca3af 100%)")}
        >
          Enter New Number
        </button>
      </div>
    </ModalShell>
  );
}
