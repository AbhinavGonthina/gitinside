import { handleWebhook } from "../../../../lib/githubWebhook";
import { webhookDepsFromEnv } from "../../../../lib/serverDeps";

/** `POST /api/github/webhook`: the GitHub App's deliveries (lib/githubWebhook.ts, ADR-0224). */
export const dynamic = "force-dynamic";

export function POST(request: Request): Promise<Response> {
  return handleWebhook(request, webhookDepsFromEnv());
}
