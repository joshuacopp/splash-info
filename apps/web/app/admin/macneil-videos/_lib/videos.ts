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
  /** Which VIDEO_GROUPS entry this belongs under. */
  group: string;
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

/** An equipment category. Order here is the order sections render in. */
export interface VideoGroup {
  id: string;
  label: string;
  /**
   * Extra search terms for every video in the group, so a tech can find the
   * top brush by typing "top" when no title contains that word. Titles are
   * searched too — searching "bearing" crosses every group.
   */
  keywords: string[];
}

export const VIDEO_GROUPS: VideoGroup[] = [
  { id: "xr1000", label: "XR1000 Conveyor", keywords: ["conveyor", "xr1000", "xr 1000"] },
  { id: "rs1000", label: "RS1000 Top Brush", keywords: ["top", "top brush", "rs1000", "rs 1000"] },
  { id: "boss", label: "Wheel Boss / Gloss Boss", keywords: ["wheel", "tire", "shine", "boss"] },
  { id: "rs701", label: "RS701 Wrap", keywords: ["wrap", "701", "rs701", "rs 701"] },
  { id: "rs400-301", label: "RS400 / RS301 Side Brush", keywords: ["van", "high side", "short side", "baby", "400", "301", "rs400", "rs301", "side"] },
  { id: "magnum", label: "Magnum High Pressure", keywords: ["pressure", "arch", "magnum"] },
  { id: "blowers", label: "Blowers", keywords: ["blower", "dryer", "dry"] },
  { id: "general", label: "General", keywords: ["general", "site", "walkthrough"] },
];

export const VIDEOS: MacneilVideo[] = [
  // ---- XR1000 Conveyor ----
  { id: "qvXzLyBldz0", group: "xr1000", title: "XR 1000 Slide Assembly Bushings Replacement" },
  { id: "BiyWKxOxAoA", group: "xr1000", title: "XR 1000 Prox Switch and Rotary Encoder Replacement" },
  { id: "B05DdlLTN7w", group: "xr1000", title: "XR 1000 Take up Drum Replacement" },
  { id: "0aH2THpKtBw", group: "xr1000", title: "XR 1000 Roller Replacement" },
  { id: "l1cki1zT0xo", group: "xr1000", title: "XR 1000 Removing Chain Link" },
  { id: "mlJ8mv7guts", group: "xr1000", title: "XR 1000 Motor and HECO Replacement" },
  { id: "sLSq25A6asU", group: "xr1000", title: "XR 1000 Lubrication Points and Frequency" },
  { id: "wGCWKSjddbU", group: "xr1000", title: "XR 1000 Drive up Sprocket Replacement" },
  { id: "hGeswRcuCmc", group: "xr1000", title: "XR 1000 Call up Fork and Cylinders Replacement" },
  { id: "rloU7m1E7gE", group: "xr1000", title: "XR 1000 Air Shock Replacement" },
  // ---- RS1000 Top Brush ----
  { id: "cZfnWb6-T5U", group: "rs1000", title: "RS 1000 Air Cylinder Replacement" },
  { id: "E1g5CQ1zIFk", group: "rs1000", title: "RS 1000 Shaft and Bearing Replacement" },
  { id: "cPpZ4aBNUrw", group: "rs1000", title: "RS 1000 Motor Replacement" },
  { id: "CXqlKXgbfMs", group: "rs1000", title: "RS 1000 Lubrication Points" },
  { id: "tcgKsnrNiIs", group: "rs1000", title: "RS 1000 Leveling and Balancing" },
  { id: "PAeeIXrvPVs", group: "rs1000", title: "RS 1000 Core and Foam Replacement" },
  // ---- Wheel Boss / Gloss Boss ----
  { id: "NNTUjhS0EsY", group: "boss", title: "Wheel Boss and Gloss Boss Motor Replacement" },
  { id: "is4UwVR-aCU", group: "boss", title: "Wheel Boss and Gloss Boss Lubrication Points and Frequency" },
  { id: "Zjepb6od08Y", group: "boss", title: "Wheel Boss and Gloss Boss Cylinder Replacement" },
  { id: "2wyalbJo0E0", group: "boss", title: "Wheel Boss and Gloss Boss Bearing Replacement" },
  // ---- RS701 Wrap ----
  { id: "e8m0y0X8K3o", group: "rs701", title: "RS 701 Secondary Arm Bearing Replacement" },
  { id: "ugOn4WtGWQo", group: "rs701", title: "RS 701 Motor and Shaft Replacement" },
  { id: "diNrp2eF2cg", group: "rs701", title: "RS 701 Main Arm Bearing Replacement" },
  { id: "Vm_MhJbTsVk", group: "rs701", title: "RS 701 Lubrication Points" },
  { id: "Z74Xmp6puck", group: "rs701", title: "RS 701 Locking the Wrap Back" },
  { id: "ME89EHIMv7M", group: "rs701", title: "RS 701 Knuckle Bushing Replacement" },
  { id: "D9gPCgA2Ht8", group: "rs701", title: "RS 701 Flo Controls" },
  { id: "LvYTenYFCs4", group: "rs701", title: "RS 701 Core and Foam Replacement" },
  { id: "eopWlfFHj0A", group: "rs701", title: "RS 701 Air Panel and Best Practices" },
  { id: "tkkbIw4QXWc", group: "rs701", title: "RS 701 Air Cylinder Replacement" },
  // ---- RS400 / RS301 Side Brush ----
  { id: "NI2HzglqdoA", group: "rs400-301", title: "RS 400 301 Shaft and Motor Replacement" },
  { id: "qctLJoiGblU", group: "rs400-301", title: "RS 400 301 Bearing Replacement" },
  { id: "_UeQe1qvfUw", group: "rs400-301", title: "RS 400 301 Shaft and Motor Replacement" },
  { id: "ngTysZARu7M", group: "rs400-301", title: "RS 400 301 Lubrication Points" },
  { id: "_pte9F6xfXM", group: "rs400-301", title: "RS 400 301 Core and Foam Replacement" },
  { id: "4LiLUyAAMTQ", group: "rs400-301", title: "RS 400 301 Air Cylinder Replacement" },
  // ---- Magnum High Pressure ----
  { id: "nzMU_XSmXlM", group: "magnum", title: "Unclogging High Pressure Nozzles" },
  { id: "gNCDD5uhgd8", group: "magnum", title: "Magnum Force Air Cylinder Replacement" },
  { id: "4YM5tVCNhYU", group: "magnum", title: "Magnum Force Adjustment" },
  // ---- Blowers ----
  { id: "nJunvyqWFlI", group: "blowers", title: "Blower Impeller Replacement" },
  // ---- General ----
  { id: "nnfYq5hrvUI", group: "general", title: "Daily Walkthrough" },
  { id: "MF4-V35myVM", group: "general", title: "Photo Eyes Operations and Re Alignment" },
  { id: "Jk1UKDrzLr8", group: "general", title: "Clocking a Motor" },
  { id: "F-QgyDri26Y", group: "general", title: "Powerlock Maintenance" },
];

/**
 * Everything a search query is matched against for one video: its title plus
 * its group's label and keywords. Built once per video by the grid.
 */
export function searchText(video: MacneilVideo, groups: VideoGroup[]): string {
  const group = groups.find((g) => g.id === video.group);
  return [video.title, group?.label ?? "", ...(group?.keywords ?? [])]
    .join(" ")
    .toLowerCase();
}
