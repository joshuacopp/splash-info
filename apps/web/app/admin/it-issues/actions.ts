"use server";

// IT Issue Tracker server actions. Every one returns an ActionResult for
// <ActionForm> (Brief 19); none calls redirect() -- that costs ~20s under
// OpenNext on Cloudflare. Create navigates via `redirectTo` instead.

import { revalidatePath } from "next/cache";
import type { ActionResult } from "../_components/ActionForm";
import { itPost } from "./_lib/worker-fetch";

function s(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === "string" ? v.trim() : "";
}

/** Optional text: absent instead of "" so the worker treats it as "no change". */
function opt(fd: FormData, key: string): string | undefined {
  return s(fd, key) || undefined;
}

function refresh(id?: string) {
  revalidatePath("/admin/it-issues");
  if (id) revalidatePath(`/admin/it-issues/${id}`);
}

export async function createIssueAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const r = await itPost<{ id: string; ref_no: number }>("/workorders/api/it-issues", {
    location_id: Number(s(fd, "location_id")),
    device: s(fd, "device"),
    device_unit: opt(fd, "device_unit"),
    problem: s(fd, "problem"),
    error_text: opt(fd, "error_text"),
    customer_impact: s(fd, "customer_impact"),
    priority: s(fd, "priority"),
    troubleshooting: opt(fd, "troubleshooting"),
    reporter_name: s(fd, "reporter_name"),
    reporter_phone: s(fd, "reporter_phone"),
    it_ticket_no: opt(fd, "it_ticket_no")
  });
  if (!r.ok) return { ok: false, error: r.error };
  refresh(r.data.id);
  return { ok: true, message: `Logged as IT-${r.data.ref_no}.`, redirectTo: `/admin/it-issues/${r.data.id}` };
}

export async function occurrenceAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const id = s(fd, "id");
  const r = await itPost<{ reopened: boolean }>(`/workorders/api/it-issues/${encodeURIComponent(id)}/occurrence`, {
    actor_name: s(fd, "actor_name"),
    note: opt(fd, "note"),
    error_text: opt(fd, "error_text")
  });
  if (!r.ok) return { ok: false, error: r.error };
  refresh(id);
  return { ok: true, message: r.data.reopened ? "Logged, and the issue was reopened." : "Logged." };
}

export async function updateIssueAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const id = s(fd, "id");
  const r = await itPost(`/workorders/api/it-issues/${encodeURIComponent(id)}/update`, {
    actor_name: s(fd, "actor_name"),
    status: opt(fd, "status"),
    priority: opt(fd, "priority"),
    it_ticket_no: opt(fd, "it_ticket_no"),
    note: opt(fd, "note"),
    resolution: opt(fd, "resolution")
  });
  if (!r.ok) return { ok: false, error: r.error };
  refresh(id);
  return { ok: true, message: "Saved." };
}

export async function escalateAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const id = s(fd, "id");
  const r = await itPost<{ sent_to: string[] }>(`/workorders/api/it-issues/${encodeURIComponent(id)}/escalate`, {
    actor_name: s(fd, "actor_name"),
    note: opt(fd, "note")
  });
  if (!r.ok) return { ok: false, error: r.error };
  refresh(id);
  return { ok: true, message: `Sent to ${r.data.sent_to.join(", ")}.` };
}

export async function mxRequestAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const id = s(fd, "id");
  const r = await itPost<{ mx_request_id: number }>(`/workorders/api/it-issues/${encodeURIComponent(id)}/mx-request`, {
    actor_name: s(fd, "actor_name")
  });
  if (!r.ok) return { ok: false, error: r.error };
  refresh(id);
  return { ok: true, message: `MaintainX request #${r.data.mx_request_id} created.` };
}

/** The public email-link page. No session is forwarded: the token decides. */
export async function linkAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const token = s(fd, "token");
  const r = await itPost(
    `/workorders/api/it-issue-link/${encodeURIComponent(token)}`,
    {
      actor_name: s(fd, "actor_name"),
      status: opt(fd, "status"),
      it_ticket_no: opt(fd, "it_ticket_no"),
      note: opt(fd, "note"),
      resolution: opt(fd, "resolution")
    },
    false
  );
  if (!r.ok) return { ok: false, error: r.error };
  revalidatePath(`/it-issue/${token}`);
  return { ok: true, message: "Saved. Thank you." };
}
