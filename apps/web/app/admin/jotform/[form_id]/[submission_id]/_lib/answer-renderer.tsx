// Brief 112 — type-dispatched value renderer for the JotForm submission
// detail page.
//
// The Brief 109 detail page iterated `Object.keys(row.answers)`
// alphabetically and rendered each entry with a coarse
// `typeof object → JSON.stringify` fallback. With sample-data per form
// type now in hand the renderer can dispatch per `answers[KEY].type` and
// produce a coherent form-shaped page: signatures inline as images,
// file uploads as a thumbnail grid, fullname / datetime / phone /
// checkbox preferring the JotForm-precomputed `prettyFormat`, and
// empty answers skipped entirely (so PTO Day 2-5 fields on
// time-card-edit don't spam the page with em-dashes).
//
// Brief 113 retargeted the `control_signature` + `control_fileupload`
// renderers at the worker-side asset proxy
// (`/admin/jotform/api/asset?url=...`) so the browser loads JotForm
// CDN-hosted assets same-origin via the apps/web session cookie. The
// worker attaches the `JOTFORM_API_KEY` to the upstream fetch; without
// that, JotForm's CDN 401s every hot-link.
//
// Adding a 17th answer type means extending the `switch` in
// `renderAnswerValue` — the default branch renders the bare `answer`
// string and is sufficient for any text-shaped type.

import type React from "react";
import { assetProxyUrl } from "../../../_lib/worker-fetch";

export interface AnswerEntry {
  name?: string;
  text?: string;
  type?: string;
  order?: string | number;
  answer?: unknown;
  prettyFormat?: string;
}

/**
 * Decide whether a given answer entry has content worth rendering.
 * Used to filter out the many optional fields (especially on
 * time-card-edit) that would otherwise spam the page with empty rows.
 */
export function hasContent(entry: AnswerEntry): boolean {
  if (typeof entry.prettyFormat === "string" && entry.prettyFormat.trim()) {
    return true;
  }
  const a = entry.answer;
  if (a == null) return false;
  if (typeof a === "string") return a.trim().length > 0;
  if (typeof a === "number" || typeof a === "boolean") return true;
  if (Array.isArray(a)) return a.length > 0;
  if (typeof a === "object") return Object.keys(a).length > 0;
  return false;
}

/**
 * Return a stable display-order key for an answer entry. Prefer the
 * JotForm builder's `order` field (form-display order); fall back to
 * the answer-key string. Order is a stringified integer in payloads —
 * parse to number so 2 < 10.
 */
export function orderKey(entry: AnswerEntry, fallbackKey: string): number {
  const o = entry.order;
  if (typeof o === "number") return o;
  if (typeof o === "string" && /^\d+$/.test(o)) return Number.parseInt(o, 10);
  const k = Number.parseInt(fallbackKey, 10);
  return Number.isFinite(k) ? k + 100000 : 100000;
}

/**
 * Type-dispatched value renderer. Returns a React node for the value
 * portion of the {label, value} pair. Callers handle the label themselves
 * (entry.text || entry.name || fallbackKey).
 */
export function renderAnswerValue(entry: AnswerEntry): React.ReactNode {
  const pretty =
    typeof entry.prettyFormat === "string" ? entry.prettyFormat.trim() : "";

  switch (entry.type) {
    case "control_signature": {
      const url = typeof entry.answer === "string" ? entry.answer.trim() : "";
      if (!url) return null;
      return (
        <img
          src={assetProxyUrl(url)}
          alt="Signature"
          className="max-w-xs border border-splash-navy/20 bg-white p-1"
        />
      );
    }
    case "control_fileupload": {
      const items = Array.isArray(entry.answer)
        ? (entry.answer as unknown[]).filter(
            (x): x is string => typeof x === "string" && x.startsWith("http")
          )
        : [];
      if (items.length === 0) return null;
      return (
        <div className="flex flex-wrap gap-2">
          {items.map((url) => (
            <a
              key={url}
              href={assetProxyUrl(url)}
              target="_blank"
              rel="noreferrer"
            >
              <img
                src={assetProxyUrl(url)}
                alt="Upload"
                className="h-24 w-24 border border-splash-navy/20 object-cover"
              />
            </a>
          ))}
        </div>
      );
    }
    case "control_fullname":
    case "control_datetime":
    case "control_phone":
    case "control_checkbox":
      if (pretty) return <span>{pretty}</span>;
      break;
    default:
      break;
  }

  const a = entry.answer;
  if (typeof a === "string") {
    return <span className="whitespace-pre-wrap break-words">{a}</span>;
  }
  if (typeof a === "number" || typeof a === "boolean") {
    return <span>{String(a)}</span>;
  }
  if (a != null && typeof a === "object") {
    return (
      <pre className="whitespace-pre-wrap break-words text-xs text-splash-navy/70">
        {JSON.stringify(a, null, 2)}
      </pre>
    );
  }
  return null;
}
