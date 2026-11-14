// Browser -> worker proxy: send the price-match request. The multipart body
// (JSON `data` + quote `files`) is forwarded byte-for-byte with its boundary.
import { pmFetch, relay } from "../../_lib/worker-fetch";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const type = request.headers.get("content-type") ?? "";
  if (!type.startsWith("multipart/form-data")) {
    return Response.json({ error: "Bad request." }, { status: 400 });
  }
  return relay(await pmFetch("POST", "/workorders/api/price-match", await request.arrayBuffer(), type));
}
