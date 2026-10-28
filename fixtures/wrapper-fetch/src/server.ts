import express from "express";

const app = express();

app.get("/api/projects", (_req, res) => {
  res.json([]);
});

app.post("/api/projects", (_req, res) => {
  res.status(201).end();
});

app.listen(3000);
