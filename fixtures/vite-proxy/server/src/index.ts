import express from "express";

const app = express();
app.use(express.json());

app.get("/users", (_req, res) => {
  res.json([]);
});
app.get("/users/:id", (req, res) => {
  res.json({ id: req.params.id });
});
app.post("/auth/login", (req, res) => {
  res.json({ email: req.body.email });
});
app.get("/stats", (_req, res) => {
  res.json({ users: 0 });
});
// Nothing reaches this through the client's proxy, which strips `/api`.
app.get("/api/users", (_req, res) => {
  res.json({ legacy: true });
});

app.listen(5000);
