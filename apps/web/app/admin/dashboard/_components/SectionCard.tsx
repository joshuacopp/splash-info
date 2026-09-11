// A card that drills DOWN to more cards, as opposed to <DashboardTile> which
// opens a tool.
//
// Extracted from the inline markup on /admin/dashboard when subgroups were
// added, so the group cards there and the subgroup cards on a group page are
// the same component rather than two copies that drift. The only thing that
// varies is the eyebrow: "Section" at the top level, the parent section's name
// one level down, so a Mechanical card inside Operations reads
// "OPERATIONS / Mechanical" and its place is obvious without a breadcrumb.

import Link from "next/link";

interface Props {
  href: string;
  /** Small uppercase label above the title. */
  eyebrow: string;
  label: string;
  description: string;
  /** Number of tools reachable through this card. */
  count: number;
}

export function SectionCard({ href, eyebrow, label, description, count }: Props) {
  return (
    <Link
      href={href}
      className="group flex flex-col overflow-hidden rounded-splash-lg border-[3px] border-splash-navy bg-white text-splash-navy shadow-splash-card transition-transform duration-150 hover:-translate-y-1 hover:shadow-splash-card-hover"
    >
      <div className="flex items-center gap-4 bg-gradient-to-br from-splash-blue to-splash-navy px-6 py-5">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-[0.6875rem] font-semibold uppercase tracking-[0.16em] text-sudsy-blue">
            {eyebrow}
          </span>
          <span className="text-lg font-bold leading-tight text-white">{label}</span>
        </div>
      </div>
      <div className="flex flex-1 flex-col justify-between gap-3.5 px-6 pb-5 pt-4">
        <div>
          <p className="text-[0.9375rem] leading-relaxed text-splash-navy/80">{description}</p>
          <p className="mt-2 text-xs font-semibold uppercase tracking-[0.14em] text-splash-navy/55">
            {count} {count === 1 ? "tool" : "tools"}
          </p>
        </div>
        <span className="inline-flex items-center gap-1.5 self-start text-[0.8125rem] font-bold uppercase tracking-[0.08em] text-splash-blue">
          Open
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-3.5 w-3.5 transition-transform duration-200 group-hover:translate-x-1"
            aria-hidden="true"
          >
            <line x1="5" y1="12" x2="19" y2="12" />
            <polyline points="12 5 19 12 12 19" />
          </svg>
        </span>
      </div>
    </Link>
  );
}
