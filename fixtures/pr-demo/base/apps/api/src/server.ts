import express from "express";
import { orders } from "./routes/orders";

const app = express();
app.use(express.json());
app.use("/api/orders", orders);
app.listen(4000);
