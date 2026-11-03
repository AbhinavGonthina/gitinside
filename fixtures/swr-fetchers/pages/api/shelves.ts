import type { NextApiRequest, NextApiResponse } from "next";

export default function shelves(_req: NextApiRequest, res: NextApiResponse): void {
  res.status(200).json([{ name: "To read", count: 3 }]);
}
