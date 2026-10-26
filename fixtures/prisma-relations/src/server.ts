import express from "express";
import { prisma } from "./db.js";

const app = express();

app.get("/posts", async (_req, res) => {
  res.json(await prisma.post.findMany({ select: { id: true, title: true } }));
});

app.post("/users", async (req, res) => {
  res.json(await prisma.user.create({ data: { email: String(req.body.email) } }));
});

app.get("/raw", async (_req, res) => {
  res.json(await prisma.$queryRaw`SELECT 1`);
});
