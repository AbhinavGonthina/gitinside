import express from "express";
import { orders } from "./routes/orders.js";

export const app = express();
app.use("/api/orders", orders);
