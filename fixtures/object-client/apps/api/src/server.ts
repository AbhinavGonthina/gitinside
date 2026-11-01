import express from "express";

const app = express();

app.get("/api/v1/accounts", (_req, res) => {
  res.json([]);
});

app.post("/api/v1/accounts", (_req, res) => {
  res.status(201).json({ id: "1" });
});

app.patch("/api/v1/accounts/:id", (req, res) => {
  res.json({ id: req.params.id });
});

app.delete("/api/v1/accounts/:id", (_req, res) => {
  res.status(204).end();
});

app.listen(4000);
