import express from "express";

const app = express();

// Which of these serves /v1/acme/items depends on registration order at runtime.
app.get("/v1/:org/items", (req, res) => {
  res.json({ org: req.params.org });
});

app.get("/v1/acme/:kind", (req, res) => {
  res.json({ kind: req.params.kind });
});

app.listen(3000);
