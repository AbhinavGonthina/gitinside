import express from "express";

const app = express();

app.post("/api/workspace/:slug/stream-chat", (_req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.write("data: {}\n\n");
  res.end();
});

app.get("/api/workspace/:slug/embed-progress", (_req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.end();
});

app.listen(3001);
