import { handleImageRequest } from "../../../../../lib/imageRoute";
import { imageDepsFromEnv } from "../../../../../lib/serverDeps";

/** `GET /api/badge/:owner/:repo.svg`: the README badge, with check-on-view (lib/imageRoute.ts, ADR-0072). */
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ owner: string; repo: string }> },
): Promise<Response> {
  return handleImageRequest("badge", await params, {}, imageDepsFromEnv());
}
