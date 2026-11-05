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

/**
 * The worker body: JSON normally, multipart when the form carried photos.
 * Undefined fields are dropped either way, so "absent" still means "no change".
 */
function withPhotos(fd: FormData, fields: Record<string, string | number | undefined>): FormData | Record<string, unknown> {
  const photos = fd.getAll("photo").filter((v): v is File => typeof v !== "string" && v.size > 0);
  if (photos.length === 0) return fields;
  const out = new FormData();
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) out.set(k, String(v));
  for (const p of photos) out.append("photo", p, p.name);
  return out;
}

function withWarning(message: string, warning: string | null | undefined): string {
  return warning ? `${message} ${warning}` : message;
}

type PhotoReply = { photo_warning?: string | null };

export async function createIssueAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const r = await itPost<{ id: string; ref_no: number } & PhotoReply>("/workorders/api/it-issues", withPhotos(fd, {
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
    it_ticket_no: opt(fd, "it_ticket_no"),
    occurred_at: opt(fd, "occurred_at"),
    customer_ticket_no: opt(fd, "customer_ticket_no"),
    customer_account_no: opt(fd, "customer_account_no"),
    pos_provider_opened: s(fd, "pos_provider_opened"),
    pos_provider: opt(fd, "pos_provider"),
    pos_provider_called_at: opt(fd, "pos_provider_called_at"),
    pos_provider_ticket_no: opt(fd, "pos_provider_ticket_no")
  }));
  if (!r.ok) return { ok: false, error: r.error };
  refresh(r.data.id);
  // The page is about to change, so a photo warning is carried on the URL.
  const qs = r.data.photo_warning ? `?photo_warning=${encodeURIComponent(r.data.photo_warning)}` : "";
  return { ok: true, message: `Logged as IT-${r.data.ref_no}.`, redirectTo: `/admin/it-issues/${r.data.id}${qs}` };
}

export async function occurrenceAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const id = s(fd, "id");
  const r = await itPost<{ reopened: boolean } & PhotoReply>(
    `/workorders/api/it-issues/${encodeURIComponent(id)}/occurrence`,
    withPhotos(fd, {
      actor_name: s(fd, "actor_name"),
      note: opt(fd, "note"),
      error_text: opt(fd, "error_text"),
      occurred_at: opt(fd, "occurred_at"),
      customer_ticket_no: opt(fd, "customer_ticket_no"),
      customer_account_no: opt(fd, "customer_account_no"),
      pos_provider_opened: opt(fd, "pos_provider_opened"),
      pos_provider: opt(fd, "pos_provider"),
      pos_provider_called_at: opt(fd, "pos_provider_called_at"),
      pos_provider_ticket_no: opt(fd, "pos_provider_ticket_no")
    })
  );
  if (!r.ok) return { ok: false, error: r.error };
  refresh(id);
  return {
    ok: true,
    message: withWarning(r.data.reopened ? "Logged, and the issue was reopened." : "Logged.", r.data.photo_warning)
  };
}

export async function updateIssueAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const id = s(fd, "id");
  const r = await itPost<PhotoReply>(
    `/workorders/api/it-issues/${encodeURIComponent(id)}/update`,
    withPhotos(fd, {
      actor_name: s(fd, "actor_name"),
      status: opt(fd, "status"),
      priority: opt(fd, "priority"),
      it_ticket_no: opt(fd, "it_ticket_no"),
      note: opt(fd, "note"),
      resolution: opt(fd, "resolution")
    })
  );
  if (!r.ok) return { ok: false, error: r.error };
  refresh(id);
  return { ok: true, message: withWarning("Saved.", r.data.photo_warning) };
}

/** A call to the POS provider's tech support (not our IT). */
export async function providerContactAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const id = s(fd, "id");
  const r = await itPost(`/workorders/api/it-issues/${encodeURIComponent(id)}/provider-contact`, {
    actor_name: s(fd, "actor_name"),
    pos_provider: s(fd, "pos_provider"),
    pos_provider_called_at: opt(fd, "pos_provider_called_at"),
    pos_provider_ticket_no: opt(fd, "pos_provider_ticket_no"),
    note: opt(fd, "note")
  });
  if (!r.ok) return { ok: false, error: r.error };
  refresh(id);
  return { ok: true, message: "Call logged. IT will see it on this issue and in their emails." };
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
  const r = await itPost<{ mx_request_id: number; photos_failed?: number }>(
    `/workorders/api/it-issues/${encodeURIComponent(id)}/mx-request`,
    { actor_name: s(fd, "actor_name") }
  );
  if (!r.ok) return { ok: false, error: r.error };
  refresh(id);
  const failed = r.data.photos_failed ?? 0;
  const warn = failed ? ` ${failed} photo${failed === 1 ? "" : "s"} could not be attached; add them in MaintainX.` : "";
  return { ok: true, message: `MaintainX request #${r.data.mx_request_id} created.${warn}` };
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
