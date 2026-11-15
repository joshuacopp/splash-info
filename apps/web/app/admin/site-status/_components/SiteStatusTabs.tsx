import Link from "next/link";

export function SiteStatusTabs({ active }: { active: "board" | "reports" }) {
  const tab = (id: "board" | "reports", href: string, label: string) => (
    <Link
      href={href}
      className={`border-b-2 px-4 py-2 text-sm font-bold ${
        active === id ? "border-splash-blue text-splash-blue" : "border-transparent text-splash-navy/60 hover:text-splash-navy"
      }`}
    >
      {label}
    </Link>
  );
  return (
    <nav className="flex gap-1 border-b border-gray-light">
      {tab("board", "/admin/site-status", "Board")}
      {tab("reports", "/admin/site-status/reports", "Reports")}
    </nav>
  );
}
