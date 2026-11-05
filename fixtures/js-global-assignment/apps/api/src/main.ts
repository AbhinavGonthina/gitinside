import express from "express";

const server = express();

server.get("/api/health/ready", (_req, res) => {
  res.json({ ready: true });
});

server.post("/api/bookings/:slug", (req, res) => {
  res.status(201).json({ slug: req.params.slug });
});

server.listen(8080);
