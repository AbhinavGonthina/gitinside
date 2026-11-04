import type { NextApiRequest, NextApiResponse } from "next";

export default function session(req: NextApiRequest, res: NextApiResponse): void {
  if (req.method === "GET") {
    res.status(200).json({ name: "Ada" });
    return;
  }
  if (req.method === "DELETE") {
    res.setHeader("Set-Cookie", "session=; Max-Age=0");
    res.status(204).end();
    return;
  }
  res.setHeader("Allow", "GET, DELETE");
  res.status(405).end();
}
