// The tool grants in user_tool_access, in the order they're rendered.
//
// Shared rather than duplicated because Brief 173 has two cards that list
// tools (phase 1's Manage tools, phase 2's Access editor) and a new tool
// arriving would otherwise have to be remembered in both places. The worker's
// VALID_TOOLS is the real authority — this list only controls what the
// operator can tick.
//
// Chemical inventory is three grants, not one. They are nested capability
// tiers (view < write < admin) and a user should hold exactly ONE. Ticking two
// isn't an error — the worker takes the strongest — but it's misleading to
// read back, hence the "pick one" wording in the help text. They're ordered
// weakest-first and adjacent so the three read as a group in the UI.

export const ALL_TOOLS = [
  "pricing",
  "claims",
  "pertrack",
  "form_submissions",
  "schedule",
  "inventory_view",
  "inventory",
  "inventory_admin",
  "it_issues",
  "it_issues_it",
  "supply_orders"
] as const;

export type Tool = (typeof ALL_TOOLS)[number];

/** What each grant actually opens up, in operator terms. */
export const TOOL_HELP: Record<Tool, string> = {
  pricing: "Pricing admin",
  claims: "Damage claims — also needs a DC role",
  pertrack: "Greeter scorecard",
  form_submissions: "Form submissions viewer — also needs locations",
  schedule: "Scheduling",
  inventory_view: "Chemical inventory — read only (pick one inventory tier)",
  inventory: "Chemical inventory — submit visits (pick one inventory tier)",
  inventory_admin:
    "Chemical inventory — full admin: products, recipients, edit/delete visits (pick one inventory tier)",
  it_issues: "IT Issue Tracker (beta) — report and track IT issues at their own sites",
  it_issues_it:
    "IT Issue Tracker — IT support: sees every site, and their actions count as IT's in the daily digest (no need to also tick it_issues)",
  supply_orders:
    "Kleen-Rite Orders — order from Kleen-Rite for their sites. GM orders go to the site RM for approval; the site's RM / RD orders send straight away"
};

/** Stable render order, whatever order the codes arrived in. */
export function sortTools(tools: readonly string[]): string[] {
  return ALL_TOOLS.filter((t) => tools.includes(t));
}
