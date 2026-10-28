import express from "express";

const app = express();
const orders = express.Router();

orders.get("/:id", (req, res) => {
  res.json({ id: req.params.id });
});

orders.post("/", (_req, res) => {
  res.status(201).end();
});

app.use("/api/orders", orders);
app.listen(3000);
