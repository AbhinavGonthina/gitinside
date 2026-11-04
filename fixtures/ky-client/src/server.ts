import express from "express";

const app = express();
const notes = express.Router();

notes.get("/", (_req, res) => {
  res.json([]);
});

notes.get("/:noteId", (req, res) => {
  res.json({ id: req.params.noteId });
});

notes.post("/", (_req, res) => {
  res.status(201).end();
});

notes.put("/:noteId", (_req, res) => {
  res.status(204).end();
});

app.use("/api/notes", notes);
app.post("/api/session", (_req, res) => {
  res.json({ ok: true });
});
app.get("/api/v1/tags", (_req, res) => {
  res.json(["work"]);
});
app.get("/status", (_req, res) => {
  res.send("up");
});
app.listen(4000);
