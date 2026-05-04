// HTML-escape utility for raw-string render modules.
//
// Worker-local because the worker's render path is HTML-string-based, not
// React. apps/web's React rendering escapes automatically. When apps/web
// takes over the public-signup pages in a later step, this module goes
// away with the rest of the render/ directory.

const ESC_MAP: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;"
};

/** Escape HTML-significant characters. Null/undefined → empty string. */
export function escHtml(s: string | number | null | undefined): string {
  return String(s ?? "").replace(/[&<>"']/g, (m) => ESC_MAP[m] ?? m);
}

/** Capitalize first character. Used for the location-name display. */
export function cap(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}
