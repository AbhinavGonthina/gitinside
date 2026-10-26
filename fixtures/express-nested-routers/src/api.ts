import { Router } from "express";
import { orders } from "./orders.js";

export const api = Router();
api.use("/orders", orders);
api.get("/ping", (_req, res) => {
  res.send("pong");
});
