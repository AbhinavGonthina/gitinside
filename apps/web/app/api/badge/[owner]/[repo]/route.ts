import { redirectToCanonical } from "../../../../../lib/canonical";
import { handleImageRequest } from "../../../../../lib/imageRoute";
import { imageDepsFromEnv, VERCEL_OIDC_HEADER } from "../../../../../lib/serverDeps";

/** `GET /api/badge/:owner/:repo.svg`: the README badge, with check-on-view (lib/imageRoute.ts, ADR-0072). */
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ owner: string; repo: string }> },
): Promise<Response> {
  const origin = new URL(request.url).origin;
  const oidcToken = request.headers.get(VERCEL_OIDC_HEADER);
  return (
    redirectToCanonical(request.url, "") ??
    handleImageRequest("badge", await params, {}, imageDepsFromEnv(origin, process.env, oidcToken))
  );
}
