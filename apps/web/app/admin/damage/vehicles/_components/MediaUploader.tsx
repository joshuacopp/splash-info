"use client";

// Photo / video uploader for one Vehicle Guide entry.
//
// POSTS STRAIGHT TO THE WORKER, NOT THROUGH A SERVER ACTION -- the Brief 37
// pattern from UploadDocumentCard. A 50 MB clip through a server action would
// pass through the apps/web Worker and its body limit for nothing. Relative
// URL: same-origin in production via the /manage/api/* route, the
// next.config.mjs rewrite in dev.
//
// XMLHttpRequest rather than fetch for upload progress: a video over a site's
// cellular connection can take a minute, and a button that just says
// "Uploading…" for that long looks frozen.
//
// One file per request, in sequence, so a failure names the file it was and
// the rest still go up.

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

const PHOTO_MAX = 15 * 1024 * 1024;
const VIDEO_MAX = 50 * 1024 * 1024;

interface Props {
  issueId: number;
  /** How many more the entry can hold (worker caps at 8). */
  remaining: number;
}

function uploadOne(
  issueId: number,
  file: File,
  onProgress: (pct: number) => void
): Promise<string | null> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/manage/api/vehicle-issues/${issueId}/media`);
    xhr.withCredentials = true;
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve(null);
      let msg = `Upload failed (${xhr.status}).`;
      try {
        const body = JSON.parse(xhr.responseText) as { error?: string };
        if (body.error) msg = body.error;
      } catch {
        /* keep the status message */
      }
      resolve(msg);
    };
    xhr.onerror = () => resolve("Network error. Check the connection and try again.");
    const fd = new FormData();
    fd.append("file", file);
    xhr.send(fd);
  });
}

export function MediaUploader({ issueId, remaining }: Props) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);

  async function onChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (files.length === 0) return;

    const errs: string[] = [];
    const queue = files.slice(0, Math.max(remaining, 0));
    if (files.length > queue.length) {
      errs.push(`Only ${remaining} more file${remaining === 1 ? "" : "s"} fit on this entry; the rest were skipped.`);
    }

    setBusy(true);
    setErrors([]);
    let done = 0;
    for (const [n, file] of queue.entries()) {
      // Android pickers (gallery, Files, Drive) often hand over a File with an
      // empty `type`. Fall back to the extension, and when neither says, check
      // against the larger limit and let the worker -- which sniffs the bytes --
      // make the real call rather than refusing a video as an oversized photo.
      const isVideo =
        file.type.startsWith("video/") ||
        (!file.type && (/\.(mp4|m4v|mov|webm|3gp)$/i.test(file.name) || file.size > PHOTO_MAX));
      const max = isVideo ? VIDEO_MAX : PHOTO_MAX;
      if (file.size > max) {
        errs.push(`${file.name}: ${(file.size / 1048576).toFixed(0)} MB is over the ${max / 1048576} MB limit.`);
        continue;
      }
      const label = `${file.name} (${n + 1} of ${queue.length})`;
      setStatus(`Uploading ${label}…`);
      const err = await uploadOne(issueId, file, (pct) => setStatus(`Uploading ${label}… ${pct}%`));
      if (err) errs.push(`${file.name}: ${err}`);
      else done++;
    }
    setBusy(false);
    setStatus(done ? `Uploaded ${done} file${done === 1 ? "" : "s"}.` : null);
    setErrors(errs);
    if (done) router.refresh();
  }

  return (
    <div className="flex flex-col gap-2">
      <input
        ref={inputRef}
        type="file"
        accept="image/*,video/*"
        multiple
        className="hidden"
        onChange={onChange}
      />
      <div>
        <button
          type="button"
          disabled={busy || remaining <= 0}
          onClick={() => inputRef.current?.click()}
          className="inline-flex items-center gap-2 rounded-splash-sm border border-splash-blue bg-white px-4 py-2 text-sm font-bold text-splash-blue transition-colors hover:bg-splash-blue/5 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy ? "Uploading…" : remaining <= 0 ? "Entry is full (8 files)" : "+ Add photos or videos"}
        </button>
      </div>
      <p className="text-xs text-splash-navy/60">
        Photos up to 15 MB, videos up to 50 MB (about a minute of phone or tablet video). Android
        cameras record in a format every device plays. iPhones default to HEVC, which some
        Android tablets and phones can&rsquo;t play: on an iPhone set Camera → Formats → Most
        Compatible before recording.
      </p>
      {status ? (
        <p role="status" className="text-sm font-semibold text-splash-navy">
          {status}
        </p>
      ) : null}
      {errors.length ? (
        <ul role="alert" className="list-disc pl-5 text-sm text-splash-deny">
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
