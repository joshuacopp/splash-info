// IT Issue Tracker photos -- storage and serving.
//
// Photos ride along on the report, on "it happened again" and on an update
// note, and are recorded on THAT timeline event (`details.photos`), so the
// timeline shows what was seen when. The bytes live in the worker's own
// splash-workorder-files bucket under `it-issues/{issueId}/{uuid}.{ext}` --
// a separate prefix from the MaintainX attachment mirror, same bucket, no new
// binding (CLAUDE.md: cross-worker bucket sharing has bitten before).
//
// TYPE IS SNIFFED FROM THE BYTES, never taken from the upload. Only images are
// stored and they are served back with the sniffed type plus nosniff, so a
// renamed HTML file can never render on splashcarwashes.info.
//
// The apps/web form shrinks photos to a 2048px JPEG before upload (iPhone HEIC
// included), so the 10 MB cap is for the rare original that skipped that.

export interface PhotoEnv {
  WORKORDER_FILES?: R2Bucket;
}

export interface IssuePhoto {
  /** `{uuid}.{ext}` -- the key is `it-issues/{issueId}/{file}`. */
  file: string;
  mime: string;
  size: number;
  name: string;
}

export const MAX_PHOTOS_PER_ACTION = 5;
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

export const PHOTO_FILE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|gif|webp|heic)$/;

const EXT_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic"
};

/** Extension for a supported image, from its first bytes; null otherwise. */
export function sniffImage(b: Uint8Array): keyof typeof EXT_MIME | null {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "gif";
  const ascii = (from: number, to: number) => String.fromCharCode(...b.slice(from, to));
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "webp";
  if (ascii(4, 8) === "ftyp" && ["heic", "heix", "mif1", "msf1", "heim", "heis"].includes(ascii(8, 12))) return "heic";
  return null;
}

export function photoKey(issueId: string, file: string): string {
  return `it-issues/${issueId}/${file}`;
}

/**
 * Store the photos attached to one action. Bad or oversized files are skipped
 * and named in `rejected` rather than failing the whole report -- the issue
 * matters more than the picture.
 */
export async function storePhotos(
  env: PhotoEnv,
  issueId: string,
  files: File[]
): Promise<{ photos: IssuePhoto[]; rejected: string[] }> {
  const out = { photos: [] as IssuePhoto[], rejected: [] as string[] };
  if (files.length === 0) return out;
  if (!env.WORKORDER_FILES) {
    console.error("[it-issues] WORKORDER_FILES not bound; photos dropped");
    out.rejected.push(...files.map((f) => f.name || "photo"));
    return out;
  }
  for (const [i, f] of files.entries()) {
    const name = (f.name || `photo-${i + 1}`).slice(0, 120);
    if (i >= MAX_PHOTOS_PER_ACTION || f.size > MAX_PHOTO_BYTES) {
      out.rejected.push(name);
      continue;
    }
    const bytes = new Uint8Array(await f.arrayBuffer());
    const ext = sniffImage(bytes.subarray(0, 16));
    if (!ext) {
      out.rejected.push(name);
      continue;
    }
    const file = `${crypto.randomUUID()}.${ext}`;
    try {
      await env.WORKORDER_FILES.put(photoKey(issueId, file), bytes, {
        httpMetadata: { contentType: EXT_MIME[ext] }
      });
      out.photos.push({ file, mime: EXT_MIME[ext]!, size: bytes.byteLength, name });
    } catch (err) {
      console.error(`[it-issues] photo put failed for issue ${issueId}:`, err);
      out.rejected.push(name);
    }
  }
  return out;
}

/** Stream one photo. The caller has already checked access to the issue; the
 *  key is built from that issue's id, so a file name alone reaches nothing. */
export async function servePhoto(env: PhotoEnv, issueId: string, file: string): Promise<Response> {
  if (!PHOTO_FILE_RE.test(file)) return new Response("not found", { status: 404 });
  if (!env.WORKORDER_FILES) return new Response("photo storage not configured", { status: 503 });
  const obj = await env.WORKORDER_FILES.get(photoKey(issueId, file));
  if (!obj) return new Response("not found", { status: 404 });
  const ext = file.split(".").pop()!;
  return new Response(obj.body, {
    headers: {
      "Content-Type": EXT_MIME[ext] ?? "application/octet-stream",
      "Content-Length": String(obj.size),
      "Cache-Control": "private, max-age=3600",
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": `inline; filename="${file}"`
    }
  });
}
