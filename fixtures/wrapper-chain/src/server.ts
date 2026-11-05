import express, { Router } from "express";

/** The board API, mounted under `/api` below. */
const boards = Router();
boards.get("/boards", (_req, res) => res.json({ boards: [], total: 0 }));
boards.get("/boards/:id", (req, res) => res.json({ id: req.params.id, columns: [] }));
boards.post("/boards", (req, res) => res.status(201).json(req.body));
boards.get("/stats", (_req, res) => res.json({ boards: 0, cards: 0 }));
boards.get("/feed", (_req, res) => res.json({ events: [] }));

const server = express();
server.use(express.json());
server.use("/api", boards);
server.listen(4100);
