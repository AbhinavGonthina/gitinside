import { handleTokenRequest } from "../../../../lib/installationTokenRoute";
import { tokenRouteDepsFromEnv } from "../../../../lib/serverDeps";

// Each request is the worker's, signed, and answered with a fresh token: never cached.
export const dynamic = "force-dynamic";

export function POST(request: Request): Promise<Response> {
  return handleTokenRequest(request, tokenRouteDepsFromEnv());
}
