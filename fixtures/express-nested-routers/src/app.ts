import express from "express";
import { api } from "./api.js";

export const app = express();
app.use("/api", api);
