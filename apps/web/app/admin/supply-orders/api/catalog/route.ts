// Browser -> worker proxy for the Kleen-Rite catalog search. The order page is
// a client component, so it cannot use the service binding itself.
import { relay, soFetch } from "../../_lib/worker-fetch";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const src = new URL(request.url).searchParams;
  const qs = new URLSearchParams();
  for (const k of ["q", "category", "page"]) {
    const v = src.get(k);
    if (v) qs.set(k, v);
  }
  return relay(await soFetch("GET", `/workorders/api/supply-orders/catalog?${qs.toString()}`));
}
