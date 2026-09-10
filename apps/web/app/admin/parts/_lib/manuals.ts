// Parts manual registry (/admin/parts) — backed by R2, not by this file.
//
// The bucket (`splash-parts-manuals`, bound as PARTS_FILES) holds one
// self-contained HTML file per manual. Dropping a .html in the bucket is
// enough to publish it: the listing is derived from the bucket itself, and
// the manual's title is read out of its own <title> tag.
//
// `manifest.json` at the bucket root is OPTIONAL and purely editorial. It
// supplies the things a filename can't — model eyebrow, description, and the
// display order — for the keys it names:
//
//   [
//     { "slug": "xr1000", "model": "XR1000", "title": "XR1000",
//       "description": "...", "key": "xr1000.html" }
//   ]
//
// Precedence: manifest-named keys come first, in manifest order, using their
// curated fields. Every other .html in the bucket is appended, sorted by
// title, with a slug derived from its filename. A manifest entry pointing at
// a key that no longer exists is dropped, so a deleted upload can't leave a
// dead card behind.
//
// A manual's HTML is multi-MB with its images inlined as base64, so nothing
// here ever reads a whole file. Title sniffing is a ranged read of the first
// few KB, and only for keys the manifest didn't already describe — curated
// entries cost one list + one manifest GET no matter how many there are. The
// bytes are streamed to the browser by ../[slug]/file/route.ts.
//
// Slugs are the URL segment AND the lookup key for that route, so they're
// validated on both paths: anything outside [a-z0-9-] is dropped rather than
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

/** Enough of the file to reach <title>; these documents front-load their head. */
const TITLE_SNIFF_BYTES = 8192;

/**
 * Thrown when the bucket binding is missing entirely — i.e. plain `next dev`
 * without a Cloudflare context. Distinguished from "bucket is reachable but
 * has no manuals" so the page can tell the two apart.
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

/** Every .html key in the bucket, following pagination to the end. */
async function listHtmlKeys(b: R2Bucket): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await b.list({ cursor });
    for (const o of page.objects) {
      if (o.key.toLowerCase().endsWith(".html")) keys.push(o.key);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return keys;
}

/**
 * Filename → slug. Drops the .html and the boilerplate
 * "-Interactive-Parts-Manual" suffix these exports carry, then reduces what's
 * left to the [a-z0-9-] the route accepts:
 *   "M2000R-Pumping-Station-Interactive-Parts-Manual.html" -> "m2000r-pumping-station"
 * Returns "" when nothing usable survives, which the caller skips.
 */
export function slugFromKey(key: string): string {
  return key
    .replace(/\.html?$/i, "")
    .replace(/[-_\s]*interactive[-_\s]*parts[-_\s]*manual$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Pull the document title out of the first chunk of an HTML file. Strips the
 * trailing "— Interactive Parts Manual" (any dash flavour) so the card shows
 * the equipment, not the boilerplate. Undefined if there's no usable <title>.
 */
export function titleFromHtml(head: string): string | undefined {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head);
  if (!m?.[1]) return undefined;
  const text = m[1]
    .replace(/\s+/g, " ")
    .replace(/\s*[–—|-]\s*interactive parts (manual|list)\s*$/i, "")
    .trim();
  return text || undefined;
}

/** Title-case-ish fallback when a file has no <title>: "rs301" -> "Rs301". */
function titleFromSlug(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

async function sniffTitle(
  b: R2Bucket,
  key: string
): Promise<string | undefined> {
  try {
    const obj = await b.get(key, {
      range: { offset: 0, length: TITLE_SNIFF_BYTES }
    });
    if (!obj) return undefined;
    return titleFromHtml(await obj.text());
  } catch (err) {
    console.error("[parts] could not sniff title for", key, err);
    return undefined;
  }
}

/** Manifest entries, in file order, minus anything malformed or duplicated. */
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

async function readManifest(b: R2Bucket): Promise<PartsManual[]> {
  const obj = await b.get(MANIFEST_KEY);
  if (!obj) return [];
  try {
    return parseManifest(JSON.parse(await obj.text()));
  } catch (err) {
    console.error("[parts] manifest.json is not valid JSON", err);
    return [];
  }
}

/**
 * The published shelf: every .html in the bucket, curated by manifest.json
 * where it has an opinion. Returns [] for an empty bucket; throws
 * PartsBindingUnavailable only when there's no bucket to ask.
 */
export async function listManuals(): Promise<PartsManual[]> {
  const b = await bucket();
  const [htmlKeys, manifest] = await Promise.all([
    listHtmlKeys(b),
    readManifest(b)
  ]);

  const present = new Set(htmlKeys);
  const curated: PartsManual[] = [];
  const usedKeys = new Set<string>();
  const usedSlugs = new Set<string>();

  // Curated first, in manifest order — but only if the file is still there.
  for (const m of manifest) {
    if (!present.has(m.key) || usedKeys.has(m.key)) continue;
    usedKeys.add(m.key);
    usedSlugs.add(m.slug);
    curated.push(m);
  }

  // Whatever's left in the bucket, titled from its own <title>.
  const extras = htmlKeys.filter((k) => !usedKeys.has(k));
  const settled = await Promise.all(
    extras.map(async (key) => {
      const slug = slugFromKey(key);
      if (!SLUG_RE.test(slug) || usedSlugs.has(slug)) return undefined;
      usedSlugs.add(slug);
      return {
        slug,
        key,
        model: "",
        title: (await sniffTitle(b, key)) ?? titleFromSlug(slug),
        description: ""
      } satisfies PartsManual;
    })
  );

  const derived = settled
    .filter((m): m is PartsManual => m !== undefined)
    .sort((a, z) => a.title.localeCompare(z.title));

  // Manifest order is deliberate, so it leads; the uncurated tail is sorted.
  return [...curated, ...derived];
}

export async function findManual(
  slug: string
): Promise<PartsManual | undefined> {
  if (!SLUG_RE.test(slug)) return undefined;
  return (await listManuals()).find((m) => m.slug === slug);
}
