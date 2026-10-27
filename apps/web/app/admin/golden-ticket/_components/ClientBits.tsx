"use client";

// Small client islands for /admin/golden-ticket.

import { useEffect, useState } from "react";
import { useFormStatus } from "react-dom";

/** The site lookup link with a copy button. Client-side because the full URL
 *  needs this page's origin (staging vs production); the worker only knows
 *  the path. */
export function LookupLink({ path }: { path: string }) {
  const [url, setUrl] = useState(path);
  const [copied, setCopied] = useState(false);
  useEffect(() => setUrl(`${window.location.origin}${path}`), [path]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt("Copy the Golden Ticket lookup link:", url);
    }
  }

  return (
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
  );
}

/** Submit button that asks first. */
export function ConfirmButton({
  label,
  pendingLabel,
  confirmText,
  className
}: {
  label: string;
  pendingLabel: string;
  confirmText: string;
  className: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className={className}
      onClick={(e) => {
        if (!window.confirm(confirmText)) e.preventDefault();
      }}
    >
      {pending ? pendingLabel : label}
    </button>
  );
}
