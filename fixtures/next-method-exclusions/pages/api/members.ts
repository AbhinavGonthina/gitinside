import type { NextApiRequest, NextApiResponse } from "next";
import { membersOf } from "../../lib/members";

// Every method but POST and DELETE runs the block; those two get no answer at all.
export default async function members(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST" && req.method !== "DELETE") {
    try {
      const team = String(req.query.team ?? "");
      return res.status(200).json(await membersOf(team));
    } catch (error) {
      console.error(error);
      return res.status(500).json({ message: "failed" });
    }
  }
}
