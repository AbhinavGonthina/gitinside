import { Router } from "express";

export const orders = Router();

orders.get("/:id", (req, res) => {
  res.json({ id: req.params.id });
});
orders.route("/").get((_req, res) => res.json([])).post((_req, res) => res.status(201).end());
