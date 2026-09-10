// Parts manual registry (/admin/parts) — backed by R2, not by this file.
//
// The bucket (`splash-parts-manuals`, bound as PARTS_FILES) holds one
// self-contained HTML file per manual plus a `manifest.json` at the root that
// lists them. Adding a manual is two uploads — the .html and a replacement
// manifest — with no code change and no deploy.
//
// manifest.json shape:
//   [
//     { "slug": "xr1000", "model": "XR1000", "title": "XR1000",
//       "description": "...", "key": "xr1000.html" }
//   ]
//
// A manual's HTML is multi-MB with its images inlined as base64, so nothing
// here ever reads the file itself — only the manifest. The bytes are streamed
// straight from R2 to the browser by ../[slug]/file/route.ts.
//
// Slugs are the URL segment AND the lookup key for that route, so they're
// validated on read: anything outside [a-z0-9-] is dropped rather than
// rejected loudly, so one bad manifest entry can't take down the whole page.

import { getCloudflareContext } from "@opennextjs/cloudflare";

export interface PartsManual {
  /** URL segment: /admin/parts/{slug}. Lowercase alphanumeric + dashes. */
  slug: string;
  /** Equipment model — the eyebrow above the title on the index card. */
  model: string;
  title: string;
  description: string;
  /** R2 object key for the manual's HTML. */
  key: string;
}

export const MANIFEST_KEY = "manifest.json";

const SLUG_RE = /^[a-z0-9-]+$/;

/**
 * Thrown when the bucket binding is missing entirely — i.e. plain `next dev`
 * without a Cloudflare context. Distinguished from "bucket is reachable but
 * has no manifest" so the page can tell the two apart.
 */
export class PartsBindingUnavailable extends Error {}

async function bucket(): Promise<R2Bucket> {
  let env: CloudflareEnv;
  try {
    ({ env } = await getCloudflareContext({ async: true }));
  } catch {
    throw new PartsBindingUnavailable("no Cloudflare context");
  }
  if (!env?.PARTS_FILES) {
    throw new PartsBindingUnavailable("PARTS_FILES binding not bound");
  }
  return env.PARTS_FILES;
}

function parseManifest(raw: unknown): PartsManual[] {
  if (!Array.isArray(raw)) return [];
  const out: PartsManual[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const slug = typeof e.slug === "string" ? e.slug : "";
    const key = typeof e.key === "string" ? e.key : "";
    if (!SLUG_RE.test(slug) || key === "" || seen.has(slug)) continue;
    seen.add(slug);
    out.push({
      slug,
      key,
      model: typeof e.model === "string" ? e.model : "",
      title: typeof e.title === "string" && e.title ? e.title : slug,
      description: typeof e.description === "string" ? e.description : ""
    });
  }
  return out;
}

/**
 * Read + parse manifest.json. Returns [] when the object is absent or
 * unparseable (an empty shelf, which the index page renders as such);
 * throws PartsBindingUnavailable only when there's no bucket to ask.
 */
export async function listManuals(): Promise<PartsManual[]> {
  const obj = await (await bucket()).get(MANIFEST_KEY);
  if (!obj) return [];
  try {
    return parseManifest(JSON.parse(await obj.text()));
  } catch (err) {
    console.error("[parts] manifest.json is not valid JSON", err);
    return [];
  }
}

export async function findManual(
  slug: string
): Promise<PartsManual | undefined> {
  if (!SLUG_RE.test(slug)) return undefined;
  return (await listManuals()).find((m) => m.slug === slug);
}
