import express from "express";
import { articles } from "./articles/routes.js";

const app = express();
app.use(express.json());
app.use("/api", articles);
app.listen(3000);
