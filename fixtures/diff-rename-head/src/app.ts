import express from "express";
import { orders } from "./orders/routes.js";

export const app = express();
app.use("/api/orders", orders);
