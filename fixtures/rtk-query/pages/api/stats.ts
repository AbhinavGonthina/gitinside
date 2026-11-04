import type { NextApiRequest, NextApiResponse } from "next";

export default function stats(req: NextApiRequest, res: NextApiResponse): void {
  const range = typeof req.query.range === "string" ? req.query.range : "week";
  res.status(200).json({ range, open: 1, done: 0 });
}
