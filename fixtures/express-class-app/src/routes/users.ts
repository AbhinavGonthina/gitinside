import { Router } from "express";

export function getUser(req: { params: { id: string } }, res: { json(body: unknown): void }) {
  res.json({ id: req.params.id });
}

const router = Router();
router.get("/users/:id", getUser);

export default router;
