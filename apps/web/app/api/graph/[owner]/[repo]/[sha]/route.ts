import { redirectToCanonical } from "../../../../../../lib/canonical";
import { handleGraphRequest } from "../../../../../../lib/graphRoute";
import { graphDepsFromEnv } from "../../../../../../lib/serverDeps";

/** `GET /api/graph/:owner/:repo/:sha`: one commit's graph, streamed from the snapshot bucket (lib/graphRoute.ts, ADR-0068). */
export const dynamic = "force-dynamic";
/** `GRAPH_MAX_DURATION_SECONDS` (a literal: Next reads it without running the module). */
export const maxDuration = 15;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ owner: string; repo: string; sha: string }> },
): Promise<Response> {
  return (
    redirectToCanonical(request.url, "") ??
    handleGraphRequest(
      await params,
      graphDepsFromEnv(),
      request.headers.get("accept-encoding"),
      request.headers.get("cookie"),
    )
  );
}
