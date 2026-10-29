import { handleImageRequest } from "../../../../../lib/imageRoute";
import { imageDepsFromEnv } from "../../../../../lib/serverDeps";

/** `GET /api/diagram/:owner/:repo.svg[?theme=dark|light]`: the live README image (lib/imageRoute.ts, ADR-0072). */
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ owner: string; repo: string }> },
): Promise<Response> {
  const theme = new URL(request.url).searchParams.get("theme");
  return handleImageRequest("diagram", await params, { theme }, imageDepsFromEnv());
}
