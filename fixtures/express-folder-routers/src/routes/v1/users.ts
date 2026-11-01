import { Router, type Request, type Response } from "express";

export function getUser(req: Request, res: Response) {
  res.json({ id: req.params.id });
}

const router = Router({ mergeParams: true });
router.get("/v1/users/:id", getUser);

export default router;
