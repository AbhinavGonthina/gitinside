import { Router } from "express";

const posts = Router();

posts.get("/:id", async (req, res) => {
  const post = { id: req.params.id, title: "Draft" };
  res.json(post);
});

posts.post("/", async (req, res) => {
  const { title } = req.body as { title?: string };
  if (!title) {
    res.status(400).json({ error: "title required" });
    return;
  }
  res.status(201).json({ title });
});

export default posts;
