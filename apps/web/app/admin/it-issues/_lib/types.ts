// IT Issue Tracker wire shapes + display labels. Client-safe (no next/headers),
// so both server pages and client islands import from here. Mirrors
// apps/workorders-worker/src/it-issues.ts.

export type Impact = "none" | "single_customer" | "multiple_customers" | "site_wide";
export type Priority = "critical" | "high" | "medium" | "low";
export type Status = "open" | "waiting_on_it" | "in_progress" | "resolved";

export interface Issue {
  id: string;
  ref_no: number;
  location_id: number;
  site_number: number | null;
  site_name: string;
  device: string;
  device_unit: string | null;
  problem: string;
  error_text: string | null;
  customer_impact: Impact;
  priority: Priority;
  troubleshooting: string | null;
  status: Status;
  reporter_name: string;
  reporter_phone: string;
  created_by_email: string;
  it_ticket_no: string | null;
  customer_ticket_no: string | null;
  customer_account_no: string | null;
  mx_request_id: number | null;
  first_reported_at: string;
  last_occurred_at: string;
  occurrence_count: number;
  last_escalated_at: string | null;
  first_escalated_at?: string | null;
  last_it_action_at?: string | null;
  resolved_at: string | null;
  resolution: string | null;
  resolved_by: string | null;
  updated_at: string;
}

export interface IssueEvent {
  id: number;
  kind: string;
  /** When it was logged. */
  at: string;
  /** When it actually happened (created / occurrence); null on older rows. */
  occurred_at?: string | null;
  actor_name: string | null;
  actor_email?: string | null;
  via: "app" | "email_link" | "system";
  /** Done by IT: an emailed-link action or an IT-tagged login. */
  by_it?: boolean;
  note: string | null;
  details: Record<string, unknown>;
}

export interface SiteOption {
  id: number;
  label: string;
  site_number: number | null;
  name: string;
}

export interface IssueList {
  issues: Issue[];
  sites: SiteOption[];
  all_sites: boolean;
  devices: string[];
}

export interface IssueDetail {
  issue: Issue;
  events: IssueEvent[];
  escalate_to: string[];
  mx_available: boolean;
  mx_blocked_reason: string | null;
  devices: string[];
}

export interface PublicIssue {
  issue: Issue;
  events: IssueEvent[];
  read_only: boolean;
}

export const IMPACT_OPTIONS: ReadonlyArray<{ value: Impact; label: string; suggests: Priority }> = [
  { value: "none", label: "No customer impact", suggests: "low" },
  { value: "single_customer", label: "One customer", suggests: "medium" },
  { value: "multiple_customers", label: "Multiple customers", suggests: "high" },
  { value: "site_wide", label: "Site-wide (can't sell or wash)", suggests: "critical" }
];

export const PRIORITY_OPTIONS: ReadonlyArray<{ value: Priority; label: string; hint: string }> = [
  { value: "critical", label: "Critical", hint: "Can't process transactions, or a complete outage." },
  { value: "high", label: "High", hint: "Significant impact, limited workaround." },
  { value: "medium", label: "Medium", hint: "Affects operations, a workaround exists." },
  { value: "low", label: "Low", hint: "Minor, little day-to-day impact." }
];

export const STATUS_OPTIONS: ReadonlyArray<{ value: Status; label: string }> = [
  { value: "open", label: "Open" },
  { value: "waiting_on_it", label: "Waiting on IT" },
  { value: "in_progress", label: "In progress" },
  { value: "resolved", label: "Resolved" }
];

export function impactLabel(v: Impact): string {
  return IMPACT_OPTIONS.find((o) => o.value === v)?.label ?? v;
}
export function priorityLabel(v: Priority): string {
  return PRIORITY_OPTIONS.find((o) => o.value === v)?.label ?? v;
}
export function statusLabel(v: Status): string {
  return STATUS_OPTIONS.find((o) => o.value === v)?.label ?? v;
}
export function deviceLabel(i: Pick<Issue, "device" | "device_unit">): string {
  return i.device_unit ? `${i.device} ${i.device_unit}` : i.device;
}

export const PRIORITY_PILL: Record<Priority, string> = {
  critical: "bg-red-100 text-red-800",
  high: "bg-orange-100 text-orange-800",
  medium: "bg-amber-50 text-amber-800",
  low: "bg-gray-light text-splash-navy/80"
};

export const STATUS_PILL: Record<Status, string> = {
  open: "bg-blue-50 text-blue-800",
  waiting_on_it: "bg-amber-100 text-amber-900",
  in_progress: "bg-indigo-50 text-indigo-800",
  resolved: "bg-emerald-50 text-emerald-800"
};

const EVENT_LABEL: Record<string, string> = {
  created: "Reported",
  occurrence: "Happened again",
  note: "Note",
  status: "Status changed",
  ticket: "Ticket # added",
  escalated: "Sent to IT support",
  resolved: "Resolved",
  reopened: "Reopened",
  mx_request: "MaintainX request created",
  priority: "Priority changed"
};

/** One-line headline for a timeline entry. */
export function eventHeadline(e: IssueEvent): string {
  const d = e.details ?? {};
  switch (e.kind) {
    case "status":
      return `Status: ${statusLabel(d.to as Status)}`;
    case "priority":
      return `Priority: ${priorityLabel(d.to as Priority)}`;
    case "ticket":
      return `IT ticket #: ${String(d.to)}`;
    case "mx_request":
      return `MaintainX request #${String(d.mx_request_id)} created`;
    case "escalated":
      return `Sent to IT support (${(d.to as string[] | undefined)?.join(", ") ?? "IT"})`;
    case "occurrence":
      return d.error_text ? `Happened again - error: ${String(d.error_text)}` : "Happened again";
    case "reopened":
      return "Reopened";
    default:
      return EVENT_LABEL[e.kind] ?? e.kind;
  }
}

/** "Transaction ticket 123 · account 456" from an occurrence's details, or "". */
export function customerRefs(ticket: unknown, account: unknown): string {
  const parts: string[] = [];
  if (typeof ticket === "string" && ticket) {
    parts.push(`${/[,;]/.test(ticket) ? "Transaction tickets" : "Transaction ticket"} ${ticket}`);
  }
  if (typeof account === "string" && account) parts.push(`account ${account}`);
  return parts.join(" · ");
}

/** Now (or `at`) as a datetime-local value in Eastern time, which is how the
 *  worker reads it -- whatever time zone the device happens to be set to. */
export function etLocalInput(at: Date = new Date()): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    })
      .formatToParts(at)
      .map((x) => [x.type, x.value])
  );
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

export function formatEt(iso: string | null | undefined): string {
  if (!iso) return "-";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(iso));
}

export function daysSince(iso: string): number {
  return Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 86_400_000));
}
