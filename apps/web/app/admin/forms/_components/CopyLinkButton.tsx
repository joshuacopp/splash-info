"use client";

import { useState } from "react";

interface Props {
  slug: string;
}

export default function CopyLinkButton({ slug }: Props) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    const url = `${window.location.origin}/forms/${slug}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.warn("[CopyLinkButton] clipboard API failed", err);
      window.prompt("Copy form URL:", url);
    }
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      className={`inline-flex items-center rounded-splash-sm border px-2 py-0.5 text-xs font-semibold transition ${
        copied
          ? "border-splash-success bg-splash-success/10 text-splash-success"
          : "border-splash-blue bg-white text-splash-blue hover:bg-splash-blue/5"
      }`}
      aria-label={`Copy public link for form ${slug}`}
    >
      {copied ? "Copied ✓" : "Copy link"}
    </button>
  );
}
