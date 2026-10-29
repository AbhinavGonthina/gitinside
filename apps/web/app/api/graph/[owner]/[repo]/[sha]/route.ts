import { handleGraphRequest } from "../../../../../../lib/graphRoute";
import { graphDepsFromEnv } from "../../../../../../lib/serverDeps";

/** `GET /api/graph/:owner/:repo/:sha`: one commit's graph, streamed from R2 (lib/graphRoute.ts, ADR-0068). */
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ owner: string; repo: string; sha: string }> },
): Promise<Response> {
  return handleGraphRequest(await params, graphDepsFromEnv());
}
