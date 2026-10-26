import type { NextApiRequest, NextApiResponse } from "next";

export default function handler(req: NextApiRequest, res: NextApiResponse): void {
  if (req.method !== "GET") {
    res.status(405).end();
    return;
  }
  res.status(200).json({ hello: "world" });
}
