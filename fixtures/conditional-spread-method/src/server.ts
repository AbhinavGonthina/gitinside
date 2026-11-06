import express from "express";

const app = express();
app.use(express.json());
const budgets = express.Router();
budgets.get("/", (_req, res) => res.json([]));
budgets.post("/", (req, res) => res.status(201).json(req.body));
budgets.put("/:budgetId", (req, res) => res.json({ id: req.params.budgetId }));
budgets.delete("/:budgetId", (_req, res) => res.status(204).end());
app.use("/api/budgets", budgets);
app.listen(4300);
