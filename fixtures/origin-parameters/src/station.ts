import express from "express";

const station = express();

station.get("/api/health", (_req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

station.get("/api/readings", (_req, res) => {
  res.json([{ sensor: "roof", celsius: 18.5 }]);
});

station.listen(4400);
