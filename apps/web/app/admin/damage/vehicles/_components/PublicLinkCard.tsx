"use client";

// Shows the public Vehicle Guide link with a copy button. Client-side because
// the full URL needs this page's origin, which differs between staging and
// production -- the worker only knows the path.

import { useEffect, useState } from "react";

export function PublicLinkCard({ path }: { path: string }) {
  const [url, setUrl] = useState(path);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setUrl(`${window.location.origin}${path}`);
  }, [path]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt("Copy the Vehicle Guide link:", url);
    }
  }

  return (
    <div className="mb-6 rounded-splash-lg border border-gray-light bg-white p-5 shadow-splash-card">
      <h2 className="mb-1 text-base font-bold text-splash-navy">Link for site staff</h2>
      <p className="mb-3 text-sm text-splash-navy/70">
        Anyone with this link can read the guide without signing in. Share it with sites, not
        customers. If it leaks, an admin can change the token and this link stops working.
      </p>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <code className="min-w-0 flex-1 truncate rounded-splash-sm border border-gray-light bg-splash-navy/5 px-3 py-2 text-xs text-splash-navy">
          {url}
        </code>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={copy}
            className="rounded-splash-sm bg-splash-blue px-4 py-2 text-sm font-bold text-white shadow-splash-btn hover:bg-splash-blue-dark"
          >
            {copied ? "Copied" : "Copy link"}
          </button>
          <a
            href={path}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-splash-sm border border-splash-blue px-4 py-2 text-sm font-bold text-splash-blue hover:bg-splash-blue/5"
          >
            Open
          </a>
        </div>
      </div>
    </div>
  );
}
