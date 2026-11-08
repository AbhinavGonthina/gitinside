import { redirectToCanonical } from "../../../../../../../lib/canonical";
import { handleDiffRequest } from "../../../../../../../lib/diffRoute";
import { graphDepsFromEnv } from "../../../../../../../lib/serverDeps";

/** `GET /api/diff/:owner/:repo/:base/:head`: a pull request's stored diff, for the diagram's diff mode (lib/diffRoute.ts, M8.6f1). */
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ owner: string; repo: string; base: string; head: string }> },
): Promise<Response> {
  return (
    redirectToCanonical(request.url, "") ??
    handleDiffRequest(
      await params,
      graphDepsFromEnv(),
      request.headers.get("accept-encoding"),
      request.headers.get("cookie"),
    )
  );
}
