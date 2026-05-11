// SSR helper for the /forms credentialed-user index page (Brief 99).
// Hits splash-forms via the FORMS_WORKER service binding (Brief 17 pattern)
// with a URL-based fallback for `next dev` outside the Workers runtime.
//
// Distinct from `apps/web/app/admin/forms/_lib/worker-fetch.ts` — that
// file is the admin-side helper for the builder. This one is the
// public-side helper for the credentialed-user index.

import { cookies, headers as nextHeaders } from "next/headers";
import { getCloudflareContext } from "@opennextjs/cloudflare";

export interface VisibleForm {
  slug: string;
  title: string;
  description: string | null;
  audience: "public" | "internal" | "link-only";
}

interface VisibleResponse {
  forms: VisibleForm[];
}

/**
 * Fetch the list of forms visible to the calling session. Returns [] on
 * 401 (no/expired session) so the page can render its signed-out state
 * cleanly without throwing.
 */
export async function getVisibleForms(): Promise<VisibleForm[]> {
  const cookieHeader = (await cookies()).toString();
  const reqHeaders = await nextHeaders();
  const host = reqHeaders.get("host") ?? "splashcarwashes.info";
  const proto = reqHeaders.get("x-forwarded-proto") ?? "https";
  const origin = `${proto}://${host}`;
  const path = "/forms/api/visible-to-me";

  // Try service binding first.
  try {
    const ctx = await getCloudflareContext({ async: true });
    const binding = ctx?.env?.FORMS_WORKER as
      | { fetch: typeof fetch }
      | undefined;
    if (binding) {
      const res = await binding.fetch(
        new Request(`https://internal${path}`, {
          headers: { Cookie: cookieHeader, Origin: origin }
        })
      );
      if (res.status === 401) return [];
      if (!res.ok) {
        console.error("[forms.index] worker returned", res.status);
        return [];
      }
      const json = (await res.json()) as VisibleResponse;
      return json.forms ?? [];
    }
  } catch {
    // Fall through to URL-based fetch.
  }

  // URL fallback (next dev).
  const url =
    process.env.NEXT_PUBLIC_FORMS_WORKER_URL ?? `${origin}`;
  try {
    const res = await fetch(`${url}${path}`, {
      headers: { Cookie: cookieHeader, Origin: origin },
      cache: "no-store"
    });
    if (res.status === 401) return [];
    if (!res.ok) {
      console.error("[forms.index] worker URL fetch returned", res.status);
      return [];
    }
    const json = (await res.json()) as VisibleResponse;
    return json.forms ?? [];
  } catch (err) {
    console.error("[forms.index] worker URL fetch threw", err);
    return [];
  }
}
