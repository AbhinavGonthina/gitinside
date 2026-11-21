import { prDiagramSearch, redirectToCanonical } from "../../../../../../../lib/canonical";
import { handlePrDiagramRequest } from "../../../../../../../lib/prDiagramRoute";
import { prDiagramDepsFromEnv } from "../../../../../../../lib/serverDeps";

/**
 * `GET /api/pr-diagram/:owner/:repo/:base/:head.svg[?theme=dark|light][&token=…]`: the image
 * above the pull request bot's comment (lib/prDiagramRoute.ts, M15.2b).
 */
export const dynamic = "force-dynamic";
/** Both graphs are read at once, each within the images' 10-second wait. */
export const maxDuration = 30;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ owner: string; repo: string; base: string; head: string }> },
): Promise<Response> {
  const redirect = redirectToCanonical(request.url, prDiagramSearch(request.url));
  if (redirect !== undefined) return redirect;
  const url = new URL(request.url);
  return handlePrDiagramRequest(
    await params,
    { theme: url.searchParams.get("theme"), token: url.searchParams.get("token") },
    prDiagramDepsFromEnv(url.origin),
  );
}
