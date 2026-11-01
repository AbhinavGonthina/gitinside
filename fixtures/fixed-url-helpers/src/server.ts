import express from "express";

const blog = express();
blog.use(express.json());

blog.get("/api/posts/:postId", (req, res) => {
  res.json({ id: req.params.postId, title: "Draft" });
});

blog.delete("/api/posts/:postId", (_req, res) => {
  res.sendStatus(204);
});

blog.get("/api/posts/:postId/comments", (req, res) => {
  res.json({ post: req.params.postId, page: Number(req.query.page ?? 1), items: [] });
});

blog.get("/api/authors", (_req, res) => {
  res.json([{ name: "Ada" }]);
});

blog.listen(4100);
