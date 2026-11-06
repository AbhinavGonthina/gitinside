import express from "express";

const app = express();
const tracks = express.Router();
tracks.get("/", (_req, res) => res.json([]));
tracks.get("/:trackId", (req, res) => res.json({ id: req.params.trackId }));
app.use("/api/tracks", tracks);
app.get("/api/history", (_req, res) => res.json([]));
app.get("/api/playlists", (_req, res) => res.json([]));
app.get("/api/playlists/:owner", (req, res) => res.json({ owner: req.params.owner }));
app.listen(4200);
