// Server actions for the Digests tab. The panel is a client component and the
// worker call needs next/headers + the service binding, so it goes through
// these. Each returns a plain result the panel renders; nothing redirects.

"use server";

import type { DigestConfig, FormDigest } from "@splash/forms-schema/digest";
import { callDigestsAdmin, type DigestPreviewData } from "../../_lib/worker-fetch";

export type DigestResult<T> = { ok: true; data: T } | { ok: false; error: string };

function failure(r: { status: number; body: Record<string, unknown> }): { ok: false; error: string } {
  const msg = typeof r.body.message === "string" ? r.body.message : null;
  if (msg) return { ok: false, error: msg };
  if (r.status === 401) return { ok: false, error: "Your session expired. Sign in again." };
  if (r.status === 403) return { ok: false, error: "Digests can only be set up by admins." };
  return { ok: false, error: `Something went wrong (${String(r.body.error ?? r.status)}).` };
}

async function run<T>(fn: () => Promise<{ status: number; body: Record<string, unknown> }>, pick: (b: Record<string, unknown>) => T): Promise<DigestResult<T>> {
  try {
    const r = await fn();
    if (r.status >= 200 && r.status < 300) return { ok: true, data: pick(r.body) };
    return failure(r);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function listDigestsAction(formId: string): Promise<DigestResult<FormDigest[]>> {
  return run(() => callDigestsAdmin(formId, "", "GET"), (b) => (b.digests as FormDigest[]) ?? []);
}

export async function saveDigestAction(
  formId: string,
  digestId: string | null,
  input: { name: string; enabled: boolean; config: DigestConfig }
): Promise<DigestResult<FormDigest>> {
  return run(
    () =>
      digestId
        ? callDigestsAdmin(formId, `/${encodeURIComponent(digestId)}`, "PATCH", input)
        : callDigestsAdmin(formId, "", "POST", input),
    (b) => b.digest as FormDigest
  );
}

export async function setDigestEnabledAction(formId: string, digestId: string, enabled: boolean): Promise<DigestResult<FormDigest>> {
  return run(() => callDigestsAdmin(formId, `/${encodeURIComponent(digestId)}`, "PATCH", { enabled }), (b) => b.digest as FormDigest);
}

export async function deleteDigestAction(formId: string, digestId: string): Promise<DigestResult<true>> {
  return run(() => callDigestsAdmin(formId, `/${encodeURIComponent(digestId)}`, "DELETE"), () => true as const);
}

export async function previewDigestAction(formId: string, config: DigestConfig): Promise<DigestResult<DigestPreviewData>> {
  return run(() => callDigestsAdmin(formId, "/preview", "POST", { config }), (b) => b as unknown as DigestPreviewData);
}

export async function testDigestAction(
  formId: string,
  name: string,
  config: DigestConfig
): Promise<DigestResult<{ to: string; submissions: number }>> {
  return run(
    () => callDigestsAdmin(formId, "/test", "POST", { name, config }),
    (b) => ({ to: String(b.to ?? ""), submissions: Number(b.submissions ?? 0) })
  );
}
