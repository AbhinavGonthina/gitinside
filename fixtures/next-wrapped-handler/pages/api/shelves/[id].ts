import { withRole, type Req, type Res } from "../../../lib/guards";

function shelf(req: Req, res: Res) {
  switch (req.method) {
    case "PUT":
      return res.json({ id: req.query.id });
    case "DELETE":
      return res.status(204).end();
    default:
      return res.status(405).end();
  }
}

export default withRole("admin")(shelf);
