// Email-link photo proxy. No session is forwarded: the token decides, and it
// only reaches photos on its own issue.

import { proxyPhoto } from "../../../../admin/it-issues/_lib/photo-proxy";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ token: string; file: string }> }) {
  const { token, file } = await params;
  if (!/^[A-Za-z0-9_-]{30,60}$/.test(token)) return new Response("not found", { status: 404 });
  return proxyPhoto(`/workorders/api/it-issue-link/${token}/photo/${file}`, file, false);
}
