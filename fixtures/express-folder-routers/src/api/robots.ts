import { Router, type Request, type Response } from "express";

const robots = new Map<string, { name: string; schedule?: string }>();

export function readRobot(req: Request, res: Response) {
  const robot = robots.get(req.params.id);
  if (!robot) return res.status(404).json({ error: "no such robot" });
  return res.json(robot);
}

const router = Router();
router.get("/robots/:id", readRobot);

export default router;
