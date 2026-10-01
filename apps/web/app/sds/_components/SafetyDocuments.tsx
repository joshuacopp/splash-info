"use client";

// The company's written safety programmes, downloadable by anyone signed in.
//
// A TAB ON THIS PAGE RATHER THAN A PAGE OF ITS OWN. Somebody reaching for the
// HazCom programme is already thinking about chemicals and safety data sheets,
// and that is where they look. A separate route would be one more thing to know
// exists.
//
// A DOCUMENT WITH NO FILE IS SHOWN, NOT HIDDEN. The row exists so the thing can
// be named before anybody has uploaded it. Hiding it would make a programme
// nobody has written look identical to one that does not apply -- and the first
// is a gap somebody has to close.

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import type { SafetyDocument } from "../_lib/types";

/** A site the caller may download a filled copy for. */
export interface DocSite {
  code: string;
  name: string;
}

/** The blank master, as a `<select>` value. Not a site code, and deliberately
 *  not the empty string, so "nothing chosen yet" could never be mistaken for
 *  it if this ever grows a required-selection mode. */
const BLANK = "__blank__";

function sizeLabel(bytes: number | null): string {
  if (!bytes) return "";
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function Row({
  doc,
  canUpload,
  site
}: {
  doc: SafetyDocument;
  canUpload: boolean;
  /** Null means the blank master. */
  site: DocSite | null;
}) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const base = `/forms/api/sds/safety-documents/${encodeURIComponent(doc.slug)}/file`;
  // Upload always targets the document itself, never a site's copy -- there is
  // one master and replacing it replaces it for everybody.
  const href = site ? `${base}?location=${encodeURIComponent(site.code)}` : base;

  async function upload(file: File) {
    setError(null);
    setBusy(true);
    try {
      const body = new FormData();
      body.set("file", file);
      const r = await fetch(base, { method: "POST", body, credentials: "include" });
      if (!r.ok) {
        const t = await r.text().catch(() => "");
        setError(
          t.includes("not_a_pdf")
            ? "That isn't a PDF."
            : t.includes("file_too_large")
              ? "That file is over 15 MB."
              : `Upload failed (${r.status}).`
        );
        return;
      }
      startTransition(() => router.refresh());
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <li className="flex flex-wrap items-start justify-between gap-3 border-t border-gray-light px-4 py-3">
      <div className="min-w-0">
        <div className="text-sm font-semibold text-splash-navy">{doc.title}</div>
        {doc.description ? (
          <div className="text-xs text-splash-navy/60">{doc.description}</div>
        ) : null}
        {doc.uploaded_at ? (
          <div className="mt-0.5 text-[0.6875rem] text-splash-navy/45">
            {sizeLabel(doc.size_bytes)}
            {doc.size_bytes ? " · " : ""}
            Uploaded {doc.uploaded_at.slice(0, 10)}
            {doc.uploaded_by ? ` by ${doc.uploaded_by}` : ""}
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="mt-1 text-xs text-racecar-red">
            {error}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-3">
        {doc.r2_key ? (
          /* The label names what you will GET, not what you are doing. Somebody
             with ten sites picking the wrong one is the failure this is for,
             and it is only avoidable if the button says which copy it is. */
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className="rounded-splash-sm bg-splash-navy px-3 py-1.5 text-xs font-bold text-white"
          >
            {site ? `Download for ${site.name}` : "Download blank"}
          </a>
        ) : (
          /* Stated plainly rather than as a disabled button. "Not uploaded yet"
             is a fact about the company's paperwork, not a permissions problem,
             and a greyed button reads as the latter. */
          <span className="text-xs text-amber-700">Not uploaded yet</span>
        )}
        {canUpload ? (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() => fileRef.current?.click()}
              className="text-xs text-splash-blue underline disabled:opacity-50"
            >
              {busy ? "Uploading…" : doc.r2_key ? "Replace" : "Upload"}
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="application/pdf,.pdf"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void upload(f);
              }}
            />
          </>
        ) : null}
      </div>
    </li>
  );
}

export default function SafetyDocuments({
  documents,
  canUpload,
  sites,
  defaultSite
}: {
  documents: SafetyDocument[];
  canUpload: boolean;
  /** Sites the caller may pull a filled copy for. Empty for an admin, whose
   *  access is "everything, no list" -- see the SDS page. */
  sites: DocSite[];
  /** Preselected when the caller has exactly one site, or came in with one in
   *  the URL. Null elsewhere, so nobody with ten sites is handed one at
   *  random. */
  defaultSite: string | null;
}) {
  // One site and no choice to make: preselect it. More than one and the
  // selection starts BLANK rather than on a guess -- a wrong site's emergency
  // contacts printed on a safety programme is worse than no contacts, because
  // the blank version visibly needs filling in and the wrong one does not.
  const [selected, setSelected] = useState<string>(
    defaultSite && sites.some((s) => s.code === defaultSite) ? defaultSite : BLANK
  );
  const site = sites.find((s) => s.code === selected) ?? null;

  return (
    <section>
      <p className="mb-3 text-sm text-splash-navy/70">
        The company&rsquo;s written safety programmes. These are the same for
        every site &mdash; download and keep a copy with your binder. The Safety
        Center checklist links to them too, when it finds one missing.
      </p>

      {sites.length > 0 ? (
        <div className="mb-4 rounded-splash-md border border-gray-light bg-white p-4">
          <label
            htmlFor="safety-doc-site"
            className="block text-xs font-bold uppercase tracking-wide text-splash-navy/60"
          >
            Fill in for
          </label>
          <select
            id="safety-doc-site"
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            className="mt-1.5 w-full max-w-sm rounded-splash-sm border border-gray-light px-3 py-2 text-sm text-splash-navy"
          >
            <option value={BLANK}>Blank copy &mdash; fill in by hand</option>
            {sites.map((s) => (
              <option key={s.code} value={s.code}>
                {s.name}
              </option>
            ))}
          </select>
          <p className="mt-2 text-xs text-splash-navy/60">
            {site
              ? `The site name, address and the emergency contacts for ${site.name} are printed onto the copy you download.`
              : "Choose a site to have its name, address and emergency contacts printed on. Documents without those blanks download the same either way."}
          </p>
        </div>
      ) : null}

      <ul className="rounded-splash-md border border-gray-light bg-white">
        {documents.map((d) => (
          <Row key={d.slug} doc={d} canUpload={canUpload} site={site} />
        ))}
      </ul>
      {documents.length === 0 ? (
        <p className="p-6 text-sm text-splash-navy/70">
          No safety documents are set up yet.
        </p>
      ) : null}
    </section>
  );
}
