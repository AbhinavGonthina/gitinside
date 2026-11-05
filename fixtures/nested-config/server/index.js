const express = require("express");

const notes = express.Router();
notes.get("/notes", (_req, res) => res.json({ notes: [] }));
notes.post("/notes", (req, res) => res.status(201).json(req.body));
notes.delete("/notes/:id", (_req, res) => res.status(204).end());
notes.get("/reports/weekly", (_req, res) => res.json({ added: 0, removed: 0 }));

const app = express();
app.use(express.json());
app.use("/api", notes);
app.listen(4300);
