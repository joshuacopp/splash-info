// Browser -> worker proxy: render the price-match email without sending it.
import { pmFetch, relay } from "../../_lib/worker-fetch";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return relay(await pmFetch("POST", "/workorders/api/price-match/preview", await request.text(), "application/json"));
}
