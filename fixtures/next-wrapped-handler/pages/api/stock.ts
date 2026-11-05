import { withRole, withSession } from "../../lib/guards";

const guarded = withSession(
  withRole("staff")(async (req, res) => {
    if (req.method !== "PATCH") return res.status(405).end();
    return res.json({ ok: true });
  }),
);

export default guarded;
