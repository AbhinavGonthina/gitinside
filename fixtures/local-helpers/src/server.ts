import express from "express";

const app = express();
const notes = express.Router();
notes.get("/", (_req, res) => res.json([]));
notes.post("/", (_req, res) => res.status(201).end());
notes.put("/:noteId/pin", (_req, res) => res.end());
notes.delete("/:noteId", (_req, res) => res.end());
app.use("/api/notes", notes);
app.get("/api/status", (_req, res) => res.json({ ok: true }));
app.listen(4100);
