import express from "express";

const shelves = express.Router();

shelves.get("/:shelfId", (req, res) => {
  res.json({ id: req.params.shelfId, name: "Reading list" });
});

shelves.get("/:shelfId/books", (_req, res) => {
  res.json([]);
});

shelves.post("/:shelfId/books", (req, res) => {
  res.status(201).json({ title: req.body.title });
});

const app = express();
app.use(express.json());
app.use("/api/shelves", shelves);

app.get("/api/loans/:loanId", (req, res) => {
  res.json({ id: req.params.loanId, due: "2026-12-01" });
});

app.delete("/api/loans/:loanId", (_req, res) => {
  res.status(204).end();
});

app.get("/api/catalog/search", (req, res) => {
  res.json({ query: req.query.q, hits: [] });
});

app.listen(4200);
