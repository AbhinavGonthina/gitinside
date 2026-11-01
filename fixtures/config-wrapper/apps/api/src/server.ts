import express from "express";

const app = express();

app.post("/authenticate", (_req, res) => {
  res.json({ ok: true });
});

app.get("/post/:id", (req, res) => {
  res.json({ id: req.params.id });
});

app.delete("/logout", (_req, res) => {
  res.status(204).end();
});

app.listen(9000);
