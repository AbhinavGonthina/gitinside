import { handleAnalyzeRequest } from "../../../lib/analyzeRoute";
import { analyzeDepsFromEnv } from "../../../lib/serverDeps";

/**
 * `POST /api/analyze` `{ url }`: resolve the repo's latest commit, then return its cached
 * diagram or a queued job (lib/analyze.ts, ADR-0066). Other methods get Next.js's 405.
 */
export const dynamic = "force-dynamic";

export function POST(request: Request): Promise<Response> {
  return handleAnalyzeRequest(request, analyzeDepsFromEnv());
}
