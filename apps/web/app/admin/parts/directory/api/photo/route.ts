// Part photo upload — POST /admin/parts/directory/api/photo (multipart, field
// `file`). super_admin only.
//
// WHY THIS LIVES IN apps/web AND NOT ON THE WORKER. `splash-parts-manuals` is
// bound to apps/web as PARTS_FILES (see the [[r2_buckets]] block in
// apps/web/wrangler.toml); splash-workorders has no R2 binding at all. So the
// worker persists only `photo_r2_key` and the bytes are entirely this app's
// problem — upload here, serve from ../../photo/[...key], and delete on the
// DELETE proxy using the key the worker hands back.
//
// TWO-STEP UPLOAD, NOT ONE. The editor uploads the photo first, gets a key,
// and then includes that key in the JSON part payload. That keeps the worker's
// write endpoints pure JSON — which is load-bearing, because the required
// `Content-Type: application/json` IS their CSRF barrier (a multipart write
// would be a "simple request" and sail past the browser's preflight). The cost
// is an orphaned object when someone uploads a photo and then abandons the
// form; that is a few KB of R2 and is the right trade.
//
// MIME IS SNIFFED, NOT TRUSTED. The client's Content-Type on a multipart part
// is attacker-controlled, so a .html renamed to .jpg would otherwise land in
// the bucket with `text/html` and be served same-origin by the sibling GET
// route. apps/damage-worker/src/uploads.ts (this repo's reference R2 image
// upload) sniffs via the `file-type` package — but `file-type` is NOT a
// dependency of apps/web and the brief forbids adding one, so the magic-number
// table below covers exactly the five formats we accept. Same 8 MB cap and the
// same "reject empty" posture as damage-worker.
//
// The sniffed type is what goes on `httpMetadata.contentType`, so the serve
// route can echo a type the bytes actually justify.

import { getCloudflareContext } from "@opennextjs/cloudflare";
import { partsJsonError, requirePartsAdmin } from "../../_lib/admin-gate";

export const dynamic = "force-dynamic";

/** Matches apps/damage-worker/src/uploads.ts. Real part photos are phone
 *  snapshots in the 1-4 MB range; this is a safety net, not a target. */
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

/** Enough bytes for every signature below. ISO-BMFF compatible brands can run
 *  past the first 32 bytes, so we read the same ~4 KB `file-type` would. */
const SNIFF_BYTES = 4100;

/** R2 key prefix. The serve route refuses anything outside it — see the guard
 *  in ../../photo/[...key]/route.ts; the manuals live in the same bucket. */
const KEY_PREFIX = "parts-directory";

const EXT_FOR_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif"
};

/* ============================================================
 * Magic-number sniffing
 * ============================================================ */

/** Read `len` bytes at `off` as latin-1 — the four-character container tags in
 *  RIFF/ISO-BMFF headers are ASCII by specification. */
function tag(bytes: Uint8Array, off: number, len: number): string {
  let out = "";
  for (let i = off; i < off + len; i++) {
    const b = bytes[i];
    if (b === undefined) return "";
    out += String.fromCharCode(b);
  }
  return out;
}

function startsWith(bytes: Uint8Array, sig: readonly number[]): boolean {
  if (bytes.length < sig.length) return false;
  for (let i = 0; i < sig.length; i++) {
    if (bytes[i] !== sig[i]) return false;
  }
  return true;
}

const JPEG_SIG = [0xff, 0xd8, 0xff] as const;
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/** ISO-BMFF brands that mean "this is a still HEIF/HEIC image". */
const HEIF_BRANDS: Record<string, string> = {
  heic: "image/heic",
  heix: "image/heic",
  hevc: "image/heic",
  hevx: "image/heic",
  heim: "image/heic",
  heis: "image/heic",
  hevm: "image/heic",
  hevs: "image/heic",
  heif: "image/heif",
  mif1: "image/heif",
  msf1: "image/heif"
};

/**
 * The real media type of a file from its leading bytes, or null when it isn't
 * one of the five formats we accept. Deliberately narrow: anything unknown is
 * rejected rather than stored with a guessed type.
 */
