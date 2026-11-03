import { apiHandler } from "../../../lib/api";
import { createNote, listNotes } from "../../../lib/notes";

const handler = apiHandler();

handler.get(listNotes).post(createNote);

export default handler;
