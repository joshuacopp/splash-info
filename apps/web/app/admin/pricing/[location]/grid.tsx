"use client";

// Per-location pricing grid — REWRITE per Decision 2 (2026-05-03).
//
// Legacy production UX confirmed via screenshots:
//   - Read-only package list at the top (package name + today + ongoing
//     + current-mode badge per row).
//   - Six location-level buttons at the bottom:
//        Quick Flip, Full Price, Same As Today, $5 Flash, $2 Flash, Special.
//     Quick Flip is direct (no modal); the other five open the picker
//     modal with mode pre-selected.
//   - Picker modal: checkbox list of all packages at the location; for
//     Special, an additional "Special Price ($)" input.
//   - Current mode at the location is highlighted on its button (sudsy
//     blue) — informs the admin which mode is active.
//   - Success banner: "Updated {location_code} to {mode}." appears after
//     a successful action and clears on the next action.
//
// Worker API unchanged: handleSetMode / handleFlip already accept the
// shape this UI sends. Decision-3 refetch (Chunk 5) keeps today/ongoing
// in sync after every apply.

import { useState } from "react";
import { PackagePickerModal, type PickerMode } from "./_components/PackagePickerModal";
import { BogoModal } from "./_components/BogoModal";

interface PricingSimpleRow {
  location_code: string;
  location_pretty: string;
  pkg: string;
  pricing: string | null;
  special: number | null;
  updated_at: string | null;
  site_email: string | null;
  am_email: string | null;
  rm_email: string | null;
  bogo?: boolean;
}
interface PricingResolvedRow {
  location_pretty: string;
  location_code: string;
  pkg: string;
  pretty_pkg: string;
  today: number | null;
  ongoing: number | null;
  sort: number | null;
  bogo?: boolean;
}

export interface PricingGridProps {
  locationCode: string;
  locationPretty: string;
  packages: PricingSimpleRow[];
  resolved: PricingResolvedRow[];
}

interface ModeButton {
  id: PickerMode | "flip";
  label: string;
}

// Order matches the legacy screenshot row layout exactly.
const BUTTON_ROW: ReadonlyArray<ModeButton> = [
  { id: "flip", label: "Quick Flip" },
  { id: "full", label: "Full Price" },
  { id: "same", label: "Same As Today" },
  { id: "flash5", label: "$5 Flash" },
  { id: "flash2", label: "$2 Flash" },
  { id: "special", label: "Special" }
];

const MODE_LABEL: Record<string, string> = {
  full: "Full Price",
  same: "Same As Today",
  flash5: "$5 Flash",
  flash2: "$2 Flash",
  special: "Special"
};

