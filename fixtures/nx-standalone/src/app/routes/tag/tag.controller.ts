import { Router } from "express";
import { getTags } from "./tag.service";

const router = Router();

router.get("/tags", async (_req, res) => {
  res.json({ tags: await getTags() });
});

export default router;
