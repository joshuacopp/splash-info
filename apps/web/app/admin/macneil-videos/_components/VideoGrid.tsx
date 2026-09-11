"use client";

// Searchable, grouped video library.
//
// No iframe exists until someone clicks a card. That is the point of the
// thumbnail step and it matters more at 44 videos than it did at one: a
// YouTube embed pulls several hundred KB and runs its own scripts, so a page of
// always-live players would be tens of megabytes. A thumbnail is one ~15 KB
// JPEG from YouTube's image CDN, and they load lazily besides.
//
// One player at a time. Clicking a second card stops the first, because two
// training videos talking over each other is never what someone meant.
//
// Search matches the title AND the group's keywords, which are two different
// jobs. "bearing" is a title search and deliberately crosses equipment — the
// same repair on four machines is exactly what someone wants to compare.
// "conveyor" or "baby" matches no title at all; those are the words techs
// actually say, mapped onto equipment by the keyword lists in _lib/videos.

import { useMemo, useState } from "react";
import {
  embedUrl,
  isValidVideoId,
  searchText,
  thumbnailUrl,
  type MacneilVideo,
  type VideoGroup
} from "../_lib/videos";

interface Props {
  videos: MacneilVideo[];
  groups: VideoGroup[];
}

export function VideoGrid({ videos, groups }: Props) {
  const [playing, setPlaying] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  // A malformed id renders a card that plays nothing, so drop it here rather
  // than showing a tile that silently fails when clicked.
  const playable = useMemo(() => videos.filter((v) => isValidVideoId(v.id)), [videos]);

  // Built once, not per keystroke.
  const haystacks = useMemo(() => {
    const map = new Map<string, string>();
    for (const v of playable) map.set(v.id, searchText(v, groups));
    return map;
  }, [playable, groups]);

  const needle = query.trim().toLowerCase();

  const matches = useMemo(() => {
    if (!needle) return playable;
    // Every whitespace-separated term must match somewhere, so "701 bearing"
    // narrows instead of widening.
    const terms = needle.split(/\s+/);
    return playable.filter((v) => {
      const hay = haystacks.get(v.id) ?? "";
      return terms.every((t) => hay.includes(t));
    });
  }, [playable, haystacks, needle]);

  // Sections in registry order, empty ones dropped so a search does not leave
  // a column of headings with nothing under them.
  const sections = useMemo(
    () =>
      groups
        .map((group) => ({ group, items: matches.filter((v) => v.group === group.id) }))
        .filter((s) => s.items.length > 0),
    [groups, matches]
  );

  return (
    <>
      <div className="mb-7 flex flex-wrap items-center gap-3">
        <div className="relative min-w-[260px] flex-1">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search — bearing, motor, conveyor, wrap, baby…"
            aria-label="Search videos"
            className="w-full rounded-splash-md border-2 border-gray-light bg-white px-4 py-2.5 text-sm text-splash-navy outline-none focus:border-splash-blue"
          />
        </div>
        <p className="text-sm font-semibold text-splash-navy/60">
          {needle
            ? `${matches.length} of ${playable.length} video${playable.length === 1 ? "" : "s"}`
            : `${playable.length} videos`}
        </p>
      </div>

      {sections.length === 0 ? (
        <div className="rounded-splash-md border border-gray-light bg-white px-4 py-8 text-center italic text-splash-navy/60">
          Nothing matches &ldquo;{query}&rdquo;. Try a part name (bearing, motor,
          cylinder) or a machine (conveyor, wrap, top brush).
        </div>
      ) : (
        sections.map(({ group, items }) => (
          <section key={group.id} className="mb-10">
            <div className="mb-4 flex items-baseline gap-3 border-b-2 border-gray-light pb-2">
              <h2 className="text-lg font-bold text-splash-navy">{group.label}</h2>
              <span className="text-xs font-semibold uppercase tracking-[0.14em] text-splash-navy/50">
                {items.length} {items.length === 1 ? "video" : "videos"}
              </span>
            </div>

            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {items.map((video) => {
                const isPlaying = playing === video.id;
                return (
                  <div
                    key={video.id}
                    className="flex flex-col overflow-hidden rounded-splash-lg border-[3px] border-splash-navy bg-white shadow-splash-card"
                  >
                    <div className="relative aspect-video bg-splash-navy">
                      {isPlaying ? (
                        <iframe
                          // autoplay because the click that got here IS the
                          // play gesture; without it the viewer clicks twice.
                          src={embedUrl(video.id, true)}
                          title={video.title}
                          className="absolute inset-0 h-full w-full"
                          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                          referrerPolicy="strict-origin-when-cross-origin"
                          allowFullScreen
                        />
                      ) : (
                        <button
                          type="button"
                          onClick={() => setPlaying(video.id)}
                          aria-label={`Play ${video.title}`}
                          className="group absolute inset-0 h-full w-full"
                        >
                          {/* Plain <img>, not next/image: these are remote
                              YouTube CDN URLs, and routing them through the
                              optimizer would mean configuring remotePatterns
                              to gain nothing — the CDN already serves a
                              correctly sized JPEG. */}
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={thumbnailUrl(video.id)}
                            alt=""
                            loading="lazy"
                            className="h-full w-full object-cover"
                          />
                          <span className="absolute inset-0 flex items-center justify-center bg-splash-navy/25 transition-colors group-hover:bg-splash-navy/10">
                            <span className="flex h-14 w-14 items-center justify-center rounded-full bg-white/95 shadow-splash-card transition-transform duration-150 group-hover:scale-110">
                              <svg
                                viewBox="0 0 24 24"
                                fill="currentColor"
                                className="ml-1 h-6 w-6 text-splash-navy"
                                aria-hidden="true"
                              >
                                <polygon points="6 4 20 12 6 20 6 4" />
                              </svg>
                            </span>
                          </span>
                        </button>
                      )}
                    </div>

                    <div className="flex flex-1 flex-col gap-1.5 px-5 pb-4 pt-4">
                      <h3 className="text-[0.9375rem] font-bold leading-snug text-splash-navy">
                        {video.title}
                      </h3>
                      <a
                        href={`https://www.youtube.com/watch?v=${video.id}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-auto self-start pt-1 text-xs font-bold uppercase tracking-[0.08em] text-splash-blue hover:underline"
                      >
                        Watch on YouTube
                      </a>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        ))
      )}
    </>
  );
}
