// Brief 131 — inline signature canvas for the admin transition modal.
//
// Replaces Brief 120's "paste an r2_key" text input. Renders a real
// <canvas> backed by the same `signature_pad` library the public form
// uses (Brief 92). The library is loaded at runtime from the vendored
// asset served by splash-forms at `/forms/api/static/signature-pad.min.js`
// — same-origin in production via path-carving; cross-origin in dev
// (smoke testing for this feature is deferred to staging per the brief).
//
// Flow:
//   1. Operator signs on the canvas.
//   2. Click Confirm → component POSTs the PNG blob to
//      `/forms/admin/api/transition-signatures/{submissionId}`.
//   3. Worker writes to R2, returns `{r2_key}`.
//   4. Component populates a sibling hidden input `signature_r2_key`
//      via `onUploaded(r2_key)`, which gets submitted by the ActionForm
//      wrapping this component.

"use client";

import Script from "next/script";
import { useEffect, useRef, useState } from "react";

// Minimal subset of `signature_pad`'s public API we depend on. The
// vendored bundle exposes a `SignaturePad` global; we don't import the
// types package to avoid making it a npm dep.
interface SignaturePadInstance {
  isEmpty(): boolean;
  clear(): void;
  toDataURL(mime?: string): string;
  addEventListener(name: "endStroke", handler: () => void): void;
}
interface SignaturePadCtor {
  new (canvas: HTMLCanvasElement, opts?: { penColor?: string }): SignaturePadInstance;
}
declare global {
  interface Window {
    SignaturePad?: SignaturePadCtor;
  }
}

interface SignatureCanvasProps {
  submissionId: string;
  onUploaded: (r2_key: string) => void;
  /** Called when the user clears or starts a fresh signature. */
  onCleared: () => void;
  /** The currently-attached r2_key (if any) — display-only. */
  currentR2Key: string | null;
}

const SIGNATURE_PAD_SRC = "/forms/api/static/signature-pad.min.js";

export default function SignatureCanvas({
  submissionId,
  onUploaded,
  onCleared,
  currentR2Key
}: SignatureCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const padRef = useRef<SignaturePadInstance | null>(null);
  const [libReady, setLibReady] = useState(
    typeof window !== "undefined" && Boolean(window.SignaturePad)
  );
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  // Resize the canvas to its CSS pixel size, scaled for devicePixelRatio
  // so strokes stay crisp on HiDPI displays. Re-runs on window resize so
  // a viewport change doesn't leave the strokes stretched.
  useEffect(() => {
    function resizeCanvas() {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ratio = Math.max(window.devicePixelRatio || 1, 1);
      canvas.width = canvas.offsetWidth * ratio;
      canvas.height = canvas.offsetHeight * ratio;
      const ctx = canvas.getContext("2d");
      if (ctx) ctx.scale(ratio, ratio);
      padRef.current?.clear();
    }
    resizeCanvas();
    window.addEventListener("resize", resizeCanvas);
    return () => window.removeEventListener("resize", resizeCanvas);
  }, []);

  // Initialize the pad once the library has loaded.
  useEffect(() => {
    if (!libReady) return;
    const canvas = canvasRef.current;
    if (!canvas || padRef.current) return;
    if (!window.SignaturePad) return;
    const pad = new window.SignaturePad(canvas, { penColor: "#0a2240" });
    pad.addEventListener("endStroke", () => {
      setDirty(true);
      setError(null);
    });
    padRef.current = pad;
  }, [libReady]);

  function handleClear() {
    padRef.current?.clear();
    setDirty(false);
    setError(null);
    onCleared();
  }

  async function handleConfirm() {
    const pad = padRef.current;
    if (!pad) {
      setError("Signature pad isn't ready yet — wait a moment and try again.");
      return;
    }
    if (pad.isEmpty()) {
      setError("Please draw your signature before confirming.");
      return;
    }
    setError(null);
    setUploading(true);
    try {
      const dataUrl = pad.toDataURL("image/png");
      const b64 = dataUrl.split(",")[1] ?? "";
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const blob = new Blob([bytes], { type: "image/png" });
      const fd = new FormData();
      fd.append("signature", blob, "signature.png");
      const resp = await fetch(
        `/forms/admin/api/transition-signatures/${encodeURIComponent(submissionId)}`,
        {
          method: "POST",
          body: fd,
          credentials: "include"
        }
      );
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(text || `Upload failed: HTTP ${resp.status}`);
      }
      const json = (await resp.json()) as { r2_key?: string };
      if (!json.r2_key) {
        throw new Error("Upload returned no r2_key.");
      }
      onUploaded(json.r2_key);
      setDirty(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="space-y-2">
      <Script
        src={SIGNATURE_PAD_SRC}
        strategy="afterInteractive"
        onLoad={() => setLibReady(true)}
      />
      <div className="rounded-md border border-gray-light bg-white">
        <canvas
          ref={canvasRef}
          className="block h-[180px] w-full cursor-crosshair touch-none rounded-md bg-white"
          aria-label="Signature canvas"
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={handleClear}
          className="rounded-splash-sm border border-gray-light px-3 py-1 text-xs font-semibold text-splash-navy/80 hover:bg-gray-light"
          disabled={uploading}
        >
          Clear
        </button>
        <button
          type="button"
          onClick={handleConfirm}
          className="rounded-splash-sm bg-splash-blue px-3 py-1 text-xs font-bold uppercase tracking-wide text-white shadow-splash-btn hover:bg-splash-blue-dark disabled:opacity-60"
          disabled={uploading || !dirty || !libReady}
        >
          {uploading ? "Saving…" : "Confirm signature"}
        </button>
        {currentR2Key && !dirty && (
          <span className="text-[0.7rem] text-emerald-700">
            ✓ Signature attached
          </span>
        )}
        {dirty && !currentR2Key && (
          <span className="text-[0.7rem] text-amber-700">
            Unsaved — click Confirm to attach.
          </span>
        )}
      </div>
      {error && (
        <p className="text-xs text-racecar-red" role="alert">
          {error}
        </p>
      )}
      {!libReady && (
        <p className="text-xs text-splash-navy/60">Loading signature pad…</p>
      )}
    </div>
  );
}
