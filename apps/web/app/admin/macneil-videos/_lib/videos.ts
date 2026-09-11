// MacNeil / NCS training video registry (/admin/macneil-videos).
//
// A plain list in code, deliberately: these are a handful of manufacturer
// training videos that change a few times a year, and version control plus a
// reviewable diff is worth more here than the ability to edit them without a
// deploy. If the list ever grows past what is comfortable to edit by hand, the
// Parts manuals pattern (a manifest in R2, see ../../parts/_lib/manuals.ts) is
// the natural next step.
//
// TO ADD A VIDEO: append an entry with the id from its YouTube URL — the
// `v=` parameter on a watch link, or the last path segment of a youtu.be or
// /embed/ link. `videoId()` below accepts a whole URL if that is easier.
//
// Titles are copied from YouTube rather than invented, so someone searching
// for a video they were told to watch finds it under the name they were given.

export interface MacneilVideo {
  /** YouTube video id — the 11-character code, not a URL. */
  id: string;
  title: string;
  /** Optional one-liner shown under the title. */
  description?: string;
}

/** YouTube ids are 11 chars of URL-safe base64. Anything else is a mistake —
 *  usually a whole URL pasted into the id field — and would render a card that
 *  plays nothing, so the page drops it rather than showing a dead tile. */
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

export function isValidVideoId(id: string): boolean {
  return VIDEO_ID_RE.test(id);
}

/**
 * Pull the id out of any ordinary YouTube link, or pass a bare id through.
 * Returns null when there is nothing that looks like an id, so a caller can
 * fail loudly instead of embedding a blank player.
 *
 * Handles: watch?v=ID, youtu.be/ID, /embed/ID, /shorts/ID, and a bare ID.
 */
export function videoId(input: string): string | null {
  const raw = input.trim();
  if (isValidVideoId(raw)) return raw;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  const fromQuery = url.searchParams.get("v");
  if (fromQuery && isValidVideoId(fromQuery)) return fromQuery;

  // youtu.be/ID, /embed/ID, /shorts/ID — in every case the id is the last
  // non-empty path segment.
  const segments = url.pathname.split("/").filter(Boolean);
  const last = segments[segments.length - 1];
  if (last && isValidVideoId(last)) return last;

  return null;
}

/** Thumbnail served straight from YouTube's image CDN. hqdefault exists for
 *  every video; maxresdefault does not, and 404s as a broken image. */
export function thumbnailUrl(id: string): string {
  return `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
}

/**
 * Player URL. youtube-nocookie.com is YouTube's privacy-enhanced host: it does
 * not write tracking cookies until playback starts. `rel=0` keeps the
 * end-screen suggestions within the same channel rather than sending a tech
 * off into unrelated recommendations.
 */
export function embedUrl(id: string, autoplay: boolean): string {
  const params = new URLSearchParams({ rel: "0" });
  if (autoplay) params.set("autoplay", "1");
  return `https://www.youtube-nocookie.com/embed/${id}?${params.toString()}`;
}

export const VIDEOS: MacneilVideo[] = [
  {
    id: "nnfYq5hrvUI",
    title: "Daily Walkthrough - NCS College of Clean",
    description: "The daily equipment walkthrough, start to finish."
  }
];
