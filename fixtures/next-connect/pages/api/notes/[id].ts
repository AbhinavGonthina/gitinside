import { createRouter } from "next-connect";

type Req = { query: { id?: string } };
type Res = { json: (body: unknown) => void; end: () => void };

const router = createRouter<Req, Res>();

router
  .get(async (req, res) => {
    res.json(await fetch(`https://notes-archive.example.com/v2/notes/${req.query.id}`));
  })
  .patch(async (req, res) => res.json({ id: req.query.id }));

router.delete(async (req, res) => res.end());

export default router.handler({
  onError: (err: unknown, req: Req, res: Res) => res.end(),
});
