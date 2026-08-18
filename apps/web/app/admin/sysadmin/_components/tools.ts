// The six tool grants in user_tool_access, in the order they're rendered.
//
// Shared rather than duplicated because Brief 173 has two cards that list
// tools (phase 1's Manage tools, phase 2's Access editor) and a seventh tool
// arriving would otherwise have to be remembered in both places. The worker's
// VALID_TOOLS is the real authority — this list only controls what the
// operator can tick.

export const ALL_TOOLS = [
  "pricing",
  "claims",
  "pertrack",
  "form_submissions",
  "schedule",
  "inventory"
] as const;

export type Tool = (typeof ALL_TOOLS)[number];

/** What each grant actually opens up, in operator terms. */
export const TOOL_HELP: Record<Tool, string> = {
  pricing: "Pricing admin",
  claims: "Damage claims — also needs a DC role",
  pertrack: "Greeter scorecard",
  form_submissions: "Form submissions viewer — also needs locations",
  schedule: "Scheduling",
  inventory: "Chemical inventory"
};

/** Stable render order, whatever order the codes arrived in. */
export function sortTools(tools: readonly string[]): string[] {
  return ALL_TOOLS.filter((t) => tools.includes(t));
}
