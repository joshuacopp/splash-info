// Photo lightbox — single client island on /admin/damage/[id]. Brief 5d.
//
// Wraps an image-typed thumbnail. Click opens a fixed-overlay modal showing
// the full-size R2 image. Esc closes; click outside the image closes.
//
// One instance per image — each manages its own open state. The Esc key
// listener is registered only while the modal is open, so only the
// currently-open lightbox responds. PDF tiles continue to render as
// <a target="_blank"> on the server, no lightbox involvement.
//
// SEPARATION OF CONCERNS: this file is the entire client surface 5d adds
// to the detail page. The thumbnail's visual content is passed in as
// `children` so it stays server-rendered (no client JS for the gallery
// markup itself).

"use client";

import { useCallback, useEffect, useState } from "react";

interface Props {
  /** Absolute URL to the full-size image (damagePhotoUrl(r2_key)). */
  url: string;
  /** Alt text for the image — usually filename or photo type. */
  alt: string;
  /** Filename caption shown inside the lightbox; null OK. */
  filename?: string | null;
  /** Thumbnail visual — usually an <img> wrapped in the same layout
   *  the surrounding non-image tiles use. Rendered server-side. */
  children: React.ReactNode;
}

export function PhotoLightbox({ url, alt, filename, children }: Props) {
  const [open, setOpen] = useState(false);

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Lock background scroll while the modal is open. Restored on unmount /
  // close so a navigation away mid-modal doesn't leave the body locked.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`Open ${filename ?? alt} full size`}
        className="group flex flex-col overflow-hidden rounded-splash-md border border-gray-light bg-white text-left transition-shadow hover:shadow-splash-btn focus:outline-none focus:ring-2 focus:ring-splash-blue"
      >
        {children}
      </button>
      {open ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={alt}
          onClick={close}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
        >
          <div
            className="relative flex max-h-full max-w-full flex-col items-center gap-3"
            onClick={(e) => e.stopPropagation()}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={url}
              alt={alt}
              className="max-h-[80vh] max-w-full rounded-splash-md object-contain"
            />
            <div className="flex flex-wrap items-center justify-center gap-3 text-xs text-white/80">
              {filename ? (
                <span className="font-mono break-all">{filename}</span>
              ) : null}
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-splash-sm bg-white/10 px-3 py-1 font-semibold text-white transition-colors hover:bg-white/20"
              >
                Open original
              </a>
              <button
                type="button"
                onClick={close}
                className="rounded-splash-sm bg-white/10 px-3 py-1 font-semibold text-white transition-colors hover:bg-white/20"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
