import express from "express";

const app = express();
const users = express.Router();

users.get("/", (_req, res) => {
  res.json([]);
});

users.get("/:id", (req, res) => {
  res.json({ id: req.params.id });
});

users.post("/", (_req, res) => {
  res.status(201).end();
});

users.delete("/:id", (_req, res) => {
  res.status(204).end();
});

app.use("/api/users", users);
app.post("/api/auth/login", (_req, res) => {
  res.json({ token: "t" });
});
app.get("/api/v2/stats", (_req, res) => {
  res.json({ count: 0 });
});
app.get("/api/health", (_req, res) => {
  res.send("ok");
});
app.listen(3000);
