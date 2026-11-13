import { handlePrototypeGraph } from "../../../../../../lib/prototypeGraph";

/** `GET /api/prototype/graph/:owner/:repo`: one of the M10 prototype's graphs, proxied from production (lib/prototypeGraph.ts). */
export const dynamic = "force-dynamic";
/** Production's graph route has 15 s; the proxy waits up to 10 s for it to start. */
export const maxDuration = 15;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ owner: string; repo: string }> },
): Promise<Response> {
  return handlePrototypeGraph(await params, request.headers.get("accept-encoding"));
}
