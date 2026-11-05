import express from "express";

const app = express();
app.use(express.json());

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/api/orders", (req, res) => {
  res.status(201).json({ id: 1, ...req.body });
});

app.listen(4000);
