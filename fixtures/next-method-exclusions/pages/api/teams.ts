import type { NextApiRequest, NextApiResponse } from "next";

const teams = ["core", "docs"];

// A negated test whose block only answers refuses the other methods: GET alone.
export default function teamList(req: NextApiRequest, res: NextApiResponse) {
  if (!(req.method === "GET")) {
    return res.status(400).json({ message: "read only" });
  }
  return res.json(teams);
}
