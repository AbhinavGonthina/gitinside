type Res = { json: (body: unknown) => void; status: (code: number) => Res };

export async function listNotes(req: unknown, res: Res) {
  res.json([]);
}

export async function createNote(req: { body: unknown }, res: Res) {
  res.status(201).json(req.body);
}
