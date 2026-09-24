"use server";

import { revalidatePath } from "next/cache";

import {
  patchActionItem,
  verifyActionItem,
  createActionItemNote,
  createActionItem
} from "./_lib/worker-fetch";
import type { ActionItemPriority, ActionItemStatus } from "./_lib/types";

const PAGE_PATH = "/action-items";

export type ActionItemResult =
  | { ok: true; message?: string }
  | { ok: false; error: string };

/**
 * These deliberately do NOT re-check permissions. The worker owns that —
 * re-deriving "may this person verify" here would be a second implementation
 * of the rule, and the two drift. The UI hides controls it believes are
 * unavailable, using the per-row `can_edit` / `can_verify` the worker itself
 * computed from the functions its writes gate on.
 */
export async function setStatusAction(
  id: string,
  status: ActionItemStatus
): Promise<ActionItemResult> {
  try {
    const res = await patchActionItem(id, { status });
    if (!res.ok) return { ok: false, error: humanize(res.error) };
    revalidatePath(PAGE_PATH);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function updateItemAction(
  id: string,
  patch: {
    description?: string;
    priority?: ActionItemPriority;
    due_date?: string | null;
  }
): Promise<ActionItemResult> {
  try {
    const res = await patchActionItem(id, patch);
    if (!res.ok) return { ok: false, error: humanize(res.error) };
    revalidatePath(PAGE_PATH);
    return { ok: true, message: "Saved" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function verifyAction(id: string): Promise<ActionItemResult> {
  try {
    const res = await verifyActionItem(id);
    if (!res.ok) return { ok: false, error: humanize(res.error) };
    revalidatePath(PAGE_PATH);
    return { ok: true, message: "Verified" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** The worker's error codes are precise but not sentences. */
function humanize(raw: string): string {
  if (raw.includes("verified_and_locked")) {
    return "This item has been verified by the RM and can no longer be changed.";
  }
  if (raw.includes("rm_only")) {
    return "Only the Regional Manager can verify an item.";
  }
  if (raw.includes("not_done")) {
    return "Mark the item done before verifying it.";
  }
  if (raw.includes("not_found")) {
    return "That item no longer exists, or it isn't at one of your sites.";
  }
  if (raw.includes("description_required")) {
    return "Describe the work first.";
  }
  if (raw.includes("location_required")) {
    return "Pick a site first.";
  }
  if (raw.includes("forbidden") || raw.includes("no_accessible_locations")) {
    return "You don't have access to that site.";
  }
  return raw;
}

export async function addNoteAction(
  id: string,
  body: string
): Promise<ActionItemResult> {
  const trimmed = body.trim();
  if (trimmed === "") return { ok: false, error: "Write something first." };
  try {
    const res = await createActionItemNote(id, trimmed);
    if (!res.ok) return { ok: false, error: humanize(res.error) };
    revalidatePath(PAGE_PATH);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Add an item by hand -- for what the walk-through missed, or for splitting
 *  one ticked question into the several jobs it turned out to be. */
export async function createItemAction(
  locationCode: string,
  input: { description: string; priority: string; due_date: string | null }
): Promise<ActionItemResult> {
  const description = input.description.trim();
  if (description === "") return { ok: false, error: "Describe the work first." };
  try {
    const res = await createActionItem({
      location_code: locationCode,
      description,
      priority: input.priority,
      due_date: input.due_date
    });
    if (!res.ok) return { ok: false, error: humanize(res.error) };
    revalidatePath(PAGE_PATH);
    return { ok: true, message: "Added" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
