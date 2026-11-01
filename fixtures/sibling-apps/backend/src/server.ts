import express from "express";
import posts from "./routes/posts";

const server = express();
server.use(express.json());
server.use("/api/posts", posts);
server.listen(5000);
