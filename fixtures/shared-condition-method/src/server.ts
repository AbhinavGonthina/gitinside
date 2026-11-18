import express from "express";

// Each path serves two methods, so a request whose method isn't read is ambiguous on it.
const app = express();
app.post("/api/agents", (_req, res) => res.status(201).json({}));
app.get("/api/agents", (_req, res) => res.json([]));
app.put("/api/agents/:id", (_req, res) => res.json({}));
app.delete("/api/agents/:id", (_req, res) => res.status(204).end());
app.post("/api/upstreams/:upstreamId/keys", (_req, res) => res.status(201).json({}));
app.get("/api/upstreams/:upstreamId/keys", (_req, res) => res.json([]));
app.put("/api/upstreams/:upstreamId/keys/:id", (_req, res) => res.json({}));
app.delete("/api/upstreams/:upstreamId/keys/:id", (_req, res) => res.status(204).end());
app.post("/api/notes", (_req, res) => res.status(201).json({}));
app.get("/api/notes", (_req, res) => res.json([]));
app.put("/api/notes/:id", (_req, res) => res.json({}));
app.delete("/api/notes/:id", (_req, res) => res.status(204).end());
app.post("/api/projects", (_req, res) => res.status(201).json({}));
app.get("/api/projects", (_req, res) => res.json([]));
app.put("/api/projects/:id", (_req, res) => res.json({}));
app.delete("/api/projects/:id", (_req, res) => res.status(204).end());
app.post("/api/drafts", (_req, res) => res.status(201).json({}));
app.get("/api/drafts", (_req, res) => res.json([]));
app.put("/api/drafts/:id", (_req, res) => res.json({}));
app.delete("/api/drafts/:id", (_req, res) => res.status(204).end());

export default app;
