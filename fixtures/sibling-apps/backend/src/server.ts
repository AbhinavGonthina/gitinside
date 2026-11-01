import express from "express";

const app = express();
const posts = express.Router();

posts.get("/:id", (req, res) => {
  res.json({ id: req.params.id });
});

posts.post("/", (_req, res) => {
  res.status(201).end();
});

app.use("/api/posts", posts);
app.listen(5000);
