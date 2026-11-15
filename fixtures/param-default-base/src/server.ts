import express from "express";

const app = express();
const notes = express.Router();
notes.get("/", (_req, res) => res.json([]));
notes.post("/", (_req, res) => res.status(201).json({}));
app.use("/api/notes", notes);
app.get("/api/billing/plans", (_req, res) => res.json([]));
app.get("/api/users", (_req, res) => res.json([]));
app.get("/api/teams", (_req, res) => res.json([]));

export default app;
