import type { NextApiRequest, NextApiResponse } from "next";

const TASKS = [{ id: "1", title: "Write the docs", done: false }];

export default function tasks(req: NextApiRequest, res: NextApiResponse): void {
  if (req.method === "GET") {
    res.status(200).json(TASKS);
    return;
  }
  if (req.method === "POST") {
    const task = { id: String(TASKS.length + 1), title: String(req.body.title), done: false };
    TASKS.push(task);
    res.status(201).json(task);
    return;
  }
  res.setHeader("Allow", "GET, POST");
  res.status(405).end();
}
