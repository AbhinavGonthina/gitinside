import express, { Router } from "express";

// Paths serve a read and a write, mounted per resource.
const agents = Router();
agents.get("/:id", (_req, res) => res.json({ agent: true }));
agents.delete("/:id", (_req, res) => res.sendStatus(204));

const messages = Router();
messages.get("/", (_req, res) => res.json({ items: [] }));
messages.post("/", (_req, res) => res.status(201).send());

const socket = Router();
socket.post("/messages", (_req, res) => res.status(201).send());
socket.patch("/messages/:messageId", (req, res) => res.json({ id: req.params.messageId }));
socket.delete("/messages/:messageId", (_req, res) => res.sendStatus(204));

const reports = Router();
reports.get("/:id", (req, res) => res.json({ report: req.params.id }));
reports.delete("/:id", (_req, res) => res.sendStatus(204));

export const server = express()
  .use("/api/agents", agents)
  .use("/api/messages", messages)
  .use("/api/socket", socket)
  .use("/api/reports", reports)
  .post("/api/notes/archive", (_req, res) => res.status(201).send());
