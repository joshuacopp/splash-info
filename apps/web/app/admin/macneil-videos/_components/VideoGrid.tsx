"use client";

// Thumbnail grid that swaps a card to a live player when clicked.
//
// No iframe exists until someone clicks one. That is the whole point of the
// thumbnail step: a YouTube embed pulls several hundred KB and runs its own
// scripts, so a page of always-live embeds is slow in proportion to how many
// videos we add — exactly the wrong way round. A thumbnail is one ~15 KB JPEG
// from YouTube's image CDN.
//
// One player at a time. Clicking a second card stops the first, because two
// training videos talking over each other is never what someone meant.

import { useState } from "react";
import { embedUrl, isValidVideoId, thumbnailUrl, type MacneilVideo } from "../_lib/videos";

export function VideoGrid({ videos }: { videos: MacneilVideo[] }) {
  const [playing, setPlaying] = useState<string | null>(null);

  // A malformed id renders a card that plays nothing, so drop it here rather
  // than showing a tile that silently fails when clicked.
  const playable = videos.filter((v) => isValidVideoId(v.id));

  if (playable.length === 0) {
    return (
      <div className="rounded-splash-md border border-gray-light bg-white px-4 py-8 text-center italic text-splash-navy/60">
        No videos added yet.
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
      {playable.map((video) => {
        const isPlaying = playing === video.id;
        return (
          <div
            key={video.id}
            className="flex flex-col overflow-hidden rounded-splash-lg border-[3px] border-splash-navy bg-white shadow-splash-card"
          >
            <div className="relative aspect-video bg-splash-navy">
              {isPlaying ? (
                <iframe
                  // autoplay because the click that got here IS the play
                  // gesture; without it the viewer clicks twice.
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
                  {/* Plain <img>, not next/image: these are remote YouTube CDN
                      URLs, and routing them through the optimizer would mean
                      configuring remotePatterns to gain nothing — the CDN
                      already serves a correctly sized JPEG. */}
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

            <div className="flex flex-1 flex-col gap-1.5 px-5 pb-5 pt-4">
              <h2 className="text-[0.9375rem] font-bold leading-snug text-splash-navy">
                {video.title}
              </h2>
              {video.description && (
                <p className="text-sm leading-relaxed text-splash-navy/70">
                  {video.description}
                </p>
              )}
              <a
                href={`https://www.youtube.com/watch?v=${video.id}`}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-1 self-start text-xs font-bold uppercase tracking-[0.08em] text-splash-blue hover:underline"
              >
                Watch on YouTube
              </a>
            </div>
          </div>
        );
      })}
    </div>
  );
}
