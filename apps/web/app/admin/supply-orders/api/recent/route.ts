// Browser -> worker proxy: items this site has ordered before.
import { relay, soFetch } from "../../_lib/worker-fetch";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const id = new URL(request.url).searchParams.get("location_id") ?? "";
  return relay(await soFetch("GET", `/workorders/api/supply-orders/recent?location_id=${encodeURIComponent(id)}`));
}
