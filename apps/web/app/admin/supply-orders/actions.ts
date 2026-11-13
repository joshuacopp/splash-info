"use server";

// Supply Orders server actions. Every one returns an ActionResult for
// <ActionForm> (Brief 19); none calls redirect() -- that costs ~20s under
// OpenNext on Cloudflare. Placing an order navigates via `redirectTo`.

import { revalidatePath } from "next/cache";
import type { ActionResult } from "../_components/ActionForm";
import { soPost } from "./_lib/worker-fetch";

function s(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === "string" ? v.trim() : "";
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function refresh(id?: string) {
  revalidatePath("/admin/supply-orders");
  if (id) revalidatePath(`/admin/supply-orders/${id}`);
}

export async function createOrderAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const lines = parseJson(s(fd, "lines"));
  if (!Array.isArray(lines) || lines.length === 0) return { ok: false, error: "Add at least one item." };
  const r = await soPost<{ id: string; po_number: string; status: string; send_error?: string }>(
    "/workorders/api/supply-orders",
    {
      location_id: Number(s(fd, "location_id")),
      initials: s(fd, "initials"),
      note: s(fd, "note") || undefined,
      lines
    }
  );
  if (!r.ok) return { ok: false, error: r.error };
  refresh(r.data.id);
  const msg =
    r.data.status === "sent"
      ? `PO ${r.data.po_number} sent to Kleen-Rite.`
      : r.data.send_error
        ? `PO ${r.data.po_number} saved, but ${r.data.send_error}`
        : `PO ${r.data.po_number} sent to your RM for approval.`;
  return { ok: true, message: msg, redirectTo: `/admin/supply-orders/${r.data.id}?placed=1` };
}

export async function approveOrderAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const id = s(fd, "id");
  const r = await soPost(`/workorders/api/supply-orders/${encodeURIComponent(id)}/approve`, {
    lines: parseJson(s(fd, "lines")) ?? undefined,
    note: s(fd, "note") || undefined
  });
  if (!r.ok) return { ok: false, error: r.error };
  refresh(id);
  return { ok: true, message: "Approved and sent to Kleen-Rite." };
}

export async function denyOrderAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const id = s(fd, "id");
  const r = await soPost(`/workorders/api/supply-orders/${encodeURIComponent(id)}/deny`, { note: s(fd, "note") });
  if (!r.ok) return { ok: false, error: r.error };
  refresh(id);
  return { ok: true, message: "Denied. The person who ordered has been emailed." };
}

export async function cancelOrderAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const id = s(fd, "id");
  const r = await soPost(`/workorders/api/supply-orders/${encodeURIComponent(id)}/cancel`, {});
  if (!r.ok) return { ok: false, error: r.error };
  refresh(id);
  return { ok: true, message: "Order cancelled." };
}
