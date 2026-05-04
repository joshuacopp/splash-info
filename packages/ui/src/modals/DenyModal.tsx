// Deny modal — shown when the fraud-detection layer rejects a phone number
// outright (Deny tier or hardcoded pattern match).
// Source: legacy/signupworker.js:2882 showDenyModal.

import { ModalShell, modalButtonStyle } from "./ModalShell";

export interface DenyModalProps {
  open: boolean;
  /** The error message from the fraud-detection API. */
  message: string;
  /** Called when the user clicks "Enter Valid Number". Caller typically
   *  clears the phone field and refocuses it. */
  onDismiss: () => void;
}

export function DenyModal({ open, message, onDismiss }: DenyModalProps) {
  return (
    <ModalShell open={open} ariaLabel="Invalid phone number">
      <div style={{ fontSize: 80, marginBottom: 20, color: "#dc2626" }}>✕</div>
      <h2
        style={{
          color: "#dc2626",
          fontSize: 32,
          marginBottom: 15,
          fontWeight: "bold"
        }}
      >
        Invalid Phone Number
      </h2>
      <p style={{ color: "#64748b", fontSize: 16, marginBottom: 35, lineHeight: 1.5 }}>
        {message}
      </p>
      <button
        type="button"
        onClick={onDismiss}
        style={modalButtonStyle("linear-gradient(135deg, #dc2626 0%, #ef4444 100%)")}
      >
        Enter Valid Number
      </button>
    </ModalShell>
  );
}
