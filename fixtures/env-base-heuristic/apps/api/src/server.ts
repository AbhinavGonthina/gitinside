import express from "express";

const app = express();

app.get("/users/me", (_req, res) => {
  res.json({ me: true });
});

app.get("/users/:id", (req, res) => {
  res.json({ id: req.params.id });
});

app.listen(4000);
