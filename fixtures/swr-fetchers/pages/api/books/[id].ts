import type { NextApiRequest, NextApiResponse } from "next";

const CATALOG: Record<string, string> = { "1": "Dune", "2": "Emma" };

export default function book(req: NextApiRequest, res: NextApiResponse): void {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    res.status(405).end();
    return;
  }
  const id = String(req.query.id);
  const title = CATALOG[id];
  if (title === undefined) {
    res.status(404).json({ error: "no such book" });
    return;
  }
  res.status(200).json({ id, title });
}
