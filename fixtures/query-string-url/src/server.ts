import express from "express";

const app = express();
app.post("/api/channels", (_req, res) => res.status(201).json({}));
app.delete("/api/channels/:channelId", (_req, res) => res.status(204).end());
app.patch("/api/members/:memberId", (_req, res) => res.json({}));
app.get("/api/messages", (_req, res) => res.json([]));
app.get("/api/servers", (_req, res) => res.json([]));

export default app;
