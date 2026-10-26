export async function GET(): Promise<Response> {
  return Response.json([]);
}

export async function POST(request: Request): Promise<Response> {
  return Response.json(await request.json(), { status: 201 });
}
