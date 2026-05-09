// CSV export link (Brief 83). Server-component-friendly — emits a styled
// plain `<a download>` whose `href` is built by the parent (so the parent
// decides which filter params to forward). No client state. Plain anchor
// (not next/link) because we want the browser's native download behavior
// from the Content-Disposition response header, not a client-side route
// transition.

interface Props {
  href: string;
  label?: string;
}

export function CsvExportButton({ href, label = "Export CSV" }: Props) {
  return (
    <a
      href={href}
      download
      className="inline-flex items-center gap-1.5 rounded-splash-sm border border-splash-blue bg-white px-4 py-1.5 text-sm font-bold text-splash-blue hover:bg-splash-blue/5"
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2.2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        className="h-4 w-4"
      >
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <polyline points="7 10 12 15 17 10" />
        <line x1="12" y1="15" x2="12" y2="3" />
      </svg>
      {label}
    </a>
  );
}
