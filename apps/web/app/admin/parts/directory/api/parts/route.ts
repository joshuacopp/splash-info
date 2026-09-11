// Create a part — POST /admin/parts/directory/api/parts. super_admin only.
//
// A thin proxy onto `POST /workorders/api/parts`. See ../../_lib/write-proxy.ts
// for why the browser can't call the worker itself, and ../../_lib/admin-gate.ts
// for why the role check happens here as well as there.
//
// The request body is forwarded VERBATIM. Every field rule — required
// parent_equipment/part_name, the unit_cost coercion, the http(s)-only
// vendor_url check, location_codes lowercasing, and the 409 on a duplicate
// part number within one parent equipment — belongs to the worker. This file
// deliberately knows none of them.

import { partsWorkerFetch, PARTS_API_PATH } from "../../_lib/parts";
import { requirePartsAdmin } from "../../_lib/admin-gate";
import { readJsonText, relayWorkerResponse } from "../../_lib/write-proxy";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const gate = await requirePartsAdmin();
  if (!gate.ok) return gate.response;

  const body = await readJsonText(req);
  if (!body.ok) return body.response;

  const upstream = await partsWorkerFetch(PARTS_API_PATH, {
    method: "POST",
    jsonBody: body.text
  });

  const relayed = await relayWorkerResponse(upstream);
  if (relayed.status === 201) {
    console.log(`[parts.create] by ${gate.session.email}`);
  }
  return relayed.response;
}
