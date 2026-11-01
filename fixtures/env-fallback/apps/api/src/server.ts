import express from "express";

const app = express();

app.post("/api/v1/auth/login", (_req, res) => {
  res.json({ token: "t" });
});

app.get("/api/v1/users/:id", (req, res) => {
  res.json({ id: req.params.id });
});

app.post("/api/v2/authenticate", (_req, res) => {
  res.json({ ok: true });
});

app.listen(4000);
