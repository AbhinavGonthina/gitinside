import express from "express";

const app = express();

// An OpenAI-compatible endpoint served by the repo itself.
app.post("/v1/chat/completions", (_req, res) => {
  res.json({ choices: [] });
});

app.listen(11434);
