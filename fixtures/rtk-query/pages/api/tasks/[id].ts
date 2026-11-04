import type { NextApiRequest, NextApiResponse } from "next";

const DONE = new Set<string>();

export default function task(req: NextApiRequest, res: NextApiResponse): void {
  const id = String(req.query.id);
  if (req.method === "GET") {
    res.status(200).json({ id, title: `Task ${id}`, done: DONE.has(id) });
    return;
  }
  if (req.method === "PATCH") {
    DONE.add(id);
    res.status(200).json({ id, title: `Task ${id}`, done: true });
    return;
  }
  res.setHeader("Allow", "GET, PATCH");
  res.status(405).end();
}
