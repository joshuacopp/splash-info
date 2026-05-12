// Brief 111 — EST-formatted timestamp helper for the JotForm viewer.
//
// JotForm Enterprise's submission payloads carry timestamps as
// "YYYY-MM-DD HH:MM:SS" with no offset; the worker's parseJotformDate
// (apps/jotform-worker/src/normalize.js) stamps them with 'Z' (UTC)
// before insert. Display side converts UTC → America/New_York via
// `Intl.DateTimeFormat`, which auto-handles EDT (summer) / EST (winter)
// based on the date. Using the IANA zone name rather than the literal
// 'EST' means DST transitions just work.
//
// Operator post-deploy verification step is in the Brief 111 Phase 2 —
// submit a JotForm test entry, compare JotForm-dashboard timestamp to
// Supabase `jotform_created_at` to this display: if they agree, the
// v1 worker assumption (timestamps stored as UTC) is correct. If
// apps/web shows ~5 hours later than JotForm dashboard, the worker
// ingest path needs a follow-up brief.

export interface FormattedEst {
  absolute: string;
  relative: string;
}

export function formatEst(isoString: string | null): FormattedEst {
  if (!isoString) return { absolute: "", relative: "" };
  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) {
    return { absolute: isoString, relative: "" };
  }
  const absolute = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short"
  }).format(d);
  return { absolute, relative: formatRelative(d) };
}

function formatRelative(d: Date): string {
  const ms = Date.now() - d.getTime();
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day} day${day === 1 ? "" : "s"} ago`;
  // Fall back to the EST-formatted absolute when older than 30 days.
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    year: "numeric"
  }).format(d);
}
