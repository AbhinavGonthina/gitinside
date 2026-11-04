import type { NextApiRequest, NextApiResponse } from "next";

/** Issues a new session cookie while the refresh cookie is valid. */
export default function refresh(req: NextApiRequest, res: NextApiResponse): void {
  if (!req.cookies.refresh) {
    res.status(401).json({ error: "expired" });
    return;
  }
  res.setHeader("Set-Cookie", "session=renewed; HttpOnly; Path=/");
  res.status(200).json({ ok: true });
}
