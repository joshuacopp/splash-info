// The checklist questions a part can be mapped to, for the part editor's
// picker. SSR only — imports next/headers.
//
// Crosses to splash-forms, not splash-workorders: the parts table belongs to
// workorders but form schemas belong to forms, and apps/web is the only place
// holding a binding to both. Service-binding-first with a URL fallback for
// `next dev`, the Brief 17 pattern used by every other worker call here.
//
// FAIL-SOFT. An unreachable forms worker must not take out the parts
// directory, which is a page about ordering bearings and has nothing to do
// with checklists. On any failure this returns an empty list and the editor
// hides the picker — the same state as a site that has published no
// checklists.

import { cookies, headers } from "next/headers";
import { getCloudflareContext } from "@opennextjs/cloudflare";

import type { ChecklistQuestionGroup } from "./parts-shared";

const FORMS_BINDING = "FORMS_WORKER" as const;
const QUESTIONS_PATH = "/forms/admin/api/action-item-questions";

async function fallbackUrl(path: string): Promise<string> {
  const base = process.env.NEXT_PUBLIC_FORMS_WORKER_URL;
  if (base) return `${base}${path}`;
  const headerStore = await headers();
  const host = headerStore.get("host") ?? "localhost:3000";
  const proto = headerStore.get("x-forwarded-proto") ?? "https";
  return `${proto}://${host}${path}`;
}

export async function fetchChecklistQuestions(): Promise<ChecklistQuestionGroup[]> {
  const cookieStore = await cookies();
  const reqHeaders = new Headers();
  reqHeaders.set("Cookie", cookieStore.toString());

  let resp: Response;
  try {
    const { env } = await getCloudflareContext({ async: true });
    const binding = env[FORMS_BINDING];
    if (!binding) throw new Error("binding unavailable");
    // Service bindings ignore the host; only the path matters.
    resp = await binding.fetch(
      new Request(`https://internal${QUESTIONS_PATH}`, { headers: reqHeaders })
    );
  } catch {
    try {
      resp = await fetch(await fallbackUrl(QUESTIONS_PATH), { headers: reqHeaders });
    } catch {
      return [];
    }
  }

  if (!resp.ok) return [];
  try {
    const body = (await resp.json()) as { forms?: unknown };
    if (!Array.isArray(body.forms)) return [];
    return body.forms.filter(isQuestionGroup);
  } catch {
    return [];
  }
}

function isQuestionGroup(value: unknown): value is ChecklistQuestionGroup {
  if (!value || typeof value !== "object") return false;
  const g = value as Record<string, unknown>;
  return (
    typeof g.form_id === "string" &&
    typeof g.form_title === "string" &&
    Array.isArray(g.questions) &&
    g.questions.every(
      (q) =>
        q &&
        typeof q === "object" &&
        typeof (q as Record<string, unknown>).key === "string" &&
        typeof (q as Record<string, unknown>).label === "string"
    )
  );
}
