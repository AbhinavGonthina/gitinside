import type { NextApiRequest, NextApiResponse } from "next";

export default function reviews(req: NextApiRequest, res: NextApiResponse): void {
  const stars = req.query.id === "1" ? 5 : 3;
  res.status(200).json([{ stars, text: "Worth a reread." }]);
}
