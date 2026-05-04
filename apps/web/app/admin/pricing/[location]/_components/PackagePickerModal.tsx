"use client";

// Package-picker modal — opens when the admin clicks any of the 5 mode
// buttons (Full Price / Same As Today / $5 Flash / $2 Flash / Special).
// Quick Flip skips this modal and posts directly.
//
// Special mode adds a "Special Price ($)" number input. The Apply button
// is disabled until BOTH at-least-one-package is checked AND (for special)
// a valid positive price is entered.
//
// Legacy parity (per screenshots Josh shared 2026-05-03):
//   - White card with a sudsy-blue header strip (eyebrow + title)
//   - Eyebrow: "APPLY PRICING" or "SET SPECIAL"
//   - Title: human-readable mode label
//   - Checkbox list of packages
//   - Cancel (gray outline) + Apply (Splash blue filled)

import { useEffect, useState } from "react";
import { ModalShell, modalButtonStyle } from "@splash/ui";

export type PickerMode = "full" | "same" | "flash5" | "flash2" | "special";

export interface PickerPackage {
  pkg: string;
  pretty_pkg: string;
}

export interface PackagePickerModalProps {
  open: boolean;
  mode: PickerMode | null;
  packages: ReadonlyArray<PickerPackage>;
  onCancel: () => void;
  onApply: (args: { selectedPkgs: string[]; specialPrice?: number }) => void;
}

const MODE_LABELS: Record<PickerMode, { eyebrow: string; title: string }> = {
  full: { eyebrow: "APPLY PRICING", title: "Full Price" },
  same: { eyebrow: "APPLY PRICING", title: "Same As Today" },
  flash5: { eyebrow: "APPLY PRICING", title: "$5 Flash" },
  flash2: { eyebrow: "APPLY PRICING", title: "$2 Flash" },
  special: { eyebrow: "SET SPECIAL", title: "Custom Price" }
};

export function PackagePickerModal(props: PackagePickerModalProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [priceInput, setPriceInput] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Reset internal state whenever the modal opens for a new mode/target.
  // useEffect runs after render so React doesn't complain about
  // setState-during-render.
  useEffect(() => {
    if (props.open) {
      setSelected(new Set());
      setPriceInput("");
      setError(null);
    }
  }, [props.open, props.mode]);

  if (!props.open || props.mode === null) {
    return <ModalShell open={false}>{null}</ModalShell>;
  }

  const labels = MODE_LABELS[props.mode];
  const isSpecial = props.mode === "special";

  function toggle(pkg: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(pkg)) next.delete(pkg);
      else next.add(pkg);
      return next;
    });
    setError(null);
  }

  function handleApply() {
    if (selected.size === 0) {
      setError("Select at least one package.");
      return;
    }
    if (isSpecial) {
      const parsed = Number.parseFloat(priceInput);
      if (Number.isNaN(parsed) || parsed <= 0) {
        setError("Enter a positive number for the special price.");
        return;
      }
      props.onApply({ selectedPkgs: Array.from(selected), specialPrice: parsed });
      return;
    }
    props.onApply({ selectedPkgs: Array.from(selected) });
  }

  return (
    <ModalShell open ariaLabel={`${labels.eyebrow} — ${labels.title}`}>
      {/* Header strip */}
      <div
        style={{
          margin: "-40px -30px 22px",
          padding: "22px 28px 18px",
          background: "linear-gradient(180deg, #d6f1fb 0%, #ffffff 100%)",
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
            color: "#2b3491",
            marginBottom: 4
          }}
        >
          {labels.eyebrow}
        </div>
        <div style={{ fontSize: 22, fontWeight: 700, color: "#1c164e" }}>
          {labels.title}
        </div>
      </div>

      {/* Package checkbox list */}
      <div style={{ textAlign: "left", marginBottom: isSpecial ? 16 : 24 }}>
        {props.packages.length === 0 ? (
          <div style={{ color: "#6b7280", fontSize: 14, padding: "20px 0", textAlign: "center" }}>
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
                  border: `1.5px solid ${checked ? "#2b3491" : "#dbdbdb"}`,
                  borderRadius: 8,
                  cursor: "pointer",
                  background: checked ? "#f1f5fb" : "white",
                  transition: "border-color 0.15s ease, background 0.15s ease"
                }}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggle(p.pkg)}
                  style={{ width: 18, height: 18, accentColor: "#2b3491" }}
                />
                <span style={{ fontSize: 14, color: "#1c164e", fontWeight: 600 }}>
                  {p.pretty_pkg || p.pkg}
                </span>
                <span style={{ marginLeft: "auto", fontSize: 11, color: "#6b7280", fontFamily: "monospace" }}>
                  {p.pkg}
                </span>
              </label>
            );
          })
        )}
      </div>

      {/* Special-only price input */}
      {isSpecial ? (
        <div style={{ textAlign: "left", marginBottom: 22 }}>
          <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: "#1c164e", marginBottom: 6 }}>
            Special Price ($)
          </label>
          <input
            type="number"
            inputMode="decimal"
            min="0.01"
            step="0.01"
            value={priceInput}
            onChange={(e) => {
              setPriceInput(e.target.value);
              setError(null);
            }}
            placeholder="0.00"
            style={{
              width: "100%",
              height: 44,
              padding: "8px 12px",
              fontSize: 16,
              border: "1.5px solid #dbdbdb",
              borderRadius: 8
            }}
          />
        </div>
      ) : null}

      {/* Error display */}
      {error ? (
        <p
          role="alert"
          style={{
            color: "#dc2626",
            fontSize: 13,
            marginTop: -8,
            marginBottom: 12,
            textAlign: "left"
          }}
        >
          {error}
        </p>
      ) : null}

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
