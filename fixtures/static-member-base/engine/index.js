const express = require("express");

const app = express();
app.use(express.json());

app.get("/api/v1/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/api/v1/load", (req, res) => {
  res.json({ loaded: req.body.model });
});

app.listen(Number(process.env.ENGINE_PORT || 8000), "127.0.0.1");
