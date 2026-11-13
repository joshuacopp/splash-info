// Browser -> worker proxy: Kleen-Rite public prices for a page of results.
import { relay, soFetch } from "../../_lib/worker-fetch";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { paths?: unknown } | null;
  const paths = Array.isArray(body?.paths) ? body.paths.filter((p): p is string => typeof p === "string").slice(0, 24) : [];
  return relay(await soFetch("POST", "/workorders/api/supply-orders/catalog/prices", { paths }));
}
