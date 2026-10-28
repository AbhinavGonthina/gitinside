import { handleJobRequest } from "../../../../lib/jobRoute";
import { jobDepsFromEnv } from "../../../../lib/serverDeps";

/** `GET /api/jobs/:id`: the job's status in the progress page's words (lib/jobRoute.ts, ADR-0067). */
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  return handleJobRequest(id, jobDepsFromEnv());
}
