import { redirectToCanonical } from "../../../../../../../lib/canonical";
import { authDepsFromEnv } from "../../../../../../../lib/serverDeps";
import { handleSourceRequest } from "../../../../../../../lib/sourceRoute";

/** `GET /api/source/:owner/:repo/:sha/*path`: one file of a private repo, for its code preview (lib/sourceRoute.ts, ADR-0237). */
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ owner: string; repo: string; sha: string; path: string[] }> },
): Promise<Response> {
  return (
    redirectToCanonical(request.url, "") ??
    handleSourceRequest(await params, authDepsFromEnv(), request.headers.get("cookie"))
  );
}
