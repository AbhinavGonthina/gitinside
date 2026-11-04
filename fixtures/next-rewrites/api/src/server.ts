import express from "express";

const app = express();

app.get("/users/:id", (req, res) => {
  res.json({ id: req.params.id });
});
app.get("/orders", (_req, res) => {
  res.json([]);
});
// Nothing reaches this: `/backend/users/…` is sent on as `/users/…`.
app.get("/backend/users/:id", (_req, res) => {
  res.json({ legacy: true });
});

app.listen(4000);
