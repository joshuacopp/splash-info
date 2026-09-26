"use client";

// The safety data sheet attached to one row: open it, or put one on file.
//
// Uploads go STRAIGHT FROM THE BROWSER to forms-worker, not through a server
// action. Same-origin because /forms/* is path-carved, so the cookie and the
// Origin header the worker's CSRF gate wants both ride along for free -- and a
// 10 MB PDF never has to be marshalled through an RSC boundary to reach the
// bucket it is going to anyway.

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import type { SdsItem } from "../_lib/types";

/** Mirrors the worker's cap. Checked here too so a too-large file is refused
 *  before it is uploaded rather than after. */
const MAX_BYTES = 10 * 1024 * 1024;

export default function SheetCell({
  item,
  canEdit
}: {
  item: SdsItem;
  canEdit: boolean;
}) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [busy, startTransition] = useTransition();
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function upload(file: File) {
    setError(null);
    if (file.size > MAX_BYTES) {
      setError("That file is over 10 MB — larger than any safety data sheet.");
      return;
    }
    setUploading(true);
    try {
      const body = new FormData();
      body.set("file", file);
      const res = await fetch(`/forms/api/sds/${encodeURIComponent(item.id)}/sheet`, {
        method: "POST",
        body,
        credentials: "include"
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        setError(
          text.includes("not_a_pdf")
            ? "That isn't a PDF. Manufacturers publish sheets as PDFs — save it as one and try again."
            : text.includes("file_too_large")
              ? "That file is too large."
              : `Upload failed (${res.status}).`
        );
        return;
      }
      startTransition(() => router.refresh());
    } catch {
      setError("Upload failed — check your connection and try again.");
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <div className="text-xs">
      {item.sds_r2_key ? (
        <a
          href={`/forms/api/sds/${encodeURIComponent(item.id)}/sheet`}
          target="_blank"
          rel="noreferrer"
          className="font-semibold text-splash-blue underline"
          title={item.sds_filename ?? undefined}
        >
          View SDS
        </a>
      ) : (
        <span className="text-splash-navy/40">No sheet</span>
      )}

      {canEdit ? (
        <>
          {" "}
          <button
            type="button"
            disabled={uploading || busy}
            onClick={() => inputRef.current?.click()}
            className="text-splash-navy/60 underline disabled:opacity-50"
          >
            {uploading ? "Uploading…" : item.sds_r2_key ? "Replace" : "Upload"}
          </button>
          <input
            ref={inputRef}
            type="file"
            accept="application/pdf,.pdf"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void upload(f);
            }}
          />
        </>
      ) : null}

      {error ? (
        <p role="alert" className="mt-1 text-racecar-red">
          {error}
        </p>
      ) : null}
    </div>
  );
}
