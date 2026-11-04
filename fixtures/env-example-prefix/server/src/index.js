import express from "express";

const auth = express.Router();
auth.post("/login", (req, res) => {
  res.json({ user: req.body });
});

const blog = express.Router();
blog.get("/:blogId", (req, res) => {
  res.json({ id: req.params.blogId });
});

const app = express();
app.use(express.json());
app.use("/api/auth", auth);
app.use("/api/blog", blog);
app.get("/api/stats", (_req, res) => {
  res.json({ posts: 0 });
});
app.post("/api/checkout", (_req, res) => {
  res.sendStatus(201);
});

app.listen(5000);
