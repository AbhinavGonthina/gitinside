import { handleSignOut } from "../../../../lib/authRoute";
import { authDepsFromEnv } from "../../../../lib/serverDeps";

/** `POST /api/auth/signout`: end this browser's session (lib/authRoute.ts, ADR-0221). */
export const dynamic = "force-dynamic";

export function POST(request: Request): Promise<Response> {
  return handleSignOut(request, authDepsFromEnv());
}
