"use client";

// BOGO ("Buy One Get One") toggle modal — independent of the mode-button
// group. Reads current per-package BOGO state from props, pre-checks rows.
// Zero checked is valid (means "turn BOGO off for every package here").
//
// Mirrors the legacy admin UI's BOGO modal — eyebrow "Toggle Promo", title
// "Buy One Get One". Submits the full intent: pkgList = checked-only.

import { useEffect, useState } from "react";
import { ModalShell, modalButtonStyle } from "@splash/ui";

export interface BogoPackage {
  pkg: string;
  pretty_pkg: string;
  /** Current BOGO state — pre-check matching rows. */
  on: boolean;
}

export interface BogoModalProps {
  open: boolean;
  packages: ReadonlyArray<BogoPackage>;
  onCancel: () => void;
  onApply: (args: { selectedPkgs: string[] }) => void;
}

export function BogoModal(props: BogoModalProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Re-seed selection from current state whenever the modal opens (or when
  // its `packages` snapshot changes, e.g. after a successful apply).
  useEffect(() => {
    if (props.open) {
      const seed = new Set<string>();
      for (const p of props.packages) {
        if (p.on) seed.add(p.pkg);
      }
      setSelected(seed);
    }
  }, [props.open, props.packages]);

  if (!props.open) {
    return <ModalShell open={false}>{null}</ModalShell>;
  }

  function toggle(pkg: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(pkg)) next.delete(pkg);
      else next.add(pkg);
      return next;
    });
  }

  function handleApply() {
    // Zero checked is valid — it means "turn BOGO off for every package here".
    props.onApply({ selectedPkgs: Array.from(selected) });
  }

  return (
    <ModalShell open ariaLabel="Toggle Promo — Buy One Get One">
      {/* Header strip */}
      <div
        style={{
          margin: "-40px -30px 22px",
          padding: "22px 28px 18px",
          background: "linear-gradient(180deg, #fef3c7 0%, #ffffff 100%)",
          borderTopLeftRadius: 16,
          borderTopRightRadius: 16,
          textAlign: "left"
        }}
      >
        <div
          style={{
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: "0.16em",
            color: "#1c164e",
            marginBottom: 4
          }}
        >
          TOGGLE PROMO
        </div>
        <div style={{ fontSize: 22, fontWeight: 700, color: "#1c164e" }}>
          Buy One Get One
        </div>
      </div>

      {/* Package checkbox list */}
      <div style={{ textAlign: "left", marginBottom: 24 }}>
        {props.packages.length === 0 ? (
          <div
            style={{
              color: "#6b7280",
              fontSize: 14,
              padding: "20px 0",
              textAlign: "center"
            }}
          >
            No packages available at this location.
          </div>
        ) : (
          props.packages.map((p) => {
            const checked = selected.has(p.pkg);
            return (
              <label
                key={p.pkg}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "10px 12px",
                  marginBottom: 6,
                  border: `1.5px solid ${checked ? "#f1c61e" : "#dbdbdb"}`,
                  borderRadius: 8,
                  cursor: "pointer",
                  background: checked ? "#fef9e0" : "white",
                  transition: "border-color 0.15s ease, background 0.15s ease"
                }}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggle(p.pkg)}
                  style={{ width: 18, height: 18, accentColor: "#1c164e" }}
                />
                <span style={{ fontSize: 14, color: "#1c164e", fontWeight: 600 }}>
                  {p.pretty_pkg || p.pkg}
                </span>
                <span
                  style={{
                    marginLeft: "auto",
                    fontSize: 11,
                    color: "#6b7280",
                    fontFamily: "monospace"
                  }}
                >
                  {p.pkg}
                </span>
              </label>
            );
          })
        )}
      </div>

      {/* Buttons — Cancel (gray outline) + Apply (Splash blue) */}
      <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
        <button
          type="button"
          onClick={props.onCancel}
          style={{
            padding: "10px 20px",
            fontSize: 14,
            fontWeight: 700,
            color: "#1c164e",
            background: "white",
            border: "1.5px solid #dbdbdb",
            borderRadius: 8,
            cursor: "pointer",
            minWidth: 100
          }}
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleApply}
          style={{
            ...modalButtonStyle("linear-gradient(135deg, #2b3491 0%, #1c164e 100%)"),
            width: "auto",
            padding: "10px 28px",
            minWidth: 100,
            fontSize: 14
          }}
        >
          Apply
        </button>
      </div>
    </ModalShell>
  );
}
