import express from "express";

const journal = express();
journal.use(express.json());

journal.get("/api/entries/featured", (_req, res) => {
  res.json([{ id: "e1", featured: true }]);
});

journal.get("/api/entries/topics/:topic", (req, res) => {
  res.json({ topic: req.params.topic, entries: [] });
});

journal.get("/api/entries/:entryId", (req, res) => {
  res.json({ id: req.params.entryId, body: "Notes" });
});

journal.delete("/api/entries/:entryId", (_req, res) => {
  res.sendStatus(204);
});

journal.delete("/api/entries/moderation/:entryId", (_req, res) => {
  res.sendStatus(202);
});

journal.get("/api/archive", (req, res) => {
  res.json({ page: Number(req.query.page ?? 1), entries: [] });
});

journal.get("/api/drafts", (_req, res) => {
  res.json([]);
});

journal.listen(4200);
