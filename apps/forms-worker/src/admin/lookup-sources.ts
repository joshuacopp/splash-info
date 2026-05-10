// Brief 94 — admin lookup-sources endpoint.
//
// `GET /forms/admin/api/lookup-sources` exposes the LOOKUP_SOURCES registry
// from @splash/forms-schema so Brief 95's builder UI can render the inspector
// dropdown without duplicating the list. Auth-gated (super_admin or dcRole
// admin/super_admin) — these labels are operator-facing but the registry
// is part of the admin contract.
//
// Cached on the client for 5 minutes (private, max-age=300) — the registry
// is hardcoded and only changes when @splash/forms-schema is updated, so a
// stale-cache window is harmless. Bust on a new builder release if needed.

import { LOOKUP_SOURCES } from "@splash/forms-schema";
import { adminGate, adminGateResponse } from "./auth.js";
import type { Env } from "../index.js";

export async function handleLookupSources(env: Env, req: Request): Promise<Response> {
  const gate = await adminGate(env, req);
  if (!gate.ok) return adminGateResponse(gate);

  return new Response(JSON.stringify({ sources: LOOKUP_SOURCES }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "private, max-age=300"
    }
  });
}
