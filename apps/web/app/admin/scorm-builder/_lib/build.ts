// Brief 148 — SCORM .zip build pipeline.
//
// Pure function from BuilderState (with a non-null `video`) to a Blob. Reads
// the video into ArrayBuffer, generates the manifest + player files, zips
// with JSZip DEFLATE level 6, returns the blob. The caller is responsible
// for triggering the browser download via createObjectURL.
//
// Ported from scorm-builder.html's `buildBtn` click handler.

import JSZip from "jszip";
import { buildManifest } from "./manifest";
import { buildIndexHtml, buildScormJs, buildStyleCss } from "./player";
import type { BuilderState } from "./types";

export interface BuildOptions {
  onProgress?: (pct: number, message: string) => void;
}

export type BuildableState = BuilderState & { video: File };

function guessMime(ext: string): string {
  return (
    ({
      mp4: "video/mp4",
      m4v: "video/mp4",
      mov: "video/quicktime",
      webm: "video/webm",
      ogv: "video/ogg",
      ogg: "video/ogg"
    } as Record<string, string>)[ext] || "video/mp4"
  );
}

export async function buildScormZip(
  state: BuildableState,
  opts: BuildOptions = {}
): Promise<Blob> {
  const onProgress = opts.onProgress ?? (() => {});

  onProgress(5, "Reading video…");
  const videoBytes = await state.video.arrayBuffer();
  const videoExt = (state.video.name.split(".").pop() || "mp4").toLowerCase();
  const videoMime = state.video.type || guessMime(videoExt);
  const videoFilename = "video." + videoExt;

  onProgress(20, "Building manifest…");
  const manifest = buildManifest(state, videoFilename);

  onProgress(35, "Building player…");
  const indexHtml = buildIndexHtml(state, videoFilename, videoMime);
  const scormJs = buildScormJs();
  const styleCss = buildStyleCss();

  onProgress(55, "Zipping…");
  const zip = new JSZip();
  zip.file("imsmanifest.xml", manifest);
  zip.file("index.html", indexHtml);
  zip.file("scorm.js", scormJs);
  zip.file("style.css", styleCss);
  zip.file(videoFilename, videoBytes);

  const blob = await zip.generateAsync(
    {
      type: "blob",
      compression: "DEFLATE",
      compressionOptions: { level: 6 }
    },
    (meta) => {
      // 55-95% during zip
      onProgress(
        55 + Math.round(meta.percent * 0.4),
        "Zipping… " + Math.round(meta.percent) + "%"
      );
    }
  );

  onProgress(100, "Done — downloading.");
  return blob;
}

/**
 * Build a filesystem-safe filename stem from the course title. Strips
 * non-alphanumeric (except dash/underscore/space), collapses whitespace to
 * underscore, caps at 60 chars. Falls back to `scorm-package`.
 */
export function safeTitleStem(title: string): string {
  return (
    title
      .trim()
      .replace(/[^a-z0-9-_ ]/gi, "")
      .replace(/\s+/g, "_")
      .slice(0, 60) || "scorm-package"
  );
}
