import express from "express";

const app = express();
const posts = express.Router();

posts.get("/", (_req, res) => {
  res.json([]);
});

posts.get("/:postId", (req, res) => {
  res.json({ id: req.params.postId });
});

app.use("/api/posts", posts);
app.get("/api/stats", (_req, res) => {
  res.json({ total: 0 });
});
app.get("/api/users/:userId/todos", (req, res) => {
  res.json({ user: req.params.userId, todos: [] });
});
app.listen(4000);
