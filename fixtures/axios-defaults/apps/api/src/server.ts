import express from "express";

const app = express();

app.get("/api/v1/users/:id", (req, res) => {
  res.json({ id: req.params.id });
});

app.get("/api/admin/users", (_req, res) => {
  res.json([]);
});

app.post("/api/admin/users/:id/ban", (_req, res) => {
  res.status(204).end();
});

app.post("/api/v1/session/refresh", (_req, res) => {
  res.status(204).end();
});

app.listen(9000);