function sniffImageMime(bytes: Uint8Array): string | null {
  if (startsWith(bytes, JPEG_SIG)) return "image/jpeg";
  if (startsWith(bytes, PNG_SIG)) return "image/png";

  // WebP is a RIFF container whose form type sits at byte 8.
  if (
    bytes.length >= 12 &&
    tag(bytes, 0, 4) === "RIFF" &&
    tag(bytes, 8, 4) === "WEBP"
  ) {
    return "image/webp";
  }

  // HEIC/HEIF: an ISO-BMFF `ftyp` box (size prefix at 0, "ftyp" at 4), major
  // brand at 8, then a list of compatible brands from 16 onward.
  if (bytes.length >= 12 && tag(bytes, 4, 4) === "ftyp") {
    const brands: string[] = [tag(bytes, 8, 4)];
    const end = Math.min(bytes.length, 64);
    for (let off = 16; off + 4 <= end; off += 4) {
      const b = tag(bytes, off, 4);
      if (b) brands.push(b);
    }
    // AVIF also carries `mif1` as a compatible brand. It is a perfectly good
    // image but it is not on the allow-list, and tagging it image/heif would
    // store it under a type no browser will render. Bail out explicitly.
    if (brands.includes("avif") || brands.includes("avis")) return null;
    for (const b of brands) {
      const mime = HEIF_BRANDS[b];
      if (mime) return mime;
    }
  }

  return null;
}

/** 10-char URL-safe random suffix — enough that two uploads into the same
 *  UUID folder can't collide, short enough to read off a log line. */
function shortRandom(len = 10): string {
  const alphabet =
    "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < len; i++) {
    out += alphabet[(bytes[i] ?? 0) % alphabet.length];
  }
  return out;
}

/* ============================================================
 * Handler
 * ============================================================ */

export async function POST(req: Request): Promise<Response> {
  const gate = await requirePartsAdmin();
  if (!gate.ok) return gate.response;

  // Bucket first: no point parsing 8 MB of multipart if there is nowhere to
  // put it. Modelled on ../../../_lib/manuals.ts — a missing binding is plain
  // `next dev`, not a fault, so it reads as 503 with an explanation.
  let bucket: R2Bucket | undefined;
  try {
    const { env } = await getCloudflareContext({ async: true });
    bucket = env?.PARTS_FILES;
  } catch {
    bucket = undefined;
  }
  if (!bucket) {
    return partsJsonError(
      503,
      "Photo storage isn't connected in this environment. Run the app with `wrangler dev` (or deploy) to upload photos."
    );
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch (err) {
    console.error("[parts.photo] formData parse failed", err);
    return partsJsonError(400, "That upload wasn't a readable form.");
  }

  const entry = form.get("file");
  if (!(entry instanceof File)) {
    return partsJsonError(400, "No file was attached.");
  }
  if (entry.size === 0) {
    return partsJsonError(400, "That file is empty.");
  }
  if (entry.size > MAX_UPLOAD_BYTES) {
    return partsJsonError(
      413,
      `That photo is larger than the ${Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)} MB limit.`
    );
  }

  // `slice()` returns a new Blob; the File itself is untouched, so `stream()`
  // below still yields the whole body.
  const head = new Uint8Array(await entry.slice(0, SNIFF_BYTES).arrayBuffer());
  const mime = sniffImageMime(head);
  if (!mime) {
    return partsJsonError(
      415,
      "That file isn't a JPEG, PNG, WebP, or HEIC image."
    );
  }

  const ext = EXT_FOR_MIME[mime] ?? "bin";
  const r2Key = `${KEY_PREFIX}/${crypto.randomUUID()}/${shortRandom()}.${ext}`;

  try {
    await bucket.put(r2Key, entry.stream(), {
      // The serve route echoes this back, so it has to be the sniffed type,
      // never the client's claim.
      httpMetadata: { contentType: mime },
      customMetadata: {
        uploadedBy: gate.session.email,
        uploadedAt: new Date().toISOString()
      }
    });
  } catch (err) {
    console.error("[parts.photo] R2 put failed for", r2Key, err);
    return partsJsonError(502, "Couldn't save that photo. Try again.");
  }

  console.log(`[parts.photo] stored ${r2Key} by ${gate.session.email}`);
  return Response.json({
    ok: true,
    r2_key: r2Key,
    mime,
    size_bytes: entry.size
  });
}
