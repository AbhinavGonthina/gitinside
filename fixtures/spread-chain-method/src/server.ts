import express, { Router } from "express";

// The watch history: one path, three methods, so only the method picks the route.
const history = Router();
history.get("/", (_req, res) => {
  res.json({ items: [], page: 1 });
});
history.post("/", (req, res) => {
  res.status(201).json({ added: req.body });
});
history.delete("/", (_req, res) => {
  res.sendStatus(204);
});

const server = express();
server.use(express.json());
server.use("/api/history", history);

export default server;
