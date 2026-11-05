import express from "express";

const app = express();
app.use(express.json());

app.get("/api/tokens", (_req, res) => {
  res.json({ token: null });
});

app.put("/api/tokens", (req, res) => {
  res.json({ token: req.body.token });
});

app.delete("/api/tokens", (_req, res) => {
  res.status(204).end();
});

app.get("/api/profile", (_req, res) => {
  res.json({ name: "ada" });
});

app.post("/api/avatar", (_req, res) => {
  res.status(201).end();
});

app.listen(4100);
