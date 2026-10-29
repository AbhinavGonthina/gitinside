const express = require("express");
const { Schema } = require("./schema");

const app = express();
const body = new Schema();

app.post("/echo", (req, res) => {
  const parsed = body.safeParse(req.body);
  res.json(parsed.success ? { ok: true } : { error: String(parsed.error) });
});

module.exports = app;
