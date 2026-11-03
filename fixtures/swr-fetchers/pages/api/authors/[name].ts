import type { NextApiRequest, NextApiResponse } from "next";

const BORN: Record<string, number> = { herbert: 1920, austen: 1775 };

export default function author(req: NextApiRequest, res: NextApiResponse): void {
  const name = String(req.query.name).toLowerCase();
  const born = BORN[name];
  if (born === undefined) return void res.status(404).json({ error: "unknown author" });
  res.json({ name, born });
}
