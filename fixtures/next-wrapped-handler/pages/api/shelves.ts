import { withSession, type Req, type Res } from "../../lib/guards";

async function shelves(req: Req, res: Res) {
  if (req.method === "GET") return res.json([]);
  if (req.method === "POST") return res.status(201).json({});
  res.status(405).end();
}

export default withSession(shelves);