export function PricingGrid(props: PricingGridProps) {
  const [packages, setPackages] = useState(props.packages);
  const [resolved, setResolved] = useState(props.resolved);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [pickerMode, setPickerMode] = useState<PickerMode | null>(null);
  const [bogoOpen, setBogoOpen] = useState(false);

  const resolvedByPkg = new Map(resolved.map((r) => [r.pkg.toLowerCase(), r]));

  // The "current mode at the location" — first row's `pricing` value.
  // Matches legacy semantics for the highlighting decision.
  const currentMode = (packages[0]?.pricing ?? "").toLowerCase();

  // Build the picker's package list from the current pricing_simple rows.
  const pickerPackages = packages.map((p) => ({
    pkg: p.pkg,
    pretty_pkg: resolvedByPkg.get(p.pkg.toLowerCase())?.pretty_pkg ?? p.pkg
  }));

  /* ============================================================
   * Action handlers
   * ============================================================ */

  async function applySetMode(args: {
    mode: PickerMode;
    selectedPkgs: string[];
    specialPrice?: number;
  }) {
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const body: Record<string, unknown> = {
        mode: args.mode,
        pkgList: args.selectedPkgs
      };
      if (args.mode === "special" && args.specialPrice !== undefined) {
        body.specialPrice = args.specialPrice;
      }
      const resp = await fetch(
        `/admin/api/locations/${encodeURIComponent(props.locationCode)}/set-mode`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify(body)
        }
      );
      const result = (await resp.json().catch(() => ({}))) as {
        ok?: boolean;
        packages?: PricingSimpleRow[];
        resolved?: PricingResolvedRow[];
        error?: string;
      };
      if (!resp.ok || !result.ok) {
        setError(result.error ?? `Update failed (${resp.status}).`);
        return;
      }
      if (result.packages) setPackages(result.packages);
      if (result.resolved) setResolved(result.resolved);
      setSuccess(
        `Updated ${props.locationCode} to ${MODE_LABEL[args.mode] ?? args.mode}.`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setBusy(false);
    }
  }

  async function applyQuickFlip() {
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const resp = await fetch(
        `/admin/api/locations/${encodeURIComponent(props.locationCode)}/flip`,
        {
          method: "POST",
          credentials: "same-origin"
        }
      );
      const result = (await resp.json().catch(() => ({}))) as {
        ok?: boolean;
        mode?: string;
        packages?: PricingSimpleRow[];
        resolved?: PricingResolvedRow[];
        error?: string;
      };
      if (!resp.ok || !result.ok) {
        setError(result.error ?? `Quick Flip failed (${resp.status}).`);
        return;
      }
      if (result.packages) setPackages(result.packages);
      if (result.resolved) setResolved(result.resolved);
      setSuccess(
        `Updated ${props.locationCode} to ${
          MODE_LABEL[result.mode ?? ""] ?? result.mode ?? "—"
        }.`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setBusy(false);
    }
  }

  function onButtonClick(button: ModeButton) {
    if (button.id === "flip") {
      applyQuickFlip();
    } else {
      setPickerMode(button.id);
    }
  }

  async function applySetBogo(args: { selectedPkgs: string[] }) {
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const resp = await fetch(
        `/admin/api/locations/${encodeURIComponent(props.locationCode)}/set-bogo`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ pkgList: args.selectedPkgs })
        }
      );
      const result = (await resp.json().catch(() => ({}))) as {
        ok?: boolean;
        packages?: PricingSimpleRow[];
        resolved?: PricingResolvedRow[];
        error?: string;
      };
      if (!resp.ok || !result.ok) {
        setError(result.error ?? `BOGO update failed (${resp.status}).`);
        return;
      }
      if (result.packages) setPackages(result.packages);
      if (result.resolved) setResolved(result.resolved);
      setSuccess(`Updated ${props.locationCode} BOGO.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setBusy(false);
    }
  }

  // Per-package BOGO state for the modal — pre-checks rows currently on.
  const bogoPackages = packages.map((p) => ({
    pkg: p.pkg,
    pretty_pkg: resolvedByPkg.get(p.pkg.toLowerCase())?.pretty_pkg ?? p.pkg,
    on: p.bogo === true
  }));

  /* ============================================================
   * Render
   * ============================================================ */

  return (
    <div>
      {/* Status banners — success above (cleared on next action) and error below. */}
      {success ? (
        <p
          role="status"
          style={{
            color: "#065f46",
            background: "#ecfdf5",
            border: "1px solid #a7f3d0",
            borderRadius: 8,
            padding: "10px 14px",
            marginBottom: 14,
            fontWeight: 500
          }}
        >
          {success}
        </p>
      ) : null}
      {error ? (
        <p
          role="alert"
          style={{
            color: "#dc2626",
            background: "#fef2f2",
            border: "1px solid #fecaca",
            borderRadius: 8,
            padding: "10px 14px",
            marginBottom: 14,
            fontWeight: 500
          }}
        >
          {error}
        </p>
      ) : null}

      {/* Read-only package list */}
      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          marginBottom: 24,
          background: "white",
          borderRadius: 10,
          overflow: "hidden",
          boxShadow: "0 1px 3px rgba(0,0,0,0.04)"
        }}
      >
        <thead>
          <tr style={{ background: "#f9fafb", textAlign: "left" }}>
            <th style={{ padding: "12px 16px", fontSize: 12, color: "#6b7280", fontWeight: 700 }}>
              Package
            </th>
            <th style={{ padding: "12px 16px", fontSize: 12, color: "#6b7280", fontWeight: 700 }}>
              Today
            </th>
            <th style={{ padding: "12px 16px", fontSize: 12, color: "#6b7280", fontWeight: 700 }}>
              Ongoing
            </th>
            <th style={{ padding: "12px 16px", fontSize: 12, color: "#6b7280", fontWeight: 700 }}>
              Mode
            </th>
          </tr>
        </thead>
        <tbody>
          {packages.length === 0 ? (
            <tr>
              <td colSpan={4} style={{ padding: 24, textAlign: "center", color: "#6b7280" }}>
                No packages configured for this location.
              </td>
            </tr>
          ) : (
            packages.map((p) => {
              const r = resolvedByPkg.get(p.pkg.toLowerCase());
              return (
                <tr key={p.pkg} style={{ borderTop: "1px solid #f1f5f9" }}>
                  <td style={{ padding: "14px 16px", fontWeight: 600 }}>
                    <div>{r?.pretty_pkg ?? p.pkg}</div>
                    <div style={{ fontSize: 11, color: "#6b7280", fontFamily: "monospace", marginTop: 2 }}>
                      {p.pkg}
                    </div>
                  </td>
                  <td style={{ padding: "14px 16px", fontFamily: "monospace" }}>
                    {r?.today != null ? `$${Number(r.today).toFixed(2)}` : "—"}
                  </td>
                  <td style={{ padding: "14px 16px", fontFamily: "monospace", color: "#6b7280" }}>
                    {r?.ongoing != null ? `$${Number(r.ongoing).toFixed(2)}` : "—"}
                  </td>
                  <td style={{ padding: "14px 16px" }}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                      <ModeBadge mode={p.pricing} />
                      {p.bogo === true ? <BogoBadge /> : null}
                    </span>
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>

      {/* Location-level button row */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap: 10
        }}
      >
        {BUTTON_ROW.map((b) => {
          // Quick Flip never matches `currentMode`; that's fine — it stays
          // dark navy. Mode buttons whose id matches the location's current
          // mode get the bright sudsy-blue treatment.
          const active = b.id === currentMode;
          return (
            <button
              key={b.id}
              type="button"
              disabled={busy}
              onClick={() => onButtonClick(b)}
              style={{
                padding: "14px 18px",
                fontSize: 14,
                fontWeight: 700,
                color: "white",
                border: "none",
                borderRadius: 10,
                cursor: busy ? "wait" : "pointer",
                background: active
                  ? "linear-gradient(135deg, #3dbeee 0%, #2b3491 100%)"
                  : "linear-gradient(135deg, #1c164e 0%, #2b3491 100%)",
                boxShadow: active
                  ? "0 6px 18px rgba(43, 52, 145, 0.35)"
                  : "0 2px 6px rgba(0,0,0,0.08)",
                transition: "transform 0.1s ease, box-shadow 0.18s ease"
              }}
            >
              {b.label}
            </button>
          );
        })}
      </div>

      {/* Toggle BOGO — full-width row beneath the 3×2 mode grid, yellow promo accent.
          BOGO is a schedule modifier (orthogonal to pricing modes); a package can be
          in flash5 AND bogo simultaneously. */}
      <button
        type="button"
        disabled={busy}
        onClick={() => setBogoOpen(true)}
        style={{
          width: "100%",
          marginTop: 10,
          padding: "14px 18px",
          fontSize: 14,
          fontWeight: 700,
          color: "#1c164e",
          border: "1.5px solid #f1c61e",
          borderRadius: 10,
          cursor: busy ? "wait" : "pointer",
          background: "#f1c61e",
          boxShadow: "0 2px 6px rgba(241, 198, 30, 0.35)",
          transition: "filter 0.1s ease, box-shadow 0.18s ease"
        }}
      >
        Toggle BOGO
      </button>

      <PackagePickerModal
        open={pickerMode !== null}
        mode={pickerMode}
        packages={pickerPackages}
        onCancel={() => setPickerMode(null)}
        onApply={({ selectedPkgs, specialPrice }) => {
          const mode = pickerMode;
          setPickerMode(null);
          if (mode) {
            applySetMode({ mode, selectedPkgs, specialPrice });
          }
        }}
      />

      <BogoModal
        open={bogoOpen}
        packages={bogoPackages}
        onCancel={() => setBogoOpen(false)}
        onApply={({ selectedPkgs }) => {
          setBogoOpen(false);
          applySetBogo({ selectedPkgs });
        }}
      />
    </div>
  );
}

function BogoBadge() {
  return (
    <span
      style={{
        display: "inline-block",
        padding: "4px 12px",
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: "0.05em",
        background: "#f1c61e",
        color: "#1c164e"
      }}
    >
      BOGO
    </span>
  );
}

function ModeBadge({ mode }: { mode: string | null }) {
  const label = (mode ?? "—").toUpperCase();
  const palette: Record<string, { bg: string; fg: string }> = {
    full: { bg: "#dcfce7", fg: "#166534" },
    same: { bg: "#e0f2fe", fg: "#075985" },
    flash5: { bg: "#fef3c7", fg: "#854d0e" },
    flash2: { bg: "#fef3c7", fg: "#854d0e" },
    special: { bg: "#fee2e2", fg: "#991b1b" }
  };
  const colors = palette[(mode ?? "").toLowerCase()] ?? { bg: "#f3f4f6", fg: "#374151" };
  return (
    <span
      style={{
        display: "inline-block",
        padding: "4px 12px",
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: "0.05em",
        background: colors.bg,
        color: colors.fg
      }}
    >
      {label}
    </span>
  );
}
