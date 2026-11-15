import express from "express";

const app = express();
app.post("/api/admin/users/:id/suspend", (_req, res) => res.status(201).json({}));
app.delete("/api/admin/users/:id/suspend", (_req, res) => res.status(204).end());
app.patch("/api/blog-comments/:id", (_req, res) => res.json({}));
app.delete("/api/blog-comments/:id", (_req, res) => res.status(204).end());
app.put("/api/posts/:id/archive", (_req, res) => res.json({}));
app.post("/api/posts/:id/vote", (_req, res) => res.status(201).json({}));
app.delete("/api/posts/:id/vote", (_req, res) => res.status(204).end());
app.post("/api/drafts", (_req, res) => res.status(201).json({}));
app.put("/api/drafts/:id", (_req, res) => res.json({}));

export default app;
