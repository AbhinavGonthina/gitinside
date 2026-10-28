import express from "express";

const app = express();

app.get("/api/users", (_req, res) => {
  res.json([]);
});

app.get("/api/users/:id", (req, res) => {
  res.json({ id: req.params.id });
});

app.listen(3000);
