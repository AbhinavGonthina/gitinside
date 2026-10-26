import express from "express";
import { listUsers, createUser } from "./users.js";

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.send("ok");
});
app.get("/users", listUsers);
app.post("/users", createUser);
app.listen(3000);
