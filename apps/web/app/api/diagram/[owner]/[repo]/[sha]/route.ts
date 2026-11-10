import { diagramSearch, redirectToCanonical } from "../../../../../../lib/canonical";
import { handleImageRequest } from "../../../../../../lib/imageRoute";
import { imageDepsFromEnv, VERCEL_OIDC_HEADER } from "../../../../../../lib/serverDeps";

/**
 * `GET /api/diagram/:owner/:repo/:sha.svg[?theme=dark|light]`: one commit's image, as its
 * permalink shows it (the landing gallery's thumbnails, lib/imageRoute.ts, ADR-0259).
 */
export const dynamic = "force-dynamic";
/** As the live image's route: a demo pin's image can queue its commit, as its permalink does. */
export const maxDuration = 30;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ owner: string; repo: string; sha: string }> },
): Promise<Response> {
  const search = diagramSearch(request.url);
  const redirect = redirectToCanonical(request.url, search);
  if (redirect !== undefined) return redirect;
  const url = new URL(request.url);
  const theme = url.searchParams.get("theme");
  const oidcToken = request.headers.get(VERCEL_OIDC_HEADER);
  const deps = imageDepsFromEnv(url.origin, process.env, oidcToken);
  return handleImageRequest("diagram", await params, { theme }, deps);
}
