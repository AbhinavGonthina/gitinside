import { handleSignIn } from "../../../../lib/authRoute";
import { authDepsFromEnv } from "../../../../lib/serverDeps";

/** `GET /api/auth/github[?returnTo=/path]`: sign in with GitHub (lib/authRoute.ts, ADR-0221). */
export const dynamic = "force-dynamic";

export function GET(request: Request): Response {
  return handleSignIn(request, authDepsFromEnv());
}
