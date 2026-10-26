import type { Request, Response } from "express";

const users: string[] = [];

export function listUsers(_req: Request, res: Response): void {
  res.json(users);
}

export function createUser(req: Request, res: Response): void {
  users.push(String(req.body.name));
  res.status(201).json(users);
}
