import express from "express";

const library = express();

library.get("/api/reading-now", (_req, res) => {
  res.json({ title: "Middlemarch", page: 212 });
});

library.get("/api/shelves/:shelfId", (req, res) => {
  res.json({ shelf: req.params.shelfId, books: [] });
});

library.get("/api/books", (_req, res) => {
  res.json([{ isbn: "9780141439549" }]);
});

library.get("/api/v2/books", (_req, res) => {
  res.json({ items: [{ isbn: "9780141439549" }], next: null });
});

library.listen(4300);
