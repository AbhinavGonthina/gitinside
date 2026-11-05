export function requireUser(
  req: { headers: Record<string, string | undefined> },
  res: { sendStatus(code: number): void },
  next: () => void,
): void {
  if (req.headers.authorization === undefined) res.sendStatus(401);
  else next();
}
