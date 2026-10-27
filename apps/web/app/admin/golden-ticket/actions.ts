// Server actions for /admin/golden-ticket. Brief 19 pattern: return an
// ActionResult, let <ActionForm> show it and router.refresh(). The worker owns
// validation and the access gate; its error sentences reach the banner as-is.

"use server";

import { revalidatePath } from "next/cache";
import type { ActionResult } from "../_components/ActionForm";
import { postGoldenTicket } from "./_lib/worker-fetch";

const PATH = "/admin/golden-ticket";

function str(fd: FormData, name: string): string {
  const v = fd.get(name);
  return typeof v === "string" ? v : "";
}

export async function updateWinAction(
  _prev: ActionResult | null,
  fd: FormData
): Promise<ActionResult> {
  const id = str(fd, "submission_id");
  if (!id) return { ok: false, error: "That win could not be identified. Reload the page." };
  const res = await postGoldenTicket(`wins/${encodeURIComponent(id)}`, {
    status: str(fd, "status"),
    // The form always carries both boxes, so absent from FormData means
    // unticked, i.e. an explicit false.
    account_setup: fd.get("account_setup") === "on",
    micrologic_tagged: fd.get("micrologic_tagged") === "on",
    note: str(fd, "note")
  });
  if (!res.ok) return { ok: false, error: res.error };
  revalidatePath(PATH);
  return { ok: true, message: res.body.unchanged ? "Nothing to save." : "Saved." };
}

export async function savePromoAction(
  _prev: ActionResult | null,
  fd: FormData
): Promise<ActionResult> {
  const res = await postGoldenTicket("promos", {
    id: str(fd, "id") || undefined,
    name: str(fd, "name"),
    starts_on: str(fd, "starts_on"),
    ends_on: str(fd, "ends_on")
  });
  if (!res.ok) return { ok: false, error: res.error };
  revalidatePath(PATH);
  return { ok: true, message: "Promo saved." };
}

export async function deletePromoAction(
  _prev: ActionResult | null,
  fd: FormData
): Promise<ActionResult> {
  const id = str(fd, "id");
  const res = await postGoldenTicket(`promos/${encodeURIComponent(id)}/delete`, {});
  if (!res.ok) return { ok: false, error: res.error };
  revalidatePath(PATH);
  return { ok: true, message: "Promo deleted." };
}

export async function lookupLinkAction(
  _prev: ActionResult | null,
  fd: FormData
): Promise<ActionResult> {
  const action = str(fd, "action");
  const res = await postGoldenTicket("lookup-link", { action });
  if (!res.ok) return { ok: false, error: res.error };
  revalidatePath(PATH);
  return {
    ok: true,
    message:
      action === "off"
        ? "Lookup page turned off. The old link no longer works."
        : "New link made. The old link no longer works -- send sites the new one."
  };
}
