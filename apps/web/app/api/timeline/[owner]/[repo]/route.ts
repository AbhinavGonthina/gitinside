import { timelineDepsFromEnv, VERCEL_OIDC_HEADER } from "../../../../../lib/serverDeps";
import { handleTimelineRequest } from "../../../../../lib/timeline";

/**
 * `GET /api/timeline/:owner/:repo`: the default branch's last commits with their counts, queuing
 * a few not yet analyzed (lib/timeline.ts, M11.4b, ADR-0302).
 */
export const dynamic = "force-dynamic";
/** Two GitHub calls and up to two queued tasks, each with its own 5 s timeout. */
export const maxDuration = 30;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ owner: string; repo: string }> },
): Promise<Response> {
  const oidcToken = request.headers.get(VERCEL_OIDC_HEADER);
  return handleTimelineRequest(await params, timelineDepsFromEnv(process.env, oidcToken));
}
