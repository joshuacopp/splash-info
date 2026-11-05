// "Reported failures: nhtsa.gov · Owner forum thread" -- the evidence links on
// a Vehicle Guide entry, shared by the admin list and the claim detail page's
// known-issues box. Renders nothing when there are none. The worker only
// stores http(s) links; the check here keeps it that way if one ever slips in.

import { reportLinkText, type ReportLink } from "@splash/types/vehicle-guide";

export function ReportLinks({ links, className = "" }: { links: ReportLink[]; className?: string }) {
  const safe = links.filter((l) => /^https?:\/\//i.test(l.url));
  if (safe.length === 0) return null;
  return (
    <p className={className}>
      <span className="font-semibold">Reported failures: </span>
      {safe.map((l, n) => (
        <span key={l.url}>
          {n ? " · " : ""}
          <a
            href={l.url}
            target="_blank"
            rel="noopener noreferrer"
            className="font-semibold text-splash-blue underline"
          >
            {reportLinkText(l)}
          </a>
        </span>
      ))}
    </p>
  );
}
