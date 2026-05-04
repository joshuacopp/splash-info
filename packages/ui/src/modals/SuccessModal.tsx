// Success modal — shown after a successful signup submission.
// Source: legacy/signupworker.js:3020 showSuccessModal.

import { ModalShell, modalButtonStyle } from "./ModalShell";

export interface SuccessModalProps {
  open: boolean;
  /** Called when the user clicks "Fill Form Again". Caller typically resets
   *  the form state to a clean signup. */
  onAgain: () => void;
  /** Override the body copy. Default matches legacy. */
  body?: string;
}

export function SuccessModal({
  open,
  onAgain,
  body = "Signup completed successfully"
}: SuccessModalProps) {
  return (
    <ModalShell open={open} ariaLabel="MaxPass signup successful">
      <div style={{ fontSize: 80, marginBottom: 20, color: "#059669" }}>✓</div>
      <h2
        style={{
          color: "#059669",
          fontSize: 36,
          marginBottom: 15,
          fontWeight: "bold"
        }}
      >
        MaxPass Success!
      </h2>
      <p style={{ color: "#64748b", fontSize: 18, marginBottom: 35 }}>{body}</p>
      <button
        type="button"
        onClick={onAgain}
        style={modalButtonStyle("linear-gradient(135deg, #1e3a8a 0%, #3b82f6 100%)")}
      >
        Fill Form Again?
      </button>
    </ModalShell>
  );
}
