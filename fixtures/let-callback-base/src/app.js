import express from "express";

const app = express();
const tasks = express.Router();
tasks.get("/", (_req, res) => res.json([]));
tasks.post("/", (_req, res) => res.status(201).json({}));
tasks.get("/:taskId", (req, res) => res.json({ id: req.params.taskId }));
app.use("/api/v1/tasks", tasks);
app.get("/api/v1/health", (_req, res) => res.json({ ok: true }));
app.get("/api/v1/version", (_req, res) => res.json({ version: 1 }));

export default app;
