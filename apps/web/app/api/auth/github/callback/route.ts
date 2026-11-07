import { handleCallback } from "../../../../../lib/authRoute";
import { authDepsFromEnv } from "../../../../../lib/serverDeps";

/** `GET /api/auth/github/callback`: GitHub's return from sign-in (lib/authRoute.ts, ADR-0221). */
export const dynamic = "force-dynamic";

export function GET(request: Request): Promise<Response> {
  return handleCallback(request, authDepsFromEnv());
}
