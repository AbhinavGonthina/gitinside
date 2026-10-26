import express from "express";
import { greet } from "@mono/shared";

const app = express();
app.get("/greet", (_req, res) => {
  res.send(greet("world"));
});
