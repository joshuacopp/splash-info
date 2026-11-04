"use client";

// Photo picker for IT issues. Shrinks each photo to a 2048px JPEG in the
// browser before it is sent -- the same approach as the damage claim form
// (Brief 146) -- so a phone photo goes up as a few hundred KB, and an iPhone
// HEIC (which most browsers can't display) arrives as a JPEG.
//
// The visible picker has no name. The processed files are written into a
// hidden `photo` input with DataTransfer, so the surrounding server-action
// form submits them like any other field. If a photo can't be decoded it is
// sent as-is and the worker decides.

import { useEffect, useRef, useState } from "react";

const MAX_EDGE = 2048;
const MAX_PHOTOS = 5;

async function shrink(file: File): Promise<File> {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height));
    const isJpeg = file.type === "image/jpeg";
    // Already small and already a JPEG: nothing to gain.
    if (scale === 1 && isJpeg) return file;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext("2d")!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.85));
    if (!blob) return file;
    const base = file.name.replace(/\.[^.]+$/, "") || "photo";
    return new File([blob], `${base}.jpg`, { type: "image/jpeg" });
  } catch {
    return file;
  }
}

export function PhotoInput({ label = "Photos (optional)", hint }: { label?: string; hint?: string }) {
  const hidden = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [previews, setPreviews] = useState<string[]>([]);

  // Keep the hidden input and the previews in step with `files`.
  useEffect(() => {
    if (hidden.current) {
      const dt = new DataTransfer();
      for (const f of files) dt.items.add(f);
      hidden.current.files = dt.files;
    }
    const urls = files.map((f) => URL.createObjectURL(f));
    setPreviews(urls);
    return () => urls.forEach((u) => URL.revokeObjectURL(u));
  }, [files]);

  return (
    <div className="text-sm">
      <span className="mb-1 block font-semibold text-splash-navy">{label}</span>
      <input ref={hidden} type="file" name="photo" multiple hidden tabIndex={-1} aria-hidden />
      {files.length < MAX_PHOTOS && (
        <label className="inline-flex cursor-pointer items-center gap-2 rounded-splash-sm border border-splash-blue px-3 py-1.5 font-semibold text-splash-blue hover:bg-splash-blue hover:text-white">
          {busy ? "Preparing…" : "+ Add photo"}
          <input
            type="file"
            accept="image/*"
            multiple
            className="sr-only"
            disabled={busy}
            onChange={async (e) => {
              const picked = Array.from(e.target.files ?? []).slice(0, MAX_PHOTOS - files.length);
              e.target.value = "";
              if (picked.length === 0) return;
              setBusy(true);
              const ready = await Promise.all(picked.map(shrink));
              setFiles((prev) => [...prev, ...ready].slice(0, MAX_PHOTOS));
              setBusy(false);
            }}
          />
        </label>
      )}
      {hint && <p className="mt-1 text-xs text-splash-navy/60">{hint}</p>}
      {files.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-2">
          {files.map((f, i) => (
            <li key={`${f.name}-${i}`} className="relative">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={previews[i]} alt={f.name} className="h-20 w-20 rounded-splash-sm border border-gray-light object-cover" />
              <button
                type="button"
                onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))}
                className="absolute -right-2 -top-2 rounded-full bg-white px-1.5 text-xs font-bold text-racecar-red shadow"
                aria-label={`Remove ${f.name}`}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
