const express = require("express");

const app = express();
app.use(express.json());

app.get("/accepts", (_req, res) => {
  res.json({ types: [".pdf", ".txt"] });
});

app.post("/process", (req, res) => {
  res.json({ success: true, filename: req.body.filename });
});

app.listen(Number(process.env.COLLECTOR_PORT || 8888));
