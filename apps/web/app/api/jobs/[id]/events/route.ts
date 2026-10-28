import { handleJobEvents } from "../../../../../lib/jobRoute";
import { jobDepsFromEnv } from "../../../../../lib/serverDeps";

/**
 * `GET /api/jobs/:id/events`: the job's status as server-sent events, ending after 25 s or a
 * final state; the browser reconnects by itself (lib/jobRoute.ts, ADR-0067).
 */
export const dynamic = "force-dynamic";
/** Above the stream's 25 s lifetime, so the platform never cuts one short. */
export const maxDuration = 30;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  return handleJobEvents(id, request.signal, jobDepsFromEnv());
}
