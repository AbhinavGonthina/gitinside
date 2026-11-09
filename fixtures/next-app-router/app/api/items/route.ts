export async function GET(): Promise<Response> {
  return Response.json([], { headers: { "x-font-bytes": String((await font).byteLength) } });
}

export async function POST(request: Request): Promise<Response> {
  return Response.json(await request.json(), { status: 201 });
}

// A file bundled with the route (`@vercel/og`'s font form): read, not requested, so no edge.
const font = fetch(new URL("../../../assets/Inter-Regular.ttf", import.meta.url)).then((r) =>
  r.arrayBuffer(),
);
