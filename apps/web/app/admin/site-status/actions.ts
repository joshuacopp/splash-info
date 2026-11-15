"use server";

// Server actions for /admin/site-status. The worker decides who may do what
// (the site's RD / RM, or admin tier); these only shape the request.

import { revalidatePath } from "next/cache";
import type { ActionResult } from "../_components/ActionForm";
import { postSiteStatus } from "./_lib/worker-fetch";

const PATH = "/admin/site-status";

function str(fd: FormData, k: string): string {
  return String(fd.get(k) ?? "").trim();
}

/** `minutes` (a preset) or `reopen_at` (ISO, converted in the browser from the
 *  person's local date/time picker). "custom" means use reopen_at. */
function estimate(fd: FormData): Record<string, unknown> {
  const minutes = str(fd, "minutes");
  if (minutes && minutes !== "custom") return { minutes: Number(minutes) };
  return { reopen_at: str(fd, "reopen_at") };
}

async function done(r: { ok: true } | { ok: false; error: string }, message: string): Promise<ActionResult> {
  if (!r.ok) return { ok: false, error: r.error };
  revalidatePath(PATH);
  return { ok: true, message };
}

export async function closeSiteAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const r = await postSiteStatus("/close", {
    site_number: Number(str(fd, "site_number")),
    reason: str(fd, "reason"),
    reason_detail: str(fd, "reason_detail"),
    ...estimate(fd)
  });
  return done(r, "Site closed. Emails are on their way.");
}

export async function reopenAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const r = await postSiteStatus(`/closures/${encodeURIComponent(str(fd, "closure_id"))}/reopen`, { note: str(fd, "note") });
  return done(r, "Marked open.");
}

export async function estimateAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const r = await postSiteStatus(`/closures/${encodeURIComponent(str(fd, "closure_id"))}/estimate`, {
    ...estimate(fd),
    note: str(fd, "note")
  });
  return done(r, "Estimate updated.");
}

export async function downItemAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const r = await postSiteStatus("/down-items", {
    site_number: Number(str(fd, "site_number")),
    item: str(fd, "item"),
    note: str(fd, "note")
  });
  return done(r, "Logged.");
}

export async function clearDownAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const r = await postSiteStatus(`/down-items/${encodeURIComponent(str(fd, "item_id"))}/clear`, {});
  return done(r, "Marked back up.");
}

export async function settingsAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const body: Record<string, unknown> = {};
  if (str(fd, "rotate_link") === "1") body.rotate_link = true;
  if (fd.has("test_email_to")) body.test_email_to = str(fd, "test_email_to");
  const r = await postSiteStatus("/settings", body);
  return done(r, body.rotate_link ? "New link made. The old one no longer works." : "Saved.");
}
