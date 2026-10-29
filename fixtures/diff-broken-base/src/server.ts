import express from "express";
import { createOrder, deleteOrder, health, listOrders } from "./handlers.js";

const app = express();

app.get("/api/orders", listOrders);
app.post("/api/orders", createOrder);
app.delete("/api/orders/:id", deleteOrder);
app.get("/api/health", health);

app.listen(3000);
