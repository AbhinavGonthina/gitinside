export interface Req {
  method?: string;
  headers: Record<string, string | undefined>;
  query: Record<string, string | undefined>;
}

export interface Res {
  status(code: number): Res;
  json(body: unknown): void;
  end(): void;
}

export type Handler = (req: Req, res: Res) => unknown;

/** Answers 401 without a session cookie, else runs the handler. */
export function withSession(handler: Handler): Handler {
  return (req, res) => {
    if (!req.headers.cookie) return res.status(401).end();
    return handler(req, res);
  };
}

/** Curried: the role first, then the handler it guards. */
export const withRole =
  (role: string) =>
  (handler: Handler): Handler =>
  (req, res) => {
    if (req.headers["x-role"] !== role) return res.status(403).end();
    return handler(req, res);
  };
