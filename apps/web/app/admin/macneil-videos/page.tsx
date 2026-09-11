// MacNeil Videos (/admin/macneil-videos) — manufacturer training videos.
//
// Static list from _lib/videos, rendered as thumbnails that become players on
// click (see _components/VideoGrid). Auth posture matches Parts: any
// authenticated session, since middleware gates /admin/* and nothing here is
// per-location or per-role — these are public YouTube videos gathered in one
// place, not privileged data.

import Link from "next/link";
import { VideoGrid } from "./_components/VideoGrid";
import { VIDEOS } from "./_lib/videos";

export const metadata = { title: "MacNeil Videos" };

export default function MacneilVideosPage() {
  return (
    <section className="mx-auto w-full max-w-[1100px] px-5 py-9">
      <div className="mb-2 text-sm">
        <Link
          href="/admin/dashboard/operations/mechanical"
          className="text-splash-blue hover:underline"
        >
          ← Mechanical
        </Link>
      </div>

      <div className="mb-6">
        <p className="mb-1 text-xs font-semibold uppercase tracking-[0.18em] text-sudsy-blue">
          Training
        </p>
        <h1 className="text-2xl font-bold text-splash-navy">MacNeil Videos</h1>
        <p className="mt-1 text-sm text-splash-navy/70">
          Equipment training from MacNeil and National Carwash Solutions. Click a
          video to play it here, or open it on YouTube.
        </p>
      </div>

      <VideoGrid videos={VIDEOS} />
    </section>
  );
}
