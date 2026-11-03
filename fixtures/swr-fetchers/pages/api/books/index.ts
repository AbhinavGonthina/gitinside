import type { NextApiRequest, NextApiResponse } from "next";

export default function books(req: NextApiRequest, res: NextApiResponse): void {
  if (req.method === "GET") {
    res.status(200).json([]);
    return;
  }
  if (req.method === "POST") {
    res.status(201).json(req.body);
    return;
  }
  res.status(405).end();
}
