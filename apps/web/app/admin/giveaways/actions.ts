"use server";

// Server actions for /admin/giveaways. The worker validates and decides who may
// do what (admin tier or the `giveaways` access grant); these only shape the
// request. Brief 19 pattern: return an ActionResult, <ActionForm> shows it.

import { revalidatePath } from "next/cache";
import { GIVEAWAY_FIELD_KEYS } from "@splash/forms-schema/giveaway";
import type { ActionResult } from "../_components/ActionForm";
import { writeGiveaway } from "./_lib/worker-fetch";

const PATH = "/admin/giveaways";

function str(fd: FormData, k: string): string {
  return String(fd.get(k) ?? "").trim();
}

/** The settings form (SettingsForm.tsx) -> the worker's settings shape. */
function settingsFrom(fd: FormData): Record<string, unknown> {
  const fields: Record<string, { mode: string; label: string }> = {};
  for (const k of GIVEAWAY_FIELD_KEYS) fields[k] = { mode: str(fd, `mode_${k}`), label: str(fd, `label_${k}`) };
  return {
    title: str(fd, "title"),
    prize: str(fd, "prize"),
    starts_on: str(fd, "starts_on") || null,
    ends_on: str(fd, "ends_on") || null,
    fields,
    sms_consent: str(fd, "sms_consent"),
    one_per_person: fd.get("one_per_person") === "on"
  };
}

export async function createGiveawayAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const r = await writeGiveaway("", "POST", settingsFrom(fd));
  if (!r.ok) return { ok: false, error: r.error };
  revalidatePath(PATH);
  const id = typeof r.data.id === "string" ? r.data.id : "";
  return { ok: true, message: "Giveaway created.", redirectTo: id ? `${PATH}/${id}` : PATH };
}

export async function saveGiveawayAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const id = str(fd, "id");
  const r = await writeGiveaway(`/${encodeURIComponent(id)}`, "PATCH", { settings: settingsFrom(fd) });
  if (!r.ok) return { ok: false, error: r.error };
  revalidatePath(PATH);
  revalidatePath(`${PATH}/${id}`);
  return { ok: true, message: "Saved. The entry page shows the change at once." };
}

export async function archiveGiveawayAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const id = str(fd, "id");
  const archived = str(fd, "archived") === "1";
  const r = await writeGiveaway(`/${encodeURIComponent(id)}`, "PATCH", { archived });
  if (!r.ok) return { ok: false, error: r.error };
  revalidatePath(PATH);
  revalidatePath(`${PATH}/${id}`);
  return { ok: true, message: archived ? "Ended. The entry page now says the giveaway has ended." : "Reopened." };
}

export async function newLinkAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const id = str(fd, "id");
  const r = await writeGiveaway(`/${encodeURIComponent(id)}`, "PATCH", { new_link: true });
  if (!r.ok) return { ok: false, error: r.error };
  revalidatePath(`${PATH}/${id}`);
  return { ok: true, message: "New link made. The old link no longer works -- update the tablets." };
}

export async function deleteEntryAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const id = str(fd, "id");
  const entryId = str(fd, "entry_id");
  const r = await writeGiveaway(`/${encodeURIComponent(id)}/entries/${encodeURIComponent(entryId)}`, "DELETE");
  if (!r.ok) return { ok: false, error: r.error };
  revalidatePath(`${PATH}/${id}`);
  return { ok: true, message: "Entry removed." };
}
