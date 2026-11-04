import type { NextApiRequest, NextApiResponse } from "next";
import { invite, invitesFor } from "../../lib/members";

// Methods other than POST list the invites; POST falls through to the code after the block.
export default async function invites(req: NextApiRequest, res: NextApiResponse) {
  const team = String(req.query.team ?? "");
  if (!["POST"].includes(req.method ?? "")) {
    return res.json(await invitesFor(team));
  }
  return res.status(201).json(await invite(team, String(req.body.id)));
}
