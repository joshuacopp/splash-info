// Server action for /admin/safety-topics. Brief 19 pattern: return an
// ActionResult, let <ActionForm> show it and router.refresh(). The worker owns
// validation and the access gate (admin tier or the safety_committee tag).

"use server";

import { revalidatePath } from "next/cache";
import type { ActionResult } from "../_components/ActionForm";
import { putRequiredTopicsAdmin } from "../forms/_lib/worker-fetch";

const ERRORS: Record<string, string> = {
  forbidden: "Only admins and the safety committee can change required topics.",
  unauthorized: "Your login expired. Sign in again.",
  too_many_topics: "That's more than 20 topics for one month.",
  topic_too_long: "Each topic must be 200 characters or fewer.",
  bad_month: "That month couldn't be read. Reload the page."
};

export async function saveTopicsAction(
  _prev: ActionResult | null,
  fd: FormData
): Promise<ActionResult> {
  const month = String(fd.get("month") ?? "");
  const raw = String(fd.get("topics") ?? "");
  // One topic per line; blank lines are spacing, not topics.
  const topics = raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
  const res = await putRequiredTopicsAdmin("safety_meeting", month, topics);
  if (res.status !== 200) {
    const code = String(res.body.error ?? "").split(":")[0] ?? "";
    return { ok: false, error: ERRORS[code] ?? "Couldn't save. Try again." };
  }
  revalidatePath("/admin/safety-topics");
  return {
    ok: true,
    message: topics.length === 0 ? "Saved: no required topics this month." : `Saved ${topics.length} topic${topics.length === 1 ? "" : "s"}.`
  };
}
