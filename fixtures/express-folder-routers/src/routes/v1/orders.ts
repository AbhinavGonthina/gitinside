import { Router, type Request, type Response } from "express";
import { total } from "./helpers";

export function createOrder(req: Request, res: Response) {
  res.status(201).json({ total: total(req.body.items) });
}

const router = Router({ mergeParams: true });
router.post("/v1/orders", createOrder);

export default router;
