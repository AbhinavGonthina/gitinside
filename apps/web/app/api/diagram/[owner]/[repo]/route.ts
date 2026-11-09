import { diagramSearch, redirectToCanonical } from "../../../../../lib/canonical";
import { handleImageRequest } from "../../../../../lib/imageRoute";
import { imageDepsFromEnv, VERCEL_OIDC_HEADER } from "../../../../../lib/serverDeps";

/** `GET /api/diagram/:owner/:repo.svg[?theme=dark|light]`: the live README image (lib/imageRoute.ts, ADR-0072). */
export const dynamic = "force-dynamic";
/** Past the second CDN purge check-on-view schedules when it hides a repo (`PURGE_AGAIN_MS`, F14). */
export const maxDuration = 30;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ owner: string; repo: string }> },
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
