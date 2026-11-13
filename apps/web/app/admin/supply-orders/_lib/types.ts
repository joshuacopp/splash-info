// Supply Orders wire shapes -- mirror apps/workorders-worker/src/supply-orders.ts.
// Client-safe: no next/headers here.

export type OrderStatus = "pending_approval" | "sent" | "denied" | "cancelled";

export interface SiteOption {
  id: number;
  site_number: number | null;
  site: string | null;
  label: string;
  needs_approval: boolean;
  approver_email: string | null;
  approver_name: string | null;
  ship_to: string;
  initials: string;
}

export interface Meta {
  can_order: boolean;
  live: boolean;
  vendor: { display_name: string; account_no: string; shipping_method: string } | null;
  sites: SiteOption[];
  departments: string[];
  today: string;
}

export interface CatalogItem {
  sku: string;
  name: string;
  brand: string | null;
  uom: string | null;
  image_url: string | null;
  product_path: string;
  min_qty: number;
  call_to_order: boolean;
}

export interface CatalogPage {
  items: CatalogItem[];
  total: number;
  page: number;
  total_pages: number;
  categories: Array<{ label: string; count: number }>;
}

export interface RecentItem {
  sku: string;
  name: string;
  uom: string | null;
  image_url: string | null;
  product_path: string | null;
  unit_price_cents: number | null;
  last_qty: number;
  times: number;
}

export interface CartLine {
  sku: string;
  name: string;
  uom: string | null;
  qty: number;
  unit_price_cents: number | null;
  product_path: string | null;
  image_url: string | null;
  source: "catalog" | "manual";
}

export interface Order {
  id: string;
  ref_no: number;
  location_id: number;
  site_number: number | null;
  site_name: string;
  po_number: string;
  status: OrderStatus;
  ordered_by_email: string;
  orderer_initials: string;
  note: string | null;
  approver_email: string | null;
  decided_by_email: string | null;
  decided_at: string | null;
  decision_note: string | null;
  account_no: string;
  ship_to: string;
  shipping_method: string;
  vendor_email_to: string | null;
  vendor_email_cc: string[];
  vendor_reply_to: string | null;
  sent_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface OrderListItem extends Order {
  line_count: number;
  unit_count: number;
  estimated_cents: number | null;
  awaiting_me: boolean;
}

export interface Line {
  id: number;
  line_no: number;
  sku: string;
  name: string;
  uom: string | null;
  qty: number;
  unit_price_cents: number | null;
  product_url: string | null;
  image_url: string | null;
  source: "catalog" | "manual";
}

export interface OrderEvent {
  id: number;
  at: string;
  kind: string;
  actor_email: string | null;
  note: string | null;
  details: Record<string, unknown>;
}

export interface OrderDetail {
  order: Order;
  lines: Line[];
  events: OrderEvent[];
  estimated_cents: number | null;
  can_approve: boolean;
  can_cancel: boolean;
  live: boolean;
  vendor_preview: { subject: string; text: string } | null;
  vendor_to: string | null;
}

export const STATUS_LABEL: Record<OrderStatus, string> = {
  pending_approval: "Waiting for approval",
  sent: "Sent to Kleen-Rite",
  denied: "Denied",
  cancelled: "Cancelled"
};

export const STATUS_PILL: Record<OrderStatus, string> = {
  pending_approval: "bg-amber-100 text-amber-800",
  sent: "bg-emerald-100 text-emerald-800",
  denied: "bg-red-100 text-red-800",
  cancelled: "bg-gray-light text-splash-navy/70"
};

export function money(cents: number | null | undefined): string {
  if (cents == null) return "";
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatEt(iso: string | null | undefined): string {
  if (!iso) return "";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(iso));
}

/** PO preview shown before submit; the worker assigns the real one. */
export function poPreview(siteNumber: number | null, todayYmd: string, initials: string): string {
  const num = siteNumber != null ? String(siteNumber).padStart(3, "0") : "000";
  return `${num}-${todayYmd.replace(/-/g, "")}-${initials || "??"}`;
}
