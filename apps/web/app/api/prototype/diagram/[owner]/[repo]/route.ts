import { handlePrototypeImage } from "../../../../../../lib/prototypeImage";

/** `GET /api/prototype/diagram/:owner/:repo[?theme=]`: a prototype gallery card's crop (lib/prototypeImage.ts). */
export const dynamic = "force-dynamic";
/** As the README image's route: the biggest graph (anything-llm) is parsed and drawn here. */
export const maxDuration = 30;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ owner: string; repo: string }> },
): Promise<Response> {
  return handlePrototypeImage(await params, new URL(request.url).searchParams.get("theme"));
}
