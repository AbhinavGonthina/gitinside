import { Router } from "express";
import { createOrder, listOrders } from "../orders/handlers";

export const orders = Router();

orders.get("/", listOrders);
orders.post("/", createOrder);
