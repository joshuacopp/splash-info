// Parts manual viewer (/admin/parts/{slug}).
//
// The manual is a self-contained HTML app that expects to own a viewport
// (body is `height:100vh; overflow:hidden` and it manages its own scroll
// panes), so it goes in an iframe sized to the space under the global header
// rather than in the normal page flow. ./file/route.ts streams the bytes.

import Link from "next/link";
import { notFound } from "next/navigation";
import { findManual, PartsBindingUnavailable } from "../_lib/manuals";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ slug: string }>;
}

async function lookup(slug: string) {
  try {
    return await findManual(slug);
  } catch (err) {
    if (err instanceof PartsBindingUnavailable) return undefined;
    throw err;
  }
}

export async function generateMetadata({ params }: PageProps) {
  const { slug } = await params;
  return { title: (await lookup(slug))?.title ?? "Parts" };
}

export default async function PartsManualPage({ params }: PageProps) {
  const { slug } = await params;
  const manual = await lookup(slug);
  if (!manual) notFound();

  const src = `/admin/parts/${manual.slug}/file`;

  return (
    <div className="flex h-[calc(100dvh-64px)] flex-col">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-splash-navy/10 bg-white px-5 py-2">
        <div className="flex items-baseline gap-3">
          <Link
            href="/admin/parts"
            className="text-sm text-splash-blue hover:underline"
          >
            ← Parts
          </Link>
          <h1 className="text-base font-bold text-splash-navy">
            {manual.title}
          </h1>
        </div>
        <a
          href={src}
          target="_blank"
          rel="noreferrer"
          className="text-xs font-semibold uppercase tracking-wide text-splash-blue hover:underline"
        >
          Open full screen →
        </a>
      </div>

      <iframe
        src={src}
        title={`${manual.title} parts manual`}
        className="min-h-0 flex-1 border-0"
      />
    </div>
  );
}
