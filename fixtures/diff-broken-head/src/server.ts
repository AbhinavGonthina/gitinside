import express from "express";
import { createOrder, listOrders } from "./handlers.js";

const app = express();

app.get("/api/orders", listOrders);
app.put("/api/orders", createOrder);

app.listen(3000);
