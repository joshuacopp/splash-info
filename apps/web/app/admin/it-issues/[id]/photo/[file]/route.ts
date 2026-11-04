// Signed-in photo proxy. The worker checks the caller can see the issue.

import { proxyPhoto } from "../../../_lib/photo-proxy";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string; file: string }> }) {
  const { id, file } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new Response("not found", { status: 404 });
  return proxyPhoto(`/workorders/api/it-issues/${id}/photo/${file}`, file, true);
}
