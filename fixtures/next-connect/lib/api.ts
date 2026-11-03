import nc from "next-connect";

function logRequest(req: { url?: string }, res: unknown, next: () => void) {
  console.log(req.url);
  next();
}

/** Every API route's router: a 405 for methods it doesn't register. */
export const apiHandler = () =>
  nc({
    onNoMatch: (req: unknown, res: { status: (code: number) => { end: () => void } }) =>
      res.status(405).end(),
  }).use(logRequest);
