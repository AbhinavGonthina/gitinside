import { Router } from "express";
import { requireUser } from "../auth.js";
import { createArticle, deleteArticle, listArticles, toSlug } from "./service.js";

export const articles = Router();

articles.post("/articles", requireUser, async (req, res) => {
  const article = await createArticle(toSlug(req.body.title), req.body.body);
  res.status(201).json({ article });
});

articles.get("/articles", async (_req, res) => {
  const found = await listArticles();
  res.json({ articles: found.map((a) => ({ ...a, slug: toSlug(a.slug) })) });
});

articles.delete(
  "/articles/:slug",
  requireUser,
  asyncHandler(async (req, res) => {
    await deleteArticle(req.params.slug);
    res.sendStatus(204);
  }),
);

// Not a route's handler: a callback in top-level code has no caller, so this makes no edge.
const reserved = new Set<string>();
["new", "edit"].forEach((word) => reserved.add(toSlug(word)));

function asyncHandler<T extends (...args: never[]) => Promise<void>>(fn: T): T {
  return fn;
}
