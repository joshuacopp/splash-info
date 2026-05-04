// Monitor modal — shown on 10th+ use of a phone number (Monitor tier).
// More severe styling than Warn. User can confirm with `monitor_acknowledged`
// flag set on the resubmission.
// Source: legacy/signupworker.js:2962 showMonitorModal.

import { ModalShell, modalButtonStyle } from "./ModalShell";

export interface MonitorModalProps {
  open: boolean;
  message: string;
  /** Called when the user confirms it's their number — caller resubmits
   *  with `monitor_acknowledged: true`. */
  onConfirm: () => void;
  /** Called when the user wants to enter a different number. */
  onChangeNumber: () => void;
}

export function MonitorModal({ open, message, onConfirm, onChangeNumber }: MonitorModalProps) {
  return (
    <ModalShell open={open} ariaLabel="Phone number flagged">
      <div style={{ fontSize: 80, marginBottom: 20, color: "#ea580c" }}>🚨</div>
      <h2
        style={{
          color: "#ea580c",
          fontSize: 32,
          marginBottom: 15,
          fontWeight: "bold"
        }}
      >
        Number Flagged
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
          style={modalButtonStyle("linear-gradient(135deg, #ea580c 0%, #f97316 100%)")}
        >
          Enter Different Number
        </button>
      </div>
    </ModalShell>
  );
}
